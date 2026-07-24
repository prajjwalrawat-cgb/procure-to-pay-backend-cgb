import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type PoStatus } from '@procureflow/db';
import {
  computeDocTax,
  taxKindLabel,
  type DeliveryAddress,
  type PaymentTerms,
  type PoDetailResponse,
  type PoLineView,
  type PoListItem,
  type PoListQuery,
  type PoListResponse,
} from '@procureflow/shared';
import Decimal from 'decimal.js';

import { ApprovalRoutingService } from '../approvals/approval-routing.service';
import { PrismaService } from '../prisma/prisma.service';

type PoWithRels = Prisma.PurchaseOrderGetPayload<{
  include: {
    vendor: true;
    lines: true;
    requisition: { include: { costCenter: true } };
  };
}>;

const OPEN: PoStatus[] = [
  'DRAFT',
  'AWAITING_APPROVAL',
  'APPROVED',
  'ISSUED',
  'ACKNOWLEDGED',
  'ON_HOLD',
];

/** Read-side for purchase orders: list (tabbed + filtered) and detail. */
@Injectable()
export class PurchaseOrderQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly routing: ApprovalRoutingService,
  ) {}

  async list(query: PoListQuery): Promise<PoListResponse> {
    const where: Prisma.PurchaseOrderWhereInput = {};
    switch (query.tab) {
      case 'partial':
        where.status = 'PARTIALLY_RECEIVED';
        break;
      case 'awaiting_grn':
        where.status = { in: ['ISSUED', 'ACKNOWLEDGED'] };
        break;
      case 'closed':
        where.status = { in: ['RECEIVED', 'INVOICED', 'CLOSED'] };
        break;
      case 'cancelled':
        where.status = 'CANCELLED';
        break;
      default:
        where.status = { in: OPEN };
    }
    if (query.status)
      where.status = query.status as Prisma.PurchaseOrderWhereInput['status'];
    if (query.vendorId) where.vendorId = query.vendorId;
    if (query.poType) where.poType = query.poType;

    const rows = await this.prisma.client.purchaseOrder.findMany({
      where,
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        vendor: true,
        lines: true,
        requisition: { include: { costCenter: true } },
      },
    });
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const counts = await this.counts();

    return {
      items: page.map((po) => this.toListItem(po)),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      totalEstimate: await this.prisma.client.purchaseOrder.count({ where }),
      counts,
    };
  }

  async detail(id: string, userId: string): Promise<PoDetailResponse> {
    const po = await this.prisma.client.purchaseOrder.findUnique({
      where: { id },
      include: {
        vendor: true,
        lines: { orderBy: { lineNo: 'asc' } },
        requisition: true,
        grns: true,
        invoices: true,
        comments: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!po) throw new NotFoundException('Purchase order not found');

    const plant = await this.prisma.client.plant.findFirst({
      where: { tenantId: po.tenantId },
    });
    const tax = computeDocTax(
      po.lines.map((l) => ({
        qty: l.qtyOrdered.toString(),
        unitPrice: l.unitPrice.toString(),
        discountPct: l.discountPct.toString(),
        taxRate: l.taxRate.toString(),
      })),
      { plantStateCode: plant?.stateCode ?? '17', vendorGstin: po.vendor.gstin },
    );

    const commitment = await this.prisma.client.budgetCommitment.findFirst({
      where: { poId: id, sourceType: { in: ['PO', 'SPOT_BUY'] }, status: 'COMMITTED' },
    });
    const chain = await this.routing.getLiveChain('PURCHASE_ORDER', id);
    const myStep = chain.find((s) => s.approverId === userId && s.decision === 'PENDING');
    const authors = await this.userNames(po.comments.map((c) => c.authorId));
    const activity = await this.activity(id);

    return {
      id: po.id,
      number: po.number,
      status: po.status,
      poType: po.poType,
      isAmendmentOf: po.isAmendmentOf,
      vendor: {
        id: po.vendor.id,
        name: po.vendor.name,
        code: po.vendor.code,
        gstin: po.vendor.gstin,
        isMsme: po.vendor.isMsme,
      },
      requisition: po.requisition
        ? { id: po.requisition.id, number: po.requisition.number }
        : null,
      stages: this.stages(po.status),
      lines: po.lines.map((l) => this.toLineView(l)),
      amounts: {
        subtotal: tax.subtotal,
        taxAmount: tax.taxAmount,
        taxKind: taxKindLabel(tax.taxKind),
        total: tax.total,
        currency: po.currency,
      },
      deliveryAddress: (po.deliveryAddress as unknown as DeliveryAddress | null) ?? null,
      deliveryTerms: po.deliveryTerms,
      paymentTerms: (po.paymentTermsSnapshot as unknown as PaymentTerms | null) ?? null,
      expectedDeliveryDate: po.expectedDeliveryDate?.toISOString() ?? null,
      issuedAt: po.issuedAt?.toISOString() ?? null,
      acknowledgedAt: po.acknowledgedAt?.toISOString() ?? null,
      pdfAvailable: !!po.pdfS3Key,
      budgetCommitment: commitment
        ? { budgetId: commitment.budgetId, amount: commitment.amount.toString() }
        : null,
      grnLinks: po.grns.map((g) => ({
        id: g.id,
        number: g.number,
        qcStatus: g.qcStatus,
      })),
      invoiceLinks: po.invoices.map((i) => ({
        id: i.id,
        number: i.number,
        status: i.status,
      })),
      attachments: po.pdfS3Key
        ? [
            {
              id: 'po-pdf',
              url: `/purchase-orders/${id}/pdf`,
              mimeType: 'application/pdf',
            },
          ]
        : [],
      comments: po.comments.map((c) => ({
        id: c.id,
        authorId: c.authorId,
        authorName: authors.get(c.authorId) ?? c.authorId,
        source: c.source,
        isQuery: c.isQuery,
        body: c.body,
        createdAt: c.createdAt.toISOString(),
      })),
      activity,
      liveApprovalChain: chain,
      myApprovalId: myStep?.approvalId ?? null,
      canDecide: !!myStep,
      canIssue: po.status === 'APPROVED',
      canCancel: ![
        'PARTIALLY_RECEIVED',
        'RECEIVED',
        'INVOICED',
        'CLOSED',
        'CANCELLED',
      ].includes(po.status),
      canHold: po.status === 'APPROVED' || po.status === 'ISSUED',
      fulfilmentPct: this.fulfilment(po.lines),
    };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private toListItem(po: PoWithRels): PoListItem {
    return {
      id: po.id,
      number: po.number,
      vendor: { id: po.vendor.id, name: po.vendor.name, isMsme: po.vendor.isMsme },
      description: po.lines[0]?.itemDesc ?? '—',
      costCenter: po.requisition?.costCenter
        ? {
            id: po.requisition.costCenter.id,
            code: po.requisition.costCenter.code,
            name: po.requisition.costCenter.name,
          }
        : null,
      status: po.status,
      poType: po.poType,
      fulfilmentPct: this.fulfilment(po.lines),
      expectedDeliveryDate: po.expectedDeliveryDate?.toISOString() ?? null,
      totalAmount: po.totalAmount.toString(),
      currency: po.currency,
      acknowledged: !!po.acknowledgedAt,
    };
  }

  private toLineView(
    l: Prisma.PurchaseOrderLineGetPayload<Record<string, never>>,
  ): PoLineView {
    const ordered = new Decimal(l.qtyOrdered.toString());
    const received = new Decimal(l.qtyReceived.toString());
    const pct = ordered.isZero()
      ? 0
      : Number(received.dividedBy(ordered).times(100).toFixed(1));
    return {
      id: l.id,
      lineNo: l.lineNo,
      prLineId: l.prLineId,
      itemId: l.itemId,
      itemDesc: l.itemDesc,
      hsnCode: l.hsnCode,
      uom: l.uom,
      qtyOrdered: ordered.toFixed(4),
      qtyReceived: received.toFixed(4),
      qtyInvoiced: l.qtyInvoiced.toString(),
      unitPrice: l.unitPrice.toString(),
      discountPct: l.discountPct.toString(),
      taxRate: l.taxRate.toString(),
      lineTotal: l.lineTotal.toString(),
      glAccount: l.glAccount,
      fulfilmentPct: pct,
    };
  }

  private fulfilment(
    lines: { qtyOrdered: Prisma.Decimal; qtyReceived: Prisma.Decimal }[],
  ): number {
    const ordered = lines.reduce(
      (a, l) => a.plus(l.qtyOrdered.toString()),
      new Decimal(0),
    );
    const received = lines.reduce(
      (a, l) => a.plus(l.qtyReceived.toString()),
      new Decimal(0),
    );
    if (ordered.isZero()) return 0;
    return Number(received.dividedBy(ordered).times(100).toFixed(1));
  }

  private async counts(): Promise<PoListResponse['counts']> {
    const [open, partial, awaitingGrn, closed, cancelled] = await Promise.all([
      this.prisma.client.purchaseOrder.count({ where: { status: { in: OPEN } } }),
      this.prisma.client.purchaseOrder.count({ where: { status: 'PARTIALLY_RECEIVED' } }),
      this.prisma.client.purchaseOrder.count({
        where: { status: { in: ['ISSUED', 'ACKNOWLEDGED'] } },
      }),
      this.prisma.client.purchaseOrder.count({
        where: { status: { in: ['RECEIVED', 'INVOICED', 'CLOSED'] } },
      }),
      this.prisma.client.purchaseOrder.count({ where: { status: 'CANCELLED' } }),
    ]);
    return { open, partial, awaiting_grn: awaitingGrn, closed, cancelled };
  }

  private stages(status: string): PoDetailResponse['stages'] {
    const order = [
      'DRAFT',
      'APPROVAL',
      'ISSUED',
      'ACKNOWLEDGED',
      'PARTIAL_RECEIPT',
      'RECEIVED',
      'INVOICED',
      'CLOSED',
    ];
    const idx = ((): number => {
      if (status === 'DRAFT') return 0;
      if (status === 'AWAITING_APPROVAL') return 1;
      if (status === 'APPROVED') return 1;
      if (status === 'ISSUED') return 2;
      if (status === 'ACKNOWLEDGED') return 3;
      if (status === 'PARTIALLY_RECEIVED') return 4;
      if (status === 'RECEIVED') return 5;
      if (status === 'PARTIALLY_INVOICED' || status === 'INVOICED') return 6;
      if (status === 'CLOSED') return 7;
      return 0;
    })();
    const labels: Record<string, string> = {
      DRAFT: 'Draft',
      APPROVAL: 'Approval',
      ISSUED: 'Issued',
      ACKNOWLEDGED: 'Acknowledged',
      PARTIAL_RECEIPT: 'Partial receipt',
      RECEIVED: 'Fully received',
      INVOICED: 'Invoiced',
      CLOSED: 'Closed',
    };
    return order.map((key, i) => ({
      key,
      label: labels[key] ?? key,
      state: i < idx ? 'done' : i === idx ? 'active' : 'todo',
    }));
  }

  private async activity(id: string): Promise<PoDetailResponse['activity']> {
    const rows = await this.prisma.client.auditLog.findMany({
      where: { entityType: 'PurchaseOrder', entityId: id },
      orderBy: { timestamp: 'asc' },
      take: 100,
    });
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      actorId: r.actorId,
      at: r.timestamp.toISOString(),
    }));
  }

  private async userNames(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const users = await this.prisma.client.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true },
    });
    return new Map(users.map((u) => [u.id, u.name]));
  }
}
