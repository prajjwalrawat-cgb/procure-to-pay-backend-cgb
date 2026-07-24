import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@procureflow/db';
import type {
  RmaDetailResponse,
  RmaListItem,
  RmaListQuery,
  RmaListResponse,
  VendorRmaListResponse,
} from '@procureflow/shared';

import { PrismaService } from '../prisma/prisma.service';

/** Read-side for RMAs: tabbed/filtered list, detail, and vendor-portal list. */
@Injectable()
export class RmaQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: RmaListQuery): Promise<RmaListResponse> {
    const where = this.whereForTab(query.tab);
    if (query.status)
      where.status = query.status as Prisma.ReturnMaterialAuthWhereInput['status'];
    if (query.vendorId) where.vendorId = query.vendorId;

    const rows = await this.prisma.client.returnMaterialAuth.findMany({
      where,
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { vendor: true, grn: true },
    });
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;

    return {
      items: page.map((r): RmaListItem => ({
        id: r.id,
        number: r.number,
        vendor: { id: r.vendor.id, name: r.vendor.name },
        grn: { id: r.grn.id, number: r.grn.number },
        reasonCode: r.reasonCode,
        status: r.status,
        totalReturnValue: r.totalReturnValue.toString(),
        currency: r.currency,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      totalEstimate: await this.prisma.client.returnMaterialAuth.count({ where }),
      counts: await this.counts(),
    };
  }

  async detail(id: string): Promise<RmaDetailResponse> {
    const rma = await this.prisma.client.returnMaterialAuth.findUnique({
      where: { id },
      include: {
        vendor: true,
        grn: { include: { po: true } },
        lines: { include: { grnLine: { include: { poLine: true } } } },
      },
    });
    if (!rma) throw new NotFoundException('RMA not found');

    const activity = await this.prisma.client.auditLog.findMany({
      where: { entityType: 'ReturnMaterialAuth', entityId: id },
      orderBy: { timestamp: 'asc' },
      take: 100,
    });

    return {
      id: rma.id,
      number: rma.number,
      status: rma.status,
      reasonCode: rma.reasonCode,
      reasonNotes: rma.reasonNotes,
      returnFreightBorneBy: rma.returnFreightBorneBy,
      vendor: {
        id: rma.vendor.id,
        name: rma.vendor.name,
        code: rma.vendor.code,
        gstin: rma.vendor.gstin,
      },
      grn: { id: rma.grn.id, number: rma.grn.number },
      po: { id: rma.grn.po.id, number: rma.grn.po.number },
      lines: rma.lines.map((l) => ({
        id: l.id,
        grnLineId: l.grnLineId,
        itemDesc: l.grnLine.poLine.itemDesc,
        uom: l.grnLine.poLine.uom,
        qtyReturned: l.qtyReturned.toString(),
        unitPrice: l.unitPrice.toString(),
        lineTotal: l.lineTotal.toString(),
        returnReasonDetail: l.returnReasonDetail,
      })),
      totalReturnValue: rma.totalReturnValue.toString(),
      currency: rma.currency,
      issuedAt: rma.issuedAt?.toISOString() ?? null,
      pickupScheduledAt: rma.pickupScheduledAt?.toISOString() ?? null,
      pickedUpAt: rma.pickedUpAt?.toISOString() ?? null,
      vehicleOutNo: rma.vehicleOutNo,
      gatePassOutNo: rma.gatePassOutNo,
      creditNoteRef: rma.creditNoteRef,
      creditNoteAmount: rma.creditNoteAmount?.toString() ?? null,
      pdfAvailable: !!rma.pdfS3Key,
      activity: activity.map((a) => ({
        id: a.id,
        action: a.action,
        actorId: a.actorId,
        at: a.timestamp.toISOString(),
      })),
      canEdit: rma.status === 'DRAFT',
      canIssue: rma.status === 'DRAFT',
      canRecordPickup: rma.status === 'ISSUED',
      canRecordCreditNote: ['ISSUED', 'PICKED_UP'].includes(rma.status),
      canClose: rma.status === 'CREDIT_NOTE_RECEIVED',
    };
  }

  /** Vendor-portal list — only the caller vendor's active RMAs. */
  async listForVendor(vendorId: string): Promise<VendorRmaListResponse> {
    const rows = await this.prisma.client.returnMaterialAuth.findMany({
      where: {
        vendorId,
        status: { in: ['ISSUED', 'PICKED_UP', 'CREDIT_NOTE_RECEIVED'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return {
      items: rows.map((r) => ({
        id: r.id,
        number: r.number,
        status: r.status,
        reasonCode: r.reasonCode,
        totalReturnValue: r.totalReturnValue.toString(),
        currency: r.currency,
        issuedAt: r.issuedAt?.toISOString() ?? null,
        pickupScheduledAt: r.pickupScheduledAt?.toISOString() ?? null,
        pdfAvailable: !!r.pdfS3Key,
      })),
      nextCursor: null,
      totalEstimate: rows.length,
    };
  }

  private whereForTab(tab: RmaListQuery['tab']): Prisma.ReturnMaterialAuthWhereInput {
    switch (tab) {
      case 'draft':
        return { status: 'DRAFT' };
      case 'issued':
        return { status: 'ISSUED' };
      case 'awaiting_pickup':
        return { status: 'ISSUED', pickupScheduledAt: { not: null } };
      case 'awaiting_credit_note':
        return { status: 'PICKED_UP' };
      case 'closed':
        return { status: { in: ['CLOSED', 'CREDIT_NOTE_RECEIVED'] } };
      default:
        return {};
    }
  }

  private async counts(): Promise<RmaListResponse['counts']> {
    const [draft, issued, awaitingPickup, awaitingCreditNote, closed] = await Promise.all(
      [
        this.prisma.client.returnMaterialAuth.count({ where: { status: 'DRAFT' } }),
        this.prisma.client.returnMaterialAuth.count({ where: { status: 'ISSUED' } }),
        this.prisma.client.returnMaterialAuth.count({
          where: { status: 'ISSUED', pickupScheduledAt: { not: null } },
        }),
        this.prisma.client.returnMaterialAuth.count({ where: { status: 'PICKED_UP' } }),
        this.prisma.client.returnMaterialAuth.count({
          where: { status: { in: ['CLOSED', 'CREDIT_NOTE_RECEIVED'] } },
        }),
      ],
    );
    return {
      draft,
      issued,
      awaiting_pickup: awaitingPickup,
      awaiting_credit_note: awaitingCreditNote,
      closed,
      all: draft + issued + awaitingCreditNote + closed,
    };
  }
}
