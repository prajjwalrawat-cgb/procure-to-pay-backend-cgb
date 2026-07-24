import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Prisma, newId } from '@procureflow/db';
import {
  DOMAIN_EVENTS,
  MANDATORY_CLAUSE_TYPES,
  type AddClauseInput,
  type AmendmentInput,
  type ContractCreateInput,
  type ContractUpdateInput,
  type RenewInput,
  type TerminateInput,
} from '@procureflow/shared';

import { ApprovalRoutingService } from '../approvals/approval-routing.service';
import { NotificationService } from '../approvals/notification.service';
import { AuditLogService } from '../audit/audit.service';
import { DomainEventService } from '../common/events/domain-event.service';
import { PrismaService } from '../prisma/prisma.service';
import { ContractDocumentService } from './contract-document.service';
import {
  CosignRequiredError,
  ContractStateError,
  ContractValidationError,
} from './contract.errors';
import { crossedRenewalThresholds, daysBetween } from './contract-logic';

const EDITABLE = ['DRAFT', 'UNDER_NEGOTIATION'];

/** Whitelisted contract fields an amendment may change (beyond rate cards). */
const AMENDABLE_FIELDS = new Set([
  'totalValueEstimate',
  'validityEnd',
  'terminationNoticeDays',
  'minimumCommitmentValue',
  'minimumCommitmentQty',
]);

/**
 * ContractService (Slice 9). Owns the contract lifecycle — draft → approval
 * (Slice 2 engine) → execute (PDF + activate) → amend / renew / terminate — and
 * registers the approval hooks that apply amendments on approval.
 */
@Injectable()
export class ContractService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly events: DomainEventService,
    private readonly routing: ApprovalRoutingService,
    private readonly pdf: ContractDocumentService,
    private readonly notifications: NotificationService,
  ) {}

  onModuleInit(): void {
    // Applying an approved amendment is a cross-module reaction to the generic
    // engine firing (Master Context §3 rule #9; ADR-030 registry pattern).
    this.routing.onApproved('CONTRACT_AMENDMENT', (id, actorId) =>
      this.onAmendmentApproved(id, actorId),
    );
  }

  // ── Draft create / update ──────────────────────────────────────────────────

  async createDraft(
    input: ContractCreateInput,
    actorId: string,
  ): Promise<{ id: string }> {
    if (new Date(input.validityEnd) <= new Date(input.validityStart)) {
      throw new ContractValidationError('Validity end must be after validity start.');
    }
    let rateCards = input.rateCards;
    if (input.rfqId) {
      rateCards = await this.prefillFromFrameworkRfq(input, rateCards);
    }

    const id = newId('contract');
    const number = await this.nextNumber();
    await this.prisma.client.contract.create({
      data: {
        id,
        tenantId: this.tenantId(),
        number,
        title: input.title,
        contractType: input.contractType,
        vendorId: input.vendorId,
        category: input.category,
        rfqId: input.rfqId ?? null,
        status: 'DRAFT',
        validityStart: new Date(input.validityStart),
        validityEnd: new Date(input.validityEnd),
        autoRenew: input.autoRenew,
        renewalNoticeDays: input.renewalNoticeDays,
        currency: input.currency,
        totalValueEstimate: new Prisma.Decimal(input.totalValueEstimate),
        minimumCommitmentValue: input.minimumCommitmentValue
          ? new Prisma.Decimal(input.minimumCommitmentValue)
          : null,
        minimumCommitmentQty: input.minimumCommitmentQty
          ? new Prisma.Decimal(input.minimumCommitmentQty)
          : null,
        commitmentUom: input.commitmentUom ?? null,
        commitmentPeriod: input.commitmentPeriod,
        paymentTermsSnapshot: input.paymentTerms as unknown as Prisma.InputJsonValue,
        escalationClause: (input.escalationClause ?? null) as Prisma.InputJsonValue,
        terminationNoticeDays: input.terminationNoticeDays,
        governingLaw: input.governingLaw ?? null,
        disputeResolution: input.disputeResolution ?? null,
        requireVendorCountersign: input.requireVendorCountersign,
        skipPoApprovalWithinContract: input.skipPoApprovalWithinContract,
        maxCallOffValue: input.maxCallOffValue
          ? new Prisma.Decimal(input.maxCallOffValue)
          : null,
        parentContractId: input.parentContractId ?? null,
        createdBy: actorId,
        rateCards: { createMany: { data: this.rateCardRows(rateCards) } },
        clauses: { createMany: { data: this.clauseRows(input.clauses) } },
      },
    });

    await this.audit.record({
      action: 'CONTRACT_CREATED',
      entityType: 'Contract',
      entityId: id,
      actorId,
      after: { number, title: input.title, type: input.contractType },
    });
    return { id };
  }

  async updateDraft(
    id: string,
    input: ContractUpdateInput,
    actorId: string,
  ): Promise<{ ok: true }> {
    const c = await this.require(id);
    if (!EDITABLE.includes(c.status)) {
      throw new ContractStateError('Only a draft contract can be edited.', {
        status: c.status,
      });
    }
    const data: Prisma.ContractUpdateInput = {};
    if (input.title !== undefined) data.title = input.title;
    if (input.category !== undefined) data.category = input.category;
    if (input.validityStart) data.validityStart = new Date(input.validityStart);
    if (input.validityEnd) data.validityEnd = new Date(input.validityEnd);
    if (input.totalValueEstimate !== undefined)
      data.totalValueEstimate = new Prisma.Decimal(input.totalValueEstimate);
    if (input.paymentTerms !== undefined)
      data.paymentTermsSnapshot = input.paymentTerms as unknown as Prisma.InputJsonValue;
    if (input.escalationClause !== undefined)
      data.escalationClause = (input.escalationClause ??
        Prisma.JsonNull) as Prisma.InputJsonValue;
    if (input.autoRenew !== undefined) data.autoRenew = input.autoRenew;
    if (input.renewalNoticeDays !== undefined)
      data.renewalNoticeDays = input.renewalNoticeDays;

    await this.prisma.client.contract.update({ where: { id }, data });

    if (input.rateCards) {
      await this.prisma.client.contractRateCard.deleteMany({ where: { contractId: id } });
      await this.prisma.client.contractRateCard.createMany({
        data: this.rateCardRows(input.rateCards).map((r) => ({ ...r, contractId: id })),
      });
    }
    if (input.clauses) {
      await this.prisma.client.contractClause.deleteMany({ where: { contractId: id } });
      await this.prisma.client.contractClause.createMany({
        data: this.clauseRows(input.clauses).map((r) => ({ ...r, contractId: id })),
      });
    }
    await this.audit.record({
      action: 'CONTRACT_UPDATED',
      entityType: 'Contract',
      entityId: id,
      actorId,
    });
    return { ok: true };
  }

  async addClause(
    id: string,
    input: AddClauseInput,
    actorId: string,
  ): Promise<{ id: string }> {
    const c = await this.require(id);
    if (!EDITABLE.includes(c.status)) {
      throw new ContractStateError('Clauses can only change on a draft contract.');
    }
    const clauseId = newId('contractClause');
    await this.prisma.client.contractClause.create({
      data: {
        id: clauseId,
        tenantId: this.tenantId(),
        contractId: id,
        ...this.clauseRow(input),
      },
    });
    await this.audit.record({
      action: 'CONTRACT_CLAUSE_ADDED',
      entityType: 'Contract',
      entityId: id,
      actorId,
      after: { clauseType: input.clauseType, title: input.title },
    });
    return { id: clauseId };
  }

  async removeClause(
    id: string,
    clauseId: string,
    actorId: string,
  ): Promise<{ ok: true }> {
    const c = await this.require(id);
    if (!EDITABLE.includes(c.status)) {
      throw new ContractStateError('Clauses can only change on a draft contract.');
    }
    await this.prisma.client.contractClause.deleteMany({
      where: { id: clauseId, contractId: id },
    });
    await this.audit.record({
      action: 'CONTRACT_CLAUSE_REMOVED',
      entityType: 'Contract',
      entityId: id,
      actorId,
      after: { clauseId },
    });
    return { ok: true };
  }

  // ── Submit / execute ───────────────────────────────────────────────────────

  async submitForApproval(id: string, actorId: string): Promise<{ ok: true }> {
    const c = await this.prisma.client.contract.findUnique({
      where: { id },
      include: {
        rateCards: { select: { id: true } },
        clauses: { select: { clauseType: true } },
      },
    });
    if (!c) throw new NotFoundException('Contract not found');
    if (!EDITABLE.includes(c.status)) {
      throw new ContractStateError('Only a draft contract can be submitted.', {
        status: c.status,
      });
    }
    if (c.rateCards.length < 1) {
      throw new ContractValidationError('At least one rate card line is required.');
    }
    const present = new Set(c.clauses.map((cl) => cl.clauseType));
    const missing = MANDATORY_CLAUSE_TYPES.filter((t) => !present.has(t));
    if (missing.length > 0) {
      throw new ContractValidationError('Mandatory clauses are missing.', { missing });
    }
    if (c.validityEnd <= c.validityStart) {
      throw new ContractValidationError('Validity end must be after validity start.');
    }
    if (c.validityEnd <= new Date()) {
      throw new ContractValidationError('Validity end must be in the future.');
    }

    await this.audit.record({
      action: 'CONTRACT_SUBMITTED_FOR_APPROVAL',
      entityType: 'Contract',
      entityId: id,
      actorId,
    });
    await this.routing.submit('CONTRACT', id, actorId);
    return { ok: true };
  }

  async decide(
    approvalId: string,
    decision: 'APPROVE' | 'REJECT' | 'REQUEST_CHANGES',
    comment: string | null,
    actorId: string,
  ): Promise<{ ok: true }> {
    await this.routing.decide(approvalId, decision, comment, actorId);
    return { ok: true };
  }

  async execute(id: string, actorId: string): Promise<{ ok: true; status: string }> {
    const c = await this.require(id);
    if (c.status !== 'APPROVED') {
      throw new ContractStateError('Only an approved contract can be executed.', {
        status: c.status,
      });
    }
    const { buffer, hash } = await this.pdf.generate(id, {});
    const s3Key = `${c.tenantId}/contracts/${id}/${c.number}.pdf`;
    // Best-effort upload — the executed row is the source of truth even if
    // object storage is offline in dev (mirrors PO/RMA pattern).
    await this.storeExecutedPdf(id, s3Key, buffer, hash, actorId, c.number);

    const nextStatus = c.requireVendorCountersign
      ? 'AWAITING_VENDOR_SIGNATURE'
      : 'ACTIVE';
    await this.prisma.client.contract.update({
      where: { id },
      data: {
        status: nextStatus,
        executedAt: new Date(),
        executedBy: actorId,
        pdfS3Key: s3Key,
        pdfGeneratedHash: hash,
      },
    });

    // Renewal supersession: executing a contract born as a renewal retires its
    // predecessor and links both directions (Slice 9 §initiateRenewal).
    if (c.parentContractId) {
      await this.prisma.client.contract.update({
        where: { id },
        data: { supersedesContractId: c.parentContractId },
      });
      await this.prisma.client.contract.update({
        where: { id: c.parentContractId },
        data: { status: 'SUPERSEDED' },
      });
    }

    await this.ensureVolumeTrackingRow(id);
    await this.ensureRenewalAlerts(id);

    await this.audit.record({
      action: 'CONTRACT_EXECUTED',
      entityType: 'Contract',
      entityId: id,
      actorId,
      after: { status: nextStatus, pdfHash: hash },
    });
    await this.events.emit(DOMAIN_EVENTS.CONTRACT_EXECUTED, {
      contractId: id,
      vendorId: c.vendorId,
      contractType: c.contractType,
      totalValueEstimate: c.totalValueEstimate.toString(),
      validityEnd: c.validityEnd.toISOString(),
    });
    return { ok: true, status: nextStatus };
  }

  async recordVendorCountersign(
    id: string,
    s3Key: string,
    filename: string,
    actorId: string,
    vendorId: string,
  ): Promise<{ ok: true }> {
    const c = await this.require(id);
    if (c.vendorId !== vendorId) {
      throw new NotFoundException('Contract not found');
    }
    if (c.status !== 'AWAITING_VENDOR_SIGNATURE') {
      throw new ContractStateError('Contract is not awaiting a counter-signature.', {
        status: c.status,
      });
    }
    await this.prisma.client.contractDocument.create({
      data: {
        id: newId('contractDocument'),
        tenantId: c.tenantId,
        contractId: id,
        docType: 'VENDOR_COUNTERSIGNED',
        s3Key,
        filename,
        uploadedBy: actorId,
      },
    });
    await this.prisma.client.contract.update({
      where: { id },
      data: { status: 'ACTIVE', vendorSignedAt: new Date() },
    });
    await this.audit.record({
      action: 'CONTRACT_VENDOR_COUNTERSIGNED',
      entityType: 'Contract',
      entityId: id,
      actorId,
    });
    return { ok: true };
  }

  // ── Amend / renew / terminate ──────────────────────────────────────────────

  async amend(
    id: string,
    input: AmendmentInput,
    actorId: string,
  ): Promise<{ id: string }> {
    const c = await this.require(id);
    if (!['ACTIVE', 'EXPIRING_SOON'].includes(c.status)) {
      throw new ContractStateError('Only an active contract can be amended.', {
        status: c.status,
      });
    }
    const amendmentId = newId('contractAmendment');
    await this.prisma.client.contractAmendment.create({
      data: {
        id: amendmentId,
        tenantId: c.tenantId,
        contractId: id,
        amendmentNo: c.amendmentNo + 1,
        status: 'DRAFT',
        changeSummary: input.changeSummary,
        changedFields: {
          rateChanges: input.rateChanges,
          fieldChanges: input.fieldChanges,
        } as unknown as Prisma.InputJsonValue,
        changeValue: new Prisma.Decimal(input.changeValue),
        effectiveFrom: new Date(input.effectiveFrom),
        requestedBy: actorId,
      },
    });
    await this.audit.record({
      action: 'CONTRACT_AMENDMENT_PROPOSED',
      entityType: 'Contract',
      entityId: id,
      actorId,
      after: { amendmentId, summary: input.changeSummary },
    });
    await this.routing.submit('CONTRACT_AMENDMENT', amendmentId, actorId);
    return { id: amendmentId };
  }

  async decideAmendment(
    approvalId: string,
    decision: 'APPROVE' | 'REJECT' | 'REQUEST_CHANGES',
    comment: string | null,
    actorId: string,
  ): Promise<{ ok: true }> {
    await this.routing.decide(approvalId, decision, comment, actorId);
    return { ok: true };
  }

  /** Fired by the approval engine when a CONTRACT_AMENDMENT is fully approved. */
  private async onAmendmentApproved(amendmentId: string, actorId: string): Promise<void> {
    const a = await this.prisma.client.contractAmendment.findUnique({
      where: { id: amendmentId },
    });
    if (!a) return;
    const before = await this.prisma.client.contract.findUnique({
      where: { id: a.contractId },
    });
    const changed = a.changedFields as {
      rateChanges?: { rateCardId: string; newUnitRate: string }[];
      fieldChanges?: Record<string, unknown>;
    };
    for (const rc of changed.rateChanges ?? []) {
      await this.prisma.client.contractRateCard.updateMany({
        where: { id: rc.rateCardId, contractId: a.contractId },
        data: { unitRate: new Prisma.Decimal(rc.newUnitRate) },
      });
    }
    const fieldData: Prisma.ContractUpdateInput = {};
    for (const [k, v] of Object.entries(changed.fieldChanges ?? {})) {
      if (!AMENDABLE_FIELDS.has(k) || v == null) continue;
      if (k === 'validityEnd') fieldData.validityEnd = new Date(String(v));
      else if (k === 'terminationNoticeDays') fieldData.terminationNoticeDays = Number(v);
      else fieldData[k as 'totalValueEstimate'] = new Prisma.Decimal(String(v));
    }
    await this.prisma.client.contract.update({
      where: { id: a.contractId },
      data: { ...fieldData, amendmentNo: { increment: 1 } },
    });
    await this.prisma.client.contractAmendment.update({
      where: { id: amendmentId },
      data: { approvedAt: new Date(), approvedBy: actorId },
    });
    await this.audit.record({
      action: 'CONTRACT_AMENDED',
      entityType: 'Contract',
      entityId: a.contractId,
      actorId,
      before: { rateCards: 'see rate card rows', amendmentNo: before?.amendmentNo },
      after: { amendmentId, amendmentNo: (before?.amendmentNo ?? 0) + 1 },
    });
    await this.events.emit(DOMAIN_EVENTS.CONTRACT_AMENDED, {
      contractId: a.contractId,
      amendmentId,
      amendmentNo: a.amendmentNo,
    });
  }

  async initiateRenewal(
    id: string,
    input: RenewInput,
    actorId: string,
  ): Promise<{ id: string }> {
    const c = await this.prisma.client.contract.findUnique({
      where: { id },
      include: { rateCards: true, clauses: true },
    });
    if (!c) throw new NotFoundException('Contract not found');
    if (!['ACTIVE', 'EXPIRING_SOON', 'EXPIRED'].includes(c.status)) {
      throw new ContractStateError(
        'Only an active or expiring contract can be renewed.',
        {
          status: c.status,
        },
      );
    }
    const newContractId = newId('contract');
    const number = await this.nextNumber();
    const start = input.validityStart ? new Date(input.validityStart) : c.validityEnd;
    const end = input.validityEnd
      ? new Date(input.validityEnd)
      : new Date(new Date(start).setUTCFullYear(new Date(start).getUTCFullYear() + 1));

    await this.prisma.client.contract.create({
      data: {
        id: newContractId,
        tenantId: c.tenantId,
        number,
        title: `${c.title} (Renewal)`,
        contractType: c.contractType,
        vendorId: c.vendorId,
        category: c.category,
        status: 'DRAFT',
        validityStart: start,
        validityEnd: end,
        autoRenew: c.autoRenew,
        renewalNoticeDays: c.renewalNoticeDays,
        currency: c.currency,
        totalValueEstimate: c.totalValueEstimate,
        minimumCommitmentValue: c.minimumCommitmentValue,
        minimumCommitmentQty: c.minimumCommitmentQty,
        commitmentUom: c.commitmentUom,
        commitmentPeriod: c.commitmentPeriod,
        paymentTermsSnapshot: c.paymentTermsSnapshot ?? Prisma.JsonNull,
        escalationClause: c.escalationClause ?? Prisma.JsonNull,
        terminationNoticeDays: c.terminationNoticeDays,
        governingLaw: c.governingLaw,
        disputeResolution: c.disputeResolution,
        requireVendorCountersign: c.requireVendorCountersign,
        skipPoApprovalWithinContract: c.skipPoApprovalWithinContract,
        maxCallOffValue: c.maxCallOffValue,
        parentContractId: id,
        createdBy: actorId,
        rateCards: {
          createMany: {
            data: c.rateCards.map((r) => ({
              id: newId('contractRateCard'),
              tenantId: c.tenantId,
              lineNo: r.lineNo,
              itemId: r.itemId,
              itemDesc: r.itemDesc,
              uom: r.uom,
              rateYear: r.rateYear,
              unitRate: r.unitRate,
              taxRate: r.taxRate,
              volumeBandMin: r.volumeBandMin,
              volumeBandMax: r.volumeBandMax,
              routeOrigin: r.routeOrigin,
              routeDest: r.routeDest,
              effectiveFrom: start,
              effectiveTo: end,
            })),
          },
        },
        clauses: {
          createMany: {
            data: c.clauses.map((cl) => ({
              id: newId('contractClause'),
              tenantId: c.tenantId,
              clauseType: cl.clauseType,
              title: cl.title,
              contentText: cl.contentText,
              isFromLibrary: cl.isFromLibrary,
              libraryClauseId: cl.libraryClauseId,
              orderNo: cl.orderNo,
              isMandatory: cl.isMandatory,
            })),
          },
        },
      },
    });
    await this.audit.record({
      action: 'CONTRACT_RENEWAL_INITIATED',
      entityType: 'Contract',
      entityId: id,
      actorId,
      after: { newContractId, number },
    });
    await this.events.emit(DOMAIN_EVENTS.CONTRACT_RENEWAL_INITIATED, {
      parentContractId: id,
      newContractId,
    });
    return { id: newContractId };
  }

  async terminate(
    id: string,
    input: TerminateInput,
    actorId: string,
    actorRoles: string[],
  ): Promise<{ ok: true }> {
    const c = await this.require(id);
    if (!['ACTIVE', 'EXPIRING_SOON', 'AWAITING_VENDOR_SIGNATURE'].includes(c.status)) {
      throw new ContractStateError('Only an active contract can be terminated.', {
        status: c.status,
      });
    }
    const early = new Date(input.effectiveDate) < c.validityEnd;
    // Early termination requires legal cosign authority (Slice 9). A single
    // actor satisfies it only if they hold LEGAL_OFFICER (or TENANT_ADMIN break-glass).
    if (early && !actorRoles.some((r) => ['LEGAL_OFFICER', 'TENANT_ADMIN'].includes(r))) {
      throw new CosignRequiredError('Early termination requires Legal Officer co-sign.', {
        validityEnd: c.validityEnd.toISOString(),
      });
    }
    await this.prisma.client.contract.update({
      where: { id },
      data: {
        status: 'TERMINATED',
        terminatedAt: new Date(input.effectiveDate),
        terminationReason: input.reason,
      },
    });
    await this.audit.record({
      action: 'CONTRACT_TERMINATED',
      entityType: 'Contract',
      entityId: id,
      actorId,
      after: { reason: input.reason, early },
    });
    await this.events.emit(DOMAIN_EVENTS.CONTRACT_TERMINATED, {
      contractId: id,
      reason: input.reason,
      early,
    });
    return { ok: true };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async storeExecutedPdf(
    contractId: string,
    s3Key: string,
    buffer: Buffer,
    hash: string,
    actorId: string,
    number: string,
  ): Promise<void> {
    await this.prisma.client.contractDocument.create({
      data: {
        id: newId('contractDocument'),
        tenantId: this.tenantId(),
        contractId,
        docType: 'EXECUTED_PDF',
        s3Key,
        filename: `${number}.pdf`,
        fileHash: hash,
        mimeType: 'application/pdf',
        sizeBytes: buffer.length,
        uploadedBy: actorId,
      },
    });
  }

  private async ensureVolumeTrackingRow(contractId: string): Promise<void> {
    const c = await this.prisma.client.contract.findUnique({ where: { id: contractId } });
    if (!c) return;
    const period =
      c.commitmentPeriod === 'ANNUAL' ? this.fyLabel(c.validityStart) : 'LIFETIME';
    await this.prisma.client.contractVolumeTracking.upsert({
      where: { contractId_period: { contractId, period } },
      update: {},
      create: {
        id: newId('contractVolumeTracking'),
        tenantId: c.tenantId,
        contractId,
        period,
        committedQty: c.minimumCommitmentQty,
        committedValue: c.minimumCommitmentValue,
        status: 'ON_TRACK',
      },
    });
  }

  /** Create renewal alert rows for any threshold already crossed (idempotent). */
  async ensureRenewalAlerts(contractId: string): Promise<void> {
    const c = await this.prisma.client.contract.findUnique({ where: { id: contractId } });
    if (!c) return;
    const dte = daysBetween(new Date(), c.validityEnd);
    for (const alertType of crossedRenewalThresholds(dte)) {
      await this.prisma.client.contractRenewalAlert.upsert({
        where: { contractId_alertType: { contractId, alertType } },
        update: {},
        create: {
          id: newId('contractRenewalAlert'),
          tenantId: c.tenantId,
          contractId,
          alertType,
        },
      });
    }
  }

  private async prefillFromFrameworkRfq(
    input: ContractCreateInput,
    provided: ContractCreateInput['rateCards'],
  ): Promise<ContractCreateInput['rateCards']> {
    const rfq = await this.prisma.client.rfq.findUnique({
      where: { id: input.rfqId! },
      include: { lines: true },
    });
    if (!rfq) throw new ContractValidationError('Linked RFQ not found.');
    if (rfq.status !== 'AWARDED') {
      throw new ContractValidationError('RFQ must be AWARDED to seed a contract.', {
        status: rfq.status,
      });
    }
    if (rfq.rfqType !== 'FRAMEWORK') {
      throw new ContractValidationError('Only a FRAMEWORK RFQ can produce a contract.', {
        rfqType: rfq.rfqType,
      });
    }
    if (provided.length > 0) return provided; // caller already supplied rate cards
    const award = await this.prisma.client.award.findFirst({
      where: { rfqId: rfq.id, status: 'APPROVED' },
      include: { allocations: true },
    });
    if (!award) return provided;
    const lineById = new Map(rfq.lines.map((l) => [l.id, l]));
    return award.allocations.map((al) => {
      const line = lineById.get(al.rfqLineId);
      return {
        itemId: null,
        itemDesc: line?.itemDesc ?? 'Framework item',
        uom: line?.uom ?? 'unit',
        rateYear: 1,
        unitRate: al.unitPrice.toString(),
        taxRate: '0',
        volumeBandMin: null,
        volumeBandMax: null,
        routeOrigin: null,
        routeDest: null,
        effectiveFrom: input.validityStart,
        effectiveTo: input.validityEnd,
      };
    });
  }

  private rateCardRows(rows: ContractCreateInput['rateCards']) {
    return rows.map((r, i) => ({
      id: newId('contractRateCard'),
      tenantId: this.tenantId(),
      lineNo: i + 1,
      itemId: r.itemId ?? null,
      itemDesc: r.itemDesc,
      uom: r.uom,
      rateYear: r.rateYear,
      unitRate: new Prisma.Decimal(r.unitRate),
      taxRate: new Prisma.Decimal(r.taxRate),
      volumeBandMin: r.volumeBandMin ? new Prisma.Decimal(r.volumeBandMin) : null,
      volumeBandMax: r.volumeBandMax ? new Prisma.Decimal(r.volumeBandMax) : null,
      routeOrigin: r.routeOrigin ?? null,
      routeDest: r.routeDest ?? null,
      effectiveFrom: new Date(r.effectiveFrom),
      effectiveTo: new Date(r.effectiveTo),
    }));
  }

  private clauseRow(c: AddClauseInput) {
    return {
      clauseType: c.clauseType,
      title: c.title,
      contentText: c.contentText,
      isFromLibrary: c.isFromLibrary,
      libraryClauseId: c.libraryClauseId ?? null,
      orderNo: c.orderNo,
      isMandatory: c.isMandatory,
    };
  }

  private clauseRows(rows: ContractCreateInput['clauses']) {
    return rows.map((c) => ({
      id: newId('contractClause'),
      tenantId: this.tenantId(),
      ...this.clauseRow(c),
    }));
  }

  private fyLabel(date: Date): string {
    const y = date.getUTCFullYear();
    return `FY${date.getUTCMonth() >= 3 ? y : y - 1}`;
  }

  private async nextNumber(): Promise<string> {
    const year = new Date().getUTCFullYear();
    const prefix = `CT-${year}-`;
    const rows = await this.prisma.client.contract.findMany({
      where: { number: { startsWith: prefix } },
      orderBy: { number: 'desc' },
      take: 50,
      select: { number: true },
    });
    let max = 0;
    for (const r of rows) {
      const n = Number.parseInt(r.number.slice(prefix.length), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return `${prefix}${String(max + 1).padStart(4, '0')}`;
  }

  private async require(id: string) {
    const c = await this.prisma.client.contract.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Contract not found');
    return c;
  }

  private tenantId(): string {
    const tid = this.prisma.currentTenantId;
    if (!tid) throw new Error('No tenant context');
    return tid;
  }
}
