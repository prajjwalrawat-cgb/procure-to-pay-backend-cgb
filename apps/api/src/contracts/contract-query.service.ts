import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@procureflow/db';
import type {
  ContractDetailResponse,
  ContractListItem,
  ContractListQuery,
  ContractListResponse,
  ContractStatus,
  ContractType,
  EscalationClause,
  PaymentTerms,
  RenewalCalendarEntry,
  RenewalCalendarResponse,
  VendorContractDetailResponse,
  VendorContractListItem,
} from '@procureflow/shared';

import { ApprovalRoutingService } from '../approvals/approval-routing.service';
import { StorageService } from '../common/storage/storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { CallOffService } from './call-off.service';
import { ContractRenewalService } from './contract-renewal.service';
import { daysBetween, renewalBucket } from './contract-logic';

const TAB_STATUS: Record<ContractListQuery['tab'], ContractStatus[]> = {
  active: ['ACTIVE', 'AWAITING_VENDOR_SIGNATURE', 'EXPIRING_SOON'],
  draft: ['DRAFT', 'UNDER_NEGOTIATION'],
  awaiting_approval: ['AWAITING_APPROVAL', 'APPROVED'],
  expiring_soon: ['EXPIRING_SOON'],
  expired: ['EXPIRED', 'SUPERSEDED'],
  terminated: ['TERMINATED'],
};

/** Read models for the contracts workspace + vendor portal (Slice 9). */
@Injectable()
export class ContractQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly routing: ApprovalRoutingService,
    private readonly storage: StorageService,
    private readonly callOffs: CallOffService,
    private readonly renewals: ContractRenewalService,
  ) {}

  async list(query: ContractListQuery): Promise<ContractListResponse> {
    const where: Prisma.ContractWhereInput = {};
    where.status = { in: TAB_STATUS[query.tab] };
    if (query.status) where.status = { in: query.status.split(',') as ContractStatus[] };
    if (query.vendorId) where.vendorId = query.vendorId;
    if (query.category) where.category = query.category;
    if (query.contractType) where.contractType = query.contractType;
    if (query.expiringWithinDays) {
      const until = new Date();
      until.setUTCDate(until.getUTCDate() + query.expiringWithinDays);
      where.validityEnd = { lte: until };
    }

    const take = query.limit;
    const rows = await this.prisma.client.contract.findMany({
      where,
      include: { vendor: { select: { id: true, name: true } } },
      orderBy: { validityEnd: 'asc' },
      take: take + 1,
      ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}),
    });
    const page = rows.slice(0, take);
    const nextCursor = rows.length > take ? (page[page.length - 1]?.id ?? null) : null;

    const now = new Date();
    const items: ContractListItem[] = page.map((c) => ({
      id: c.id,
      number: c.number,
      title: c.title,
      vendor: { id: c.vendor.id, name: c.vendor.name },
      contractType: c.contractType as ContractType,
      category: c.category,
      status: c.status,
      totalValueEstimate: c.totalValueEstimate.toString(),
      currency: c.currency,
      validityStart: c.validityStart.toISOString(),
      validityEnd: c.validityEnd.toISOString(),
      daysToExpiry: daysBetween(now, c.validityEnd),
    }));

    const counts = await this.tabCounts();
    return {
      items,
      nextCursor,
      totalEstimate: await this.prisma.client.contract.count({ where }),
      counts,
    };
  }

  private async tabCounts(): Promise<ContractListResponse['counts']> {
    const grouped = await this.prisma.client.contract.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    const byStatus = new Map(grouped.map((g) => [g.status, g._count._all]));
    const sum = (statuses: string[]): number =>
      statuses.reduce((n, s) => n + (byStatus.get(s as never) ?? 0), 0);
    return {
      active: sum(TAB_STATUS.active),
      draft: sum(TAB_STATUS.draft),
      awaiting_approval: sum(TAB_STATUS.awaiting_approval),
      expiring_soon: sum(TAB_STATUS.expiring_soon),
      expired: sum(TAB_STATUS.expired),
      terminated: sum(TAB_STATUS.terminated),
    };
  }

  async detail(id: string, actorId: string): Promise<ContractDetailResponse> {
    const c = await this.prisma.client.contract.findUnique({
      where: { id },
      include: {
        vendor: { select: { id: true, name: true, code: true, gstin: true } },
        rateCards: { orderBy: [{ rateYear: 'asc' }, { lineNo: 'asc' }] },
        clauses: { orderBy: { orderNo: 'asc' } },
        documents: { orderBy: { uploadedAt: 'desc' } },
        amendments: { orderBy: { amendmentNo: 'desc' } },
        renewalAlerts: { orderBy: { triggeredAt: 'desc' } },
        callOffs: { orderBy: { calledOffAt: 'desc' } },
      },
    });
    if (!c) throw new NotFoundException('Contract not found');

    const poIds = c.callOffs.map((co) => co.poId);
    const pos = poIds.length
      ? await this.prisma.client.purchaseOrder.findMany({
          where: { id: { in: poIds } },
          select: { id: true, number: true, status: true },
        })
      : [];
    const poById = new Map(pos.map((p) => [p.id, p]));

    const docs = await Promise.all(
      c.documents.map(async (d) => ({
        id: d.id,
        docType: d.docType,
        filename: d.filename,
        url: await this.storage.presignedGetUrl(d.s3Key).catch(() => ''),
        uploadedAt: d.uploadedAt.toISOString(),
      })),
    );

    const superseder = await this.prisma.client.contract.findFirst({
      where: { supersedesContractId: id },
      select: { id: true },
    });

    const liveApprovalChain = await this.routing.getLiveChain('CONTRACT', id);
    const myApproval = await this.prisma.client.approval.findFirst({
      where: {
        documentType: 'CONTRACT',
        documentId: id,
        approverId: actorId,
        decision: 'PENDING',
      },
      select: { id: true },
    });
    const activity = await this.prisma.client.auditLog.findMany({
      where: { entityType: 'Contract', entityId: id },
      orderBy: { timestamp: 'desc' },
      take: 50,
      select: { id: true, action: true, actorId: true, timestamp: true },
    });
    const volumeTracking = await this.callOffs.getVolumeTrackingStatus(id);
    const now = new Date();
    const rateYears = [...new Set(c.rateCards.map((r) => r.rateYear))].sort(
      (a, b) => a - b,
    );

    return {
      id: c.id,
      number: c.number,
      title: c.title,
      contractType: c.contractType as ContractType,
      category: c.category,
      status: c.status,
      vendor: c.vendor,
      rfqId: c.rfqId,
      currency: c.currency,
      totalValueEstimate: c.totalValueEstimate.toString(),
      validityStart: c.validityStart.toISOString(),
      validityEnd: c.validityEnd.toISOString(),
      daysToExpiry: daysBetween(now, c.validityEnd),
      autoRenew: c.autoRenew,
      renewalNoticeDays: c.renewalNoticeDays,
      terminationNoticeDays: c.terminationNoticeDays,
      commitmentPeriod: c.commitmentPeriod,
      minimumCommitmentValue: c.minimumCommitmentValue?.toString() ?? null,
      minimumCommitmentQty: c.minimumCommitmentQty?.toString() ?? null,
      commitmentUom: c.commitmentUom,
      paymentTerms: (c.paymentTermsSnapshot as unknown as PaymentTerms | null) ?? null,
      escalationClause:
        (c.escalationClause as unknown as EscalationClause | null) ?? null,
      governingLaw: c.governingLaw,
      disputeResolution: c.disputeResolution,
      requireVendorCountersign: c.requireVendorCountersign,
      skipPoApprovalWithinContract: c.skipPoApprovalWithinContract,
      maxCallOffValue: c.maxCallOffValue?.toString() ?? null,
      amendmentNo: c.amendmentNo,
      parentContractId: c.parentContractId,
      supersedesContractId: c.supersedesContractId,
      supersededByContractId: superseder?.id ?? null,
      executedAt: c.executedAt?.toISOString() ?? null,
      vendorSignedAt: c.vendorSignedAt?.toISOString() ?? null,
      terminatedAt: c.terminatedAt?.toISOString() ?? null,
      terminationReason: c.terminationReason,
      pdfAvailable: Boolean(c.pdfS3Key),
      stages: this.stages(c.status),
      rateCards: c.rateCards.map((r) => ({
        id: r.id,
        lineNo: r.lineNo,
        itemId: r.itemId,
        itemDesc: r.itemDesc,
        uom: r.uom,
        rateYear: r.rateYear,
        unitRate: r.unitRate.toString(),
        taxRate: r.taxRate.toString(),
        volumeBandMin: r.volumeBandMin?.toString() ?? null,
        volumeBandMax: r.volumeBandMax?.toString() ?? null,
        routeOrigin: r.routeOrigin,
        routeDest: r.routeDest,
        effectiveFrom: r.effectiveFrom.toISOString(),
        effectiveTo: r.effectiveTo.toISOString(),
      })),
      rateYears,
      clauses: c.clauses.map((cl) => ({
        id: cl.id,
        clauseType: cl.clauseType,
        title: cl.title,
        contentText: cl.contentText,
        isFromLibrary: cl.isFromLibrary,
        libraryClauseId: cl.libraryClauseId,
        orderNo: cl.orderNo,
        isMandatory: cl.isMandatory,
      })),
      documents: docs,
      callOffs: c.callOffs.map((co) => ({
        id: co.id,
        poId: co.poId,
        poNumber: poById.get(co.poId)?.number ?? '—',
        poStatus: poById.get(co.poId)?.status ?? 'UNKNOWN',
        qty: co.qty.toString(),
        value: co.value.toString(),
        calledOffAt: co.calledOffAt.toISOString(),
      })),
      amendments: c.amendments.map((a) => ({
        id: a.id,
        amendmentNo: a.amendmentNo,
        status: a.status,
        changeSummary: a.changeSummary,
        changeValue: a.changeValue.toString(),
        requestedBy: a.requestedBy,
        requestedAt: a.requestedAt.toISOString(),
        approvedAt: a.approvedAt?.toISOString() ?? null,
        effectiveFrom: a.effectiveFrom.toISOString(),
      })),
      renewalAlerts: c.renewalAlerts.map((al) => ({
        id: al.id,
        alertType: al.alertType,
        triggeredAt: al.triggeredAt.toISOString(),
        acknowledgedAt: al.acknowledgedAt?.toISOString() ?? null,
        acknowledgedBy: al.acknowledgedBy,
        actionTaken: al.actionTaken,
      })),
      volumeTracking,
      liveApprovalChain,
      myApprovalId: myApproval?.id ?? null,
      activity: activity.map((a) => ({
        id: a.id,
        action: a.action,
        actorId: a.actorId,
        at: a.timestamp.toISOString(),
      })),
      canEdit: ['DRAFT', 'UNDER_NEGOTIATION'].includes(c.status),
      canSubmit: ['DRAFT', 'UNDER_NEGOTIATION'].includes(c.status),
      canDecide: Boolean(myApproval),
      canExecute: c.status === 'APPROVED',
      canAmend: ['ACTIVE', 'EXPIRING_SOON'].includes(c.status),
      canRenew: ['ACTIVE', 'EXPIRING_SOON', 'EXPIRED'].includes(c.status),
      canTerminate: ['ACTIVE', 'EXPIRING_SOON', 'AWAITING_VENDOR_SIGNATURE'].includes(
        c.status,
      ),
      canCallOff: c.status === 'ACTIVE',
    };
  }

  async renewalCalendar(): Promise<RenewalCalendarResponse> {
    // Lazily refresh statuses + alert rows so the calendar is always current
    // (the nightly job is the primary driver; this keeps reads honest).
    await this.renewals.checkExpiringContracts();
    const now = new Date();
    const horizon = new Date();
    horizon.setUTCDate(horizon.getUTCDate() + 90);
    const contracts = await this.prisma.client.contract.findMany({
      where: {
        status: { in: ['ACTIVE', 'EXPIRING_SOON', 'EXPIRED'] },
        validityEnd: { lte: horizon },
      },
      include: {
        vendor: { select: { name: true } },
        renewalAlerts: { orderBy: { triggeredAt: 'desc' } },
      },
      orderBy: { validityEnd: 'asc' },
    });
    const entries: RenewalCalendarEntry[] = contracts.map((c) => {
      const dte = daysBetween(now, c.validityEnd);
      const alert =
        c.renewalAlerts.find((a) => a.acknowledgedAt === null) ?? c.renewalAlerts[0];
      return {
        contractId: c.id,
        number: c.number,
        title: c.title,
        vendorName: c.vendor.name,
        totalValueEstimate: c.totalValueEstimate.toString(),
        currency: c.currency,
        validityEnd: c.validityEnd.toISOString(),
        daysToExpiry: dte,
        bucket: renewalBucket(dte),
        alert: alert
          ? {
              id: alert.id,
              alertType: alert.alertType,
              triggeredAt: alert.triggeredAt.toISOString(),
              acknowledgedAt: alert.acknowledgedAt?.toISOString() ?? null,
              acknowledgedBy: alert.acknowledgedBy,
              actionTaken: alert.actionTaken,
            }
          : null,
      };
    });
    return { entries };
  }

  // ── Vendor portal ──────────────────────────────────────────────────────────

  /** Map a vendor-portal user to its Vendor id (matches the Slice 4 pattern). */
  async resolveVendorId(userId: string): Promise<string> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user) throw new NotFoundException('Not a vendor account');
    const contact = await this.prisma.client.vendorContact.findFirst({
      where: { email: user.email },
      select: { vendorId: true },
    });
    if (!contact) throw new NotFoundException('No vendor linked to this account');
    return contact.vendorId;
  }

  async vendorList(vendorId: string): Promise<VendorContractListItem[]> {
    const rows = await this.prisma.client.contract.findMany({
      where: {
        vendorId,
        status: {
          in: ['ACTIVE', 'AWAITING_VENDOR_SIGNATURE', 'EXPIRING_SOON', 'EXPIRED'],
        },
      },
      orderBy: { validityEnd: 'asc' },
    });
    return rows.map((c) => ({
      id: c.id,
      number: c.number,
      title: c.title,
      contractType: c.contractType as ContractType,
      status: c.status,
      validityStart: c.validityStart.toISOString(),
      validityEnd: c.validityEnd.toISOString(),
      requiresCountersign: c.status === 'AWAITING_VENDOR_SIGNATURE',
    }));
  }

  async vendorDetail(
    id: string,
    vendorId: string,
  ): Promise<VendorContractDetailResponse> {
    const c = await this.prisma.client.contract.findUnique({
      where: { id },
      include: {
        rateCards: { orderBy: [{ rateYear: 'asc' }, { lineNo: 'asc' }] },
        clauses: { orderBy: { orderNo: 'asc' } },
        documents: { orderBy: { uploadedAt: 'desc' } },
        callOffs: { orderBy: { calledOffAt: 'desc' } },
      },
    });
    // Vendor-scoped: never leak another vendor's contract (RLS + this guard).
    if (!c || c.vendorId !== vendorId) throw new NotFoundException('Contract not found');

    const poIds = c.callOffs.map((co) => co.poId);
    const pos = poIds.length
      ? await this.prisma.client.purchaseOrder.findMany({
          where: { id: { in: poIds } },
          select: { id: true, number: true, status: true },
        })
      : [];
    const poById = new Map(pos.map((p) => [p.id, p]));
    const docs = await Promise.all(
      c.documents.map(async (d) => ({
        id: d.id,
        docType: d.docType,
        filename: d.filename,
        url: await this.storage.presignedGetUrl(d.s3Key).catch(() => ''),
        uploadedAt: d.uploadedAt.toISOString(),
      })),
    );

    return {
      id: c.id,
      number: c.number,
      title: c.title,
      contractType: c.contractType as ContractType,
      status: c.status,
      validityStart: c.validityStart.toISOString(),
      validityEnd: c.validityEnd.toISOString(),
      currency: c.currency,
      paymentTerms: (c.paymentTermsSnapshot as unknown as PaymentTerms | null) ?? null,
      requiresCountersign: c.status === 'AWAITING_VENDOR_SIGNATURE',
      rateCards: c.rateCards.map((r) => ({
        id: r.id,
        lineNo: r.lineNo,
        itemId: r.itemId,
        itemDesc: r.itemDesc,
        uom: r.uom,
        rateYear: r.rateYear,
        unitRate: r.unitRate.toString(),
        taxRate: r.taxRate.toString(),
        volumeBandMin: r.volumeBandMin?.toString() ?? null,
        volumeBandMax: r.volumeBandMax?.toString() ?? null,
        routeOrigin: r.routeOrigin,
        routeDest: r.routeDest,
        effectiveFrom: r.effectiveFrom.toISOString(),
        effectiveTo: r.effectiveTo.toISOString(),
      })),
      clauses: c.clauses.map((cl) => ({
        id: cl.id,
        clauseType: cl.clauseType,
        title: cl.title,
        contentText: cl.contentText,
        isFromLibrary: cl.isFromLibrary,
        libraryClauseId: cl.libraryClauseId,
        orderNo: cl.orderNo,
        isMandatory: cl.isMandatory,
      })),
      callOffs: c.callOffs.map((co) => ({
        id: co.id,
        poId: co.poId,
        poNumber: poById.get(co.poId)?.number ?? '—',
        poStatus: poById.get(co.poId)?.status ?? 'UNKNOWN',
        qty: co.qty.toString(),
        value: co.value.toString(),
        calledOffAt: co.calledOffAt.toISOString(),
      })),
      documents: docs,
      pdfAvailable: Boolean(c.pdfS3Key),
    };
  }

  private stages(status: string): ContractDetailResponse['stages'] {
    const order = ['DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'ACTIVE'];
    const terminal = ['EXPIRED', 'SUPERSEDED', 'TERMINATED'];
    const labels: Record<string, string> = {
      DRAFT: 'Draft',
      AWAITING_APPROVAL: 'Approval',
      APPROVED: 'Executed',
      ACTIVE: 'Active',
    };
    const norm = status === 'UNDER_NEGOTIATION' ? 'DRAFT' : status;
    const activeIdx =
      norm === 'AWAITING_VENDOR_SIGNATURE' || norm === 'EXPIRING_SOON'
        ? order.indexOf('ACTIVE')
        : order.indexOf(norm);
    const steps = order.map((key, i) => ({
      key,
      label: labels[key]!,
      state: (terminal.includes(status)
        ? 'done'
        : i < activeIdx
          ? 'done'
          : i === activeIdx
            ? 'active'
            : 'todo') as 'done' | 'active' | 'todo',
    }));
    if (terminal.includes(status)) {
      steps.push({
        key: status,
        label: status.charAt(0) + status.slice(1).toLowerCase(),
        state: 'active',
      });
    }
    return steps;
  }
}
