import { Injectable, NotFoundException } from '@nestjs/common';
import { PROCUREMENT_TEAM_ROLES } from '@procureflow/shared';
import type {
  ApprovalChainStepView,
  InvoiceDetailResponse,
  InvoiceListItem,
  InvoiceListQuery,
  InvoiceListResponse,
  InvoiceTabCounts,
  LiveApprovalStep,
  MsmeSummary,
} from '@procureflow/shared';
import Decimal from 'decimal.js';

import { ApprovalRoutingService } from '../approvals/approval-routing.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
import type { InvoiceScope } from './invoice-scope';
import { MsmeService } from './domain/msme.service';
import { TdsService } from './domain/tds.service';
import { defaultPlantQuery } from '../common/plants/default-plant';

const OPEN_STATUSES = [
  'RECEIVED',
  'OCR_PENDING',
  'OCR_DONE',
  'OCR_LOW_CONFIDENCE', // Slice 10a — manual review queue
  'OCR_FAILED', // Slice 10a — manual data-entry fallback
  'PENDING_VENDOR_MATCH', // Slice 10a — unrecognised email sender
  'MATCH_EXCEPTION',
  'AWAITING_APPROVAL',
  'APPROVED', // approved but unpaid — still AP's work until the bank confirms
  'HELD',
] as const;
const openStatusIn = (): { in: (typeof OPEN_STATUSES)[number][] } => ({
  in: [...OPEN_STATUSES],
});
const STAGE_DEFS = [
  { key: 'RECEIVED', label: 'Received' },
  { key: 'OCR', label: 'OCR done' },
  { key: 'MATCH', label: '3-way match' },
  { key: 'APPROVAL', label: 'Approval' },
  { key: 'SCHEDULED', label: 'Scheduled' },
  { key: 'PAID', label: 'Paid' },
];

@Injectable()
export class InvoiceQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly msme: MsmeService,
    private readonly tds: TdsService,
    private readonly routing: ApprovalRoutingService,
  ) {}

  /**
   * The `where` fragment that narrows a scoped caller's view, or `null` for a
   * tenant-wide reader. Four ways an invoice can be theirs:
   *
   *  - assigned to them;
   *  - billed against a purchase order they raised;
   *  - routed to them for approval — an approver who cannot open the document
   *    cannot judge it, and the inbox links straight at the invoice page;
   *  - raised by any procurement buyer, for a head with `invoice:read:team`.
   *
   * `Approval` is keyed by (documentType, documentId) with no relation to
   * `Invoice`, so the approver branch needs its ids fetched first.
   */
  private async scopeWhere(
    scope: InvoiceScope | null,
  ): Promise<Record<string, unknown> | null> {
    if (!scope) return null;
    const [approvals, team] = await Promise.all([
      this.prisma.client.approval.findMany({
        where: { documentType: 'INVOICE', approverId: scope.userId },
        select: { documentId: true },
      }),
      scope.team
        ? this.prisma.client.userRole.findMany({
            where: { role: { name: { in: PROCUREMENT_TEAM_ROLES } } },
            select: { userId: true },
          })
        : Promise.resolve([]),
    ]);
    const or: Record<string, unknown>[] = [
      { assignedToId: scope.userId },
      { po: { createdBy: scope.userId } },
    ];
    if (approvals.length > 0) {
      or.push({ id: { in: [...new Set(approvals.map((a) => a.documentId))] } });
    }
    if (team.length > 0) {
      or.push({ po: { createdBy: { in: [...new Set(team.map((t) => t.userId))] } } });
    }
    return { OR: or };
  }

  /** Merge the scope into a `where` without disturbing its own filters. */
  private merge(
    where: Record<string, unknown>,
    scope: Record<string, unknown> | null,
  ): Record<string, unknown> {
    if (!scope) return where;
    const existing = Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : [];
    return { ...where, AND: [...existing, scope] };
  }

  /**
   * Gate a single invoice for a narrow-scope caller. Out-of-scope invoices are
   * 404, not 403: a buyer has no business learning which supplier bills exist
   * outside their own orders. A `null` scope (tenant-wide reader) is a no-op.
   */
  async assertVisible(id: string, scope: InvoiceScope | null): Promise<void> {
    const clause = await this.scopeWhere(scope);
    if (!clause) return;
    const visible = await this.prisma.client.invoice.findFirst({
      where: { id, ...clause },
      select: { id: true },
    });
    if (!visible) throw new NotFoundException('Invoice not found');
  }

  /** `scope` narrows every tab to that caller's invoices (see invoice-scope). */
  async getTabCounts(scope: InvoiceScope | null = null): Promise<InvoiceTabCounts> {
    const c = this.prisma.client.invoice;
    const clause = await this.scopeWhere(scope);
    const scoped = (where: Record<string, unknown>): Record<string, unknown> =>
      this.merge(where, clause);
    const [all, exceptions, approval, approved, scheduled, paid, msme] =
      await Promise.all([
        c.count({ where: scoped({ status: openStatusIn() }) }),
        c.count({ where: scoped({ status: 'MATCH_EXCEPTION' }) }),
        c.count({ where: scoped({ status: 'AWAITING_APPROVAL' }) }),
        c.count({ where: scoped({ status: 'APPROVED' }) }),
        c.count({ where: scoped({ status: 'SCHEDULED' }) }),
        c.count({ where: scoped({ status: 'PAID' }) }),
        c.count({ where: scoped({ status: openStatusIn(), vendor: { isMsme: true } }) }),
      ]);
    return { all, exceptions, approval, approved, scheduled, paid, msme };
  }

  async find(
    query: InvoiceListQuery,
    scope: InvoiceScope | null = null,
  ): Promise<InvoiceListResponse> {
    const where = this.merge(this.buildWhere(query), await this.scopeWhere(scope));
    const items = await this.prisma.client.invoice.findMany({
      where,
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }], // aging desc = oldest first
      include: {
        vendor: { select: { id: true, name: true, isMsme: true } },
        po: { select: { number: true, grns: { select: { number: true }, take: 1 } } },
        exceptions: { where: { resolvedAt: null }, select: { id: true } },
      },
    });

    const hasMore = items.length > query.limit;
    const page = hasMore ? items.slice(0, query.limit) : items;
    const totalEstimate = await this.prisma.client.invoice.count({ where });

    const assigneeIds = [
      ...new Set(page.map((i) => i.assignedToId).filter((v): v is string => !!v)),
    ];
    const assignees = await this.prisma.client.user.findMany({
      where: { id: { in: assigneeIds } },
      select: { id: true, name: true },
    });
    const assigneeById = new Map(assignees.map((a) => [a.id, a]));

    return {
      items: page.map((inv): InvoiceListItem => ({
        id: inv.id,
        number: inv.number,
        vendorInvoiceRef: inv.vendorInvoiceRef,
        vendor: inv.vendor,
        poNumber: inv.po?.number ?? null,
        grnNumber: inv.po?.grns[0]?.number ?? null,
        status: inv.status,
        agingDays: agingDays(inv.receivedAt),
        grossAmount: inv.grossAmount.toString(),
        currency: inv.currency,
        exceptionCount: inv.exceptions.length,
        msme: this.msmeSummary(inv.msmeDueDate, inv.vendor.isMsme),
        assignedTo: inv.assignedToId
          ? (assigneeById.get(inv.assignedToId) ?? null)
          : null,
      })),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      totalEstimate,
    };
  }

  async findById(
    id: string,
    viewerId?: string,
    scope: InvoiceScope | null = null,
  ): Promise<InvoiceDetailResponse> {
    await this.assertVisible(id, scope);
    const inv = await this.prisma.client.invoice.findUnique({
      where: { id },
      include: {
        vendor: true,
        lines: { orderBy: { lineNo: 'asc' } },
        exceptions: { orderBy: { raisedAt: 'asc' } },
        attachments: true,
        comments: { orderBy: { createdAt: 'asc' } },
        po: { include: { lines: { orderBy: { lineNo: 'asc' } }, grns: { take: 1 } } },
      },
    });
    if (!inv) throw new NotFoundException('Invoice not found');

    // Place of supply for the CGST/SGST-vs-IGST split.
    const plant = await this.prisma.client.plant.findFirst({
      ...defaultPlantQuery(inv.tenantId),
      select: { stateCode: true },
    });

    const openExceptionLineIds = new Set(
      inv.exceptions
        .filter((e) => !e.resolvedAt && e.invoiceLineId)
        .map((e) => e.invoiceLineId),
    );
    const authorIds = [...new Set(inv.comments.map((c) => c.authorId))];
    const authors = await this.prisma.client.user.findMany({
      where: { id: { in: authorIds } },
      select: { id: true, name: true },
    });
    const authorName = new Map(authors.map((a) => [a.id, a.name]));

    const activity = await this.prisma.client.auditLog.findMany({
      where: {
        OR: [{ entityId: id }, { entityId: { in: inv.exceptions.map((e) => e.id) } }],
      },
      orderBy: { timestamp: 'asc' },
      select: { id: true, action: true, actorId: true, timestamp: true },
    });

    const attachments = await Promise.all(
      inv.attachments.map(async (a) => ({
        id: a.id,
        url: await this.storage.presignedGetUrl(a.s3Key).catch(() => ''),
        mimeType: a.mimeType,
      })),
    );

    const subtotal = new Decimal(inv.grossAmount.toString()).minus(
      inv.taxAmount.toString(),
    );
    const liveChain = await this.routing.getLiveChain('INVOICE', id);
    const myApproval = viewerId
      ? liveChain.find(
          (s) => s.isCurrent && s.decision === 'PENDING' && s.approverId === viewerId,
        )
      : undefined;
    const fytd = await this.tds.priorFytdBase(inv.vendorId, inv.invoiceDate);
    const assignee = inv.assignedToId
      ? await this.prisma.client.user.findUnique({
          where: { id: inv.assignedToId },
          select: { id: true, name: true },
        })
      : null;

    // Payment posting (Slice 3) — the "Payments" tab + Paid stage reference.
    const paymentRecord = await this.prisma.client.paymentRecord.findFirst({
      where: { invoiceId: id },
      orderBy: { paidAt: 'desc' },
      include: { paymentRun: { select: { id: true, number: true } } },
    });

    return {
      id: inv.id,
      number: inv.number,
      vendorInvoiceRef: inv.vendorInvoiceRef,
      status: inv.status,
      source: inv.source,
      invoiceDate: inv.invoiceDate.toISOString(),
      receivedAt: inv.receivedAt.toISOString(),
      stages: buildStages(inv.status),
      vendor: {
        id: inv.vendor.id,
        name: inv.vendor.name,
        code: inv.vendor.code,
        gstin: inv.vendor.gstin,
        isMsme: inv.vendor.isMsme,
        riskScore: inv.vendor.riskScore?.toString() ?? null,
        onTimePct: inv.vendor.onTimePct?.toString() ?? null,
        qualityPct: inv.vendor.qualityPct?.toString() ?? null,
        fytdSpend: fytd.toFixed(2),
      },
      po: inv.po ? { id: inv.po.id, number: inv.po.number, status: inv.po.status } : null,
      grn: inv.po?.grns[0]
        ? {
            id: inv.po.grns[0].id,
            number: inv.po.grns[0].number,
            qcStatus: inv.po.grns[0].qcStatus,
          }
        : null,
      lines: inv.lines.map((l) => ({
        id: l.id,
        lineNo: l.lineNo,
        itemDesc: l.itemDesc,
        uom: l.uom,
        qty: l.qty.toString(),
        unitPrice: l.unitPrice.toString(),
        taxRate: l.taxRate.toString(),
        lineTotal: l.lineTotal.toString(),
        poLineId: l.poLineId,
        hasVariance: openExceptionLineIds.has(l.id),
      })),
      poLines: (inv.po?.lines ?? []).map((l) => ({
        id: l.id,
        lineNo: l.lineNo,
        itemDesc: l.itemDesc,
        uom: l.uom,
        qtyOrdered: l.qtyOrdered.toString(),
        unitPrice: l.unitPrice.toString(),
        taxRate: l.taxRate.toString(),
      })),
      exceptions: inv.exceptions.map((e) => {
        const d = (e.details ?? {}) as Record<string, string | null>;
        return {
          id: e.id,
          type: e.exceptionType,
          severity: e.severity,
          poLineId: e.poLineId,
          invoiceLineId: e.invoiceLineId,
          expected: d.expected ?? null,
          actual: d.actual ?? null,
          variancePct: d.variancePct ?? null,
          impactWithTax: d.impactWithTax ?? null,
          message: d.message ?? '',
          resolved: e.resolvedAt !== null,
          resolutionAction: e.resolutionAction,
          resolutionNotes: e.resolutionNotes,
        };
      }),
      suggestedResolution: suggestResolution(inv.exceptions),
      matchSummary: {
        poSubtotal: (inv.po?.lines ?? [])
          .reduce(
            (a, l) =>
              a.plus(new Decimal(l.qtyOrdered.toString()).times(l.unitPrice.toString())),
            new Decimal(0),
          )
          .toFixed(4),
        invoiceSubtotal: subtotal.toFixed(4),
        varianceTotal: inv.exceptions
          .filter((e) => !e.resolvedAt)
          .reduce(
            (a, e) =>
              a.plus(
                new Decimal((e.details as Record<string, string>)?.impactWithTax ?? '0'),
              ),
            new Decimal(0),
          )
          .toFixed(4),
      },
      amounts: {
        subtotal: subtotal.toFixed(4),
        taxAmount: inv.taxAmount.toString(),
        taxKind: taxKind(inv.vendor.gstin, plant?.stateCode ?? null),
        tdsAmount: inv.tdsAmount.toString(),
        grossAmount: inv.grossAmount.toString(),
        netPayable: inv.netAmount.toString(),
        currency: inv.currency,
      },
      msme: this.msmeSummary(inv.msmeDueDate, inv.vendor.isMsme),
      compliance: {
        irn: inv.irn,
        ewaybillNo: inv.ewaybillNo,
        gstr2bStatus: inv.gstr2bStatus,
        gstinStatus: 'ACTIVE', // stub until Slice 10
      },
      attachments,
      comments: inv.comments.map((c) => ({
        id: c.id,
        authorId: c.authorId,
        authorName: authorName.get(c.authorId) ?? 'Unknown',
        body: c.body,
        createdAt: c.createdAt.toISOString(),
      })),
      activity: activity.map((a) => ({
        id: a.id,
        action: a.action,
        actorId: a.actorId,
        at: a.timestamp.toISOString(),
      })),
      pendingApprovalChain: liveChain.map(toChainStep),
      liveApprovalChain: liveChain,
      myApprovalId: myApproval?.approvalId ?? null,
      canDecide: Boolean(myApproval),
      assignedTo: assignee,
      payment: paymentRecord
        ? {
            paymentRunId: paymentRecord.paymentRun.id,
            paymentRunNumber: paymentRecord.paymentRun.number,
            utr: paymentRecord.utr,
            isStub: paymentRecord.isStub,
            gross: paymentRecord.gross.toString(),
            tds: paymentRecord.tds.toString(),
            net: paymentRecord.net.toString(),
            paidAt: paymentRecord.paidAt.toISOString(),
          }
        : null,
    };
  }

  private msmeSummary(dueDate: Date | null, isMsme: boolean): MsmeSummary | null {
    const bucket = this.msme.agingBucket(dueDate, isMsme);
    if (!bucket || !dueDate) return null;
    return {
      bucket,
      dueDate: dueDate.toISOString(),
      daysRemaining: this.msme.daysRemaining(dueDate) ?? 0,
    };
  }

  private buildWhere(query: InvoiceListQuery): Record<string, unknown> {
    const where: Record<string, unknown> = {};
    const tabStatus: Record<string, unknown> = {
      all: { status: openStatusIn() },
      exceptions: { status: 'MATCH_EXCEPTION' },
      approval: { status: 'AWAITING_APPROVAL' },
      approved: { status: 'APPROVED' },
      scheduled: { status: 'SCHEDULED' },
      paid: { status: 'PAID' },
      msme: { status: openStatusIn(), vendor: { isMsme: true } },
    };
    Object.assign(where, tabStatus[query.tab] ?? tabStatus.all);
    if (query.status?.length) where.status = { in: query.status };
    if (query.vendorId) where.vendorId = query.vendorId;
    if (query.assignedToId) where.assignedToId = query.assignedToId;
    if (query.exceptionType) {
      where.exceptions = {
        some: { exceptionType: query.exceptionType, resolvedAt: null },
      };
    }
    return where;
  }
}

function toChainStep(s: LiveApprovalStep): ApprovalChainStepView {
  return { stepNo: s.stepNo, role: s.approverName ?? s.role, slaHours: s.slaHours };
}

function agingDays(receivedAt: Date): number {
  return Math.max(
    0,
    Math.floor((Date.now() - receivedAt.getTime()) / (24 * 60 * 60 * 1000)),
  );
}

/** Place of supply is the buying tenant's own plant state, not a fixed one:
 *  same state as the vendor → CGST+SGST, otherwise IGST. */
function taxKind(gstin: string | null, plantStateCode: string | null): string {
  const vendorState = gstin ? gstin.slice(0, 2) : null;
  return plantStateCode && vendorState && plantStateCode === vendorState
    ? 'CGST_SGST'
    : 'IGST';
}

function buildStages(status: string): InvoiceDetailResponse['stages'] {
  const activeIndex: Record<string, number> = {
    RECEIVED: 0,
    OCR_PENDING: 1,
    PENDING_VENDOR_MATCH: 1,
    OCR_DONE: 2,
    OCR_LOW_CONFIDENCE: 1,
    OCR_FAILED: 1,
    MATCH_EXCEPTION: 2,
    HELD: 2,
    AWAITING_APPROVAL: 3,
    APPROVED: 3,
    SCHEDULED: 4,
    PAID: 5,
    REJECTED: 2,
  };
  const idx = activeIndex[status] ?? 0;
  return STAGE_DEFS.map((s, i) => ({
    ...s,
    state: i < idx ? 'done' : i === idx ? 'active' : 'todo',
  }));
}

function suggestResolution(
  exceptions: { exceptionType: string; resolvedAt: Date | null }[],
): string | null {
  const open = exceptions.filter((e) => !e.resolvedAt);
  if (open.length === 0) return null;
  if (open.some((e) => e.exceptionType === 'UNAUTHORISED_LINE')) {
    return 'Raise a debit note for the off-PO line, then accept the remaining variance.';
  }
  if (open.every((e) => e.exceptionType === 'RATE_VARIANCE')) {
    return 'Accept the rate variance if within your delegated tolerance.';
  }
  return 'Review each exception and resolve before routing for approval.';
}
