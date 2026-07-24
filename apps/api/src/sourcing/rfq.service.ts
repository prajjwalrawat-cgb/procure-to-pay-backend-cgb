import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, newId } from '@procureflow/db';
import {
  SOURCING_EVENTS,
  validateCriteriaWeights,
  watermarkSeed,
  type RfqCorrigendumInput,
  type RfqCreateInput,
  type RfqInvitationInput,
  type RfqPublishInput,
  type RfqUpdateInput,
} from '@procureflow/shared';

import { DomainEventService } from '../common/events/domain-event.service';
import { NotificationService } from '../approvals/notification.service';
import { PrismaService } from '../prisma/prisma.service';
import { SourcingAuditService } from './sourcing-audit.service';
import { SourcingStateError, SourcingValidationError } from './sourcing.errors';

/**
 * RfqService (Slice 6 §2). Owns the RFQ authoring lifecycle: draft → invite →
 * publish → corrigendum → cancel. Reads item master to snapshot line specs so
 * later item edits never retroactively change a published RFQ. Publishing runs
 * a full guard set and routes into the Q&A / bidding window.
 */
@Injectable()
export class RfqService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: SourcingAuditService,
    private readonly events: DomainEventService,
    private readonly notifications: NotificationService,
  ) {}

  async createDraft(input: RfqCreateInput, actorId: string): Promise<{ id: string }> {
    const tenantId = this.tenantId();
    const weights = validateCriteriaWeights(input.evaluationCriteria);
    if (!weights.valid) {
      throw new SourcingValidationError('Evaluation criteria weights must sum to 100.', {
        sum: weights.sum,
      });
    }
    if (input.requisitionId) {
      await this.assertPrLinkable(input.requisitionId, input.lines);
    }

    const year = new Date().getUTCFullYear();
    const number = await this.audit.nextRfqNumber(tenantId, year);
    const id = newId('rfq');

    const lines = await this.buildLines(input);

    await this.prisma.client.rfq.create({
      data: {
        id,
        tenantId,
        number,
        title: input.title,
        requisitionId: input.requisitionId ?? null,
        category: input.category,
        subcategory: input.subcategory ?? null,
        rfqType: input.rfqType,
        status: 'DRAFT',
        currency: input.currency,
        incotermDefault: input.incotermDefault,
        deliveryLocation: input.deliveryLocation as unknown as Prisma.InputJsonValue,
        paymentTermsDefault: input.paymentTermsDefault,
        estimatedValue: new Prisma.Decimal(input.estimatedValue),
        budgetRangeMin: input.budgetRangeMin
          ? new Prisma.Decimal(input.budgetRangeMin)
          : null,
        budgetRangeMax: input.budgetRangeMax
          ? new Prisma.Decimal(input.budgetRangeMax)
          : null,
        evaluationCriteria: input.evaluationCriteria as unknown as Prisma.InputJsonValue,
        requiredDocuments: input.requiredDocuments as unknown as Prisma.InputJsonValue,
        allowPartialAward: input.allowPartialAward,
        allowSplitAward: input.allowSplitAward,
        maxAwardVendors: input.maxAwardVendors,
        blindEvaluation: input.blindEvaluation,
        allowBidRevision: input.allowBidRevision,
        revisionCountMax: input.revisionCountMax,
        isReverseAuction: input.isReverseAuction || input.rfqType === 'REVERSE_AUCTION',
        reverseAuctionConfig: (input.reverseAuctionConfig ??
          null) as Prisma.InputJsonValue,
        createdBy: actorId,
        lines: { createMany: { data: lines } },
      },
    });

    await this.audit.rfq('RFQ_CREATED', id, actorId, {
      number,
      title: input.title,
      lineCount: lines.length,
    });
    return { id };
  }

  async updateDraft(
    id: string,
    input: RfqUpdateInput,
    actorId: string,
  ): Promise<{ ok: true }> {
    const rfq = await this.requireRfq(id);
    if (rfq.status !== 'DRAFT') {
      throw new SourcingStateError('Only a draft RFQ can be edited.', {
        status: rfq.status,
      });
    }
    if (input.evaluationCriteria) {
      const weights = validateCriteriaWeights(input.evaluationCriteria);
      if (!weights.valid) {
        throw new SourcingValidationError(
          'Evaluation criteria weights must sum to 100.',
          { sum: weights.sum },
        );
      }
    }
    const data: Prisma.RfqUpdateInput = {};
    if (input.title) data.title = input.title;
    if (input.category) data.category = input.category;
    if (input.subcategory !== undefined) data.subcategory = input.subcategory ?? null;
    if (input.incotermDefault) data.incotermDefault = input.incotermDefault;
    if (input.paymentTermsDefault) data.paymentTermsDefault = input.paymentTermsDefault;
    if (input.estimatedValue)
      data.estimatedValue = new Prisma.Decimal(input.estimatedValue);
    if (input.evaluationCriteria) {
      data.evaluationCriteria =
        input.evaluationCriteria as unknown as Prisma.InputJsonValue;
    }
    if (input.requiredDocuments) {
      data.requiredDocuments =
        input.requiredDocuments as unknown as Prisma.InputJsonValue;
    }
    if (input.blindEvaluation !== undefined) data.blindEvaluation = input.blindEvaluation;

    if (input.lines) {
      const lines = await this.buildLines({
        ...input,
        lines: input.lines,
      } as RfqCreateInput);
      await this.prisma.client.rfqLine.deleteMany({ where: { rfqId: id } });
      data.lines = { createMany: { data: lines } };
    }
    await this.prisma.client.rfq.update({ where: { id }, data });
    await this.audit.rfq('RFQ_UPDATED', id, actorId);
    return { ok: true };
  }

  async addInvitation(
    rfqId: string,
    input: RfqInvitationInput,
    actorId: string,
  ): Promise<{ added: number }> {
    const rfq = await this.requireRfq(rfqId);
    if (rfq.status !== 'DRAFT') {
      throw new SourcingStateError('Invitations can only be added before publish.');
    }
    let added = 0;
    for (const vendorId of input.vendorIds) {
      const vendor = await this.prisma.client.vendor.findUnique({
        where: { id: vendorId },
        include: { banks: true },
      });
      if (!vendor) throw new NotFoundException(`Vendor ${vendorId} not found`);
      if (vendor.status === 'BLOCKED') {
        throw new SourcingValidationError('Blacklisted vendor cannot be invited.', {
          vendorId,
        });
      }
      const bankVerified = vendor.banks.some((b) => b.isVerified);
      if (!bankVerified && !input.isPreliminaryInvitation && !vendor.preliminaryStatus) {
        throw new SourcingValidationError(
          'Vendor has no verified bank account; invite as preliminary to proceed.',
          { vendorId },
        );
      }
      const exists = await this.prisma.client.rfqInvitation.findUnique({
        where: { rfqId_vendorId: { rfqId, vendorId } },
      });
      if (exists) continue;
      const id = newId('rfqInvitation');
      await this.prisma.client.rfqInvitation.create({
        data: {
          id,
          tenantId: this.tenantId(),
          rfqId,
          vendorId,
          invitedBy: actorId,
          invitationSource: input.source,
          isPreliminary: input.isPreliminaryInvitation || vendor.preliminaryStatus,
          watermarkSeed: watermarkSeed(rfqId, id),
        },
      });
      added += 1;
    }
    await this.audit.rfq('RFQ_INVITATIONS_ADDED', rfqId, actorId, {
      vendorIds: input.vendorIds,
      added,
    });
    return { added };
  }

  async removeInvitation(
    rfqId: string,
    invitationId: string,
    reason: string,
    actorId: string,
  ): Promise<{ ok: true }> {
    const rfq = await this.requireRfq(rfqId);
    if (rfq.status !== 'DRAFT') {
      throw new SourcingStateError('Invitations can only be removed before publish.');
    }
    await this.prisma.client.rfqInvitation.deleteMany({
      where: { id: invitationId, rfqId },
    });
    await this.audit.rfq('RFQ_INVITATION_REMOVED', rfqId, actorId, {
      invitationId,
      reason,
    });
    return { ok: true };
  }

  async publish(
    id: string,
    input: RfqPublishInput,
    actorId: string,
  ): Promise<{ status: string }> {
    const rfq = await this.prisma.client.rfq.findUnique({
      where: { id },
      include: { lines: true, invitations: true },
    });
    if (!rfq) throw new NotFoundException('RFQ not found');
    if (rfq.status !== 'DRAFT') {
      throw new SourcingStateError('Only a draft RFQ can be published.', {
        status: rfq.status,
      });
    }
    if (rfq.lines.length < 1) {
      throw new SourcingValidationError('An RFQ needs at least one line.');
    }
    if (rfq.invitations.length < 2 && !input.spotBuyException) {
      throw new SourcingValidationError(
        'Single-source RFQ requires a spot-buy exemption + PLANT_HEAD approval.',
        { invitations: rfq.invitations.length },
      );
    }
    const weights = validateCriteriaWeights(
      rfq.evaluationCriteria as unknown as Array<{ weight: number }>,
    );
    if (!weights.valid) {
      throw new SourcingValidationError('Evaluation criteria weights must sum to 100.');
    }

    const tenant = await this.prisma.client.tenant.findUniqueOrThrow({
      where: { id: this.tenantId() },
    });
    const now = Date.now();
    const bidDeadline = new Date(input.bidDeadline);
    const minMs = tenant.rfqMinNoticeDays * 24 * 60 * 60 * 1000;
    if (bidDeadline.getTime() < now + minMs) {
      throw new SourcingValidationError(
        `Bid deadline must be at least ${tenant.rfqMinNoticeDays} days out.`,
      );
    }
    if (
      input.qaDeadline &&
      new Date(input.qaDeadline).getTime() > bidDeadline.getTime()
    ) {
      throw new SourcingValidationError('Q&A deadline must precede the bid deadline.');
    }
    if (
      rfq.rfqType === 'TWO_ENVELOPE' &&
      (!input.techOpenAt || !input.commercialOpenAt)
    ) {
      throw new SourcingValidationError(
        'Two-envelope RFQs require both tech-open and commercial-open dates.',
      );
    }

    const qaOpen = input.qaDeadline && new Date(input.qaDeadline).getTime() > now;
    const status = qaOpen ? 'Q_AND_A_OPEN' : 'BIDDING_OPEN';
    await this.prisma.client.rfq.update({
      where: { id },
      data: {
        status,
        publishedAt: new Date(),
        publishBy: new Date(),
        qaDeadline: input.qaDeadline ? new Date(input.qaDeadline) : null,
        bidDeadline,
        techOpenAt: input.techOpenAt ? new Date(input.techOpenAt) : null,
        commercialOpenAt: input.commercialOpenAt
          ? new Date(input.commercialOpenAt)
          : null,
        awardDeadline: input.awardDeadline ? new Date(input.awardDeadline) : null,
        spotBuyException: input.spotBuyException,
      },
    });

    for (const inv of rfq.invitations) {
      await this.notifyVendor(inv.vendorId, {
        type: 'RFQ_INVITED',
        title: `You are invited to bid on ${rfq.number}`,
        entityId: id,
        href: `/sourcing/${id}`,
      });
    }
    await this.audit.rfq('RFQ_PUBLISHED', id, actorId, {
      number: rfq.number,
      invitations: rfq.invitations.length,
      status,
    });
    await this.events.emit(SOURCING_EVENTS.RFQ_PUBLISHED, {
      rfqId: id,
      number: rfq.number,
      invitationCount: rfq.invitations.length,
    });
    return { status };
  }

  async issueCorrigendum(
    rfqId: string,
    input: RfqCorrigendumInput,
    actorId: string,
  ): Promise<{ id: string }> {
    const rfq = await this.requireRfq(rfqId);
    if (['AWARDED', 'CANCELLED'].includes(rfq.status)) {
      throw new SourcingStateError('Cannot issue a corrigendum on a closed RFQ.');
    }
    const number = rfq.corrigendaCount + 1;
    const id = newId('rfqCorrigendum');
    const extend =
      input.impact === 'DEADLINE_EXTENSION' && input.newBidDeadline
        ? new Date(input.newBidDeadline)
        : null;

    await this.prisma.client.rfqCorrigendum.create({
      data: {
        id,
        tenantId: this.tenantId(),
        rfqId,
        number,
        title: input.title,
        description: input.description,
        impact: input.impact,
        issuedBy: actorId,
        newBidDeadline: extend,
      },
    });

    const data: Prisma.RfqUpdateInput = { corrigendaCount: number };
    if (extend && rfq.bidDeadline) {
      const shiftMs = extend.getTime() - rfq.bidDeadline.getTime();
      data.bidDeadline = extend;
      if (rfq.techOpenAt) data.techOpenAt = new Date(rfq.techOpenAt.getTime() + shiftMs);
      if (rfq.commercialOpenAt) {
        data.commercialOpenAt = new Date(rfq.commercialOpenAt.getTime() + shiftMs);
      }
    }
    await this.prisma.client.rfq.update({ where: { id: rfqId }, data });

    // Vendors who already submitted must resubmit under the changed terms.
    const submitted = await this.prisma.client.quote.findMany({
      where: { rfqId, status: 'SUBMITTED' },
      select: { id: true, vendorId: true },
    });
    for (const q of submitted) {
      await this.prisma.client.quote.update({
        where: { id: q.id },
        data: { status: 'RESUBMISSION_REQUIRED' },
      });
    }
    const invitations = await this.prisma.client.rfqInvitation.findMany({
      where: { rfqId },
      select: { vendorId: true },
    });
    for (const inv of invitations) {
      await this.notifyVendor(inv.vendorId, {
        type: 'RFQ_CORRIGENDUM',
        title: `Corrigendum ${number} issued on ${rfq.number}`,
        entityId: rfqId,
        href: `/sourcing/${rfqId}`,
      });
    }
    await this.audit.rfq('RFQ_CORRIGENDUM_ISSUED', rfqId, actorId, {
      number,
      impact: input.impact,
      resubmissionRequired: submitted.length,
    });
    await this.events.emit(SOURCING_EVENTS.RFQ_CORRIGENDUM_ISSUED, {
      rfqId,
      number,
      impact: input.impact,
    });
    return { id };
  }

  async cancel(id: string, reason: string, actorId: string): Promise<{ ok: true }> {
    const rfq = await this.requireRfq(id);
    if (rfq.status === 'AWARDED') {
      throw new SourcingStateError('An awarded RFQ cannot be cancelled.');
    }
    if (rfq.status === 'CANCELLED') return { ok: true };
    await this.prisma.client.rfq.update({
      where: { id },
      data: { status: 'CANCELLED', cancelReason: reason },
    });
    const openQuotes = await this.prisma.client.quote.findMany({
      where: { rfqId: id, status: { in: ['DRAFT', 'SUBMITTED', 'OPENED', 'QUALIFIED'] } },
      select: { id: true, vendorId: true },
    });
    for (const q of openQuotes) {
      await this.prisma.client.quote.update({
        where: { id: q.id },
        data: { status: 'WITHDRAWN', withdrawalReason: 'RFQ cancelled' },
      });
      await this.notifyVendor(q.vendorId, {
        type: 'RFQ_CANCELLED',
        title: `${rfq.number} was cancelled`,
        entityId: id,
        href: `/sourcing/${id}`,
      });
    }
    await this.audit.rfq('RFQ_CANCELLED', id, actorId, { reason });
    await this.events.emit(SOURCING_EVENTS.RFQ_CANCELLED, { rfqId: id, reason });
    return { ok: true };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async buildLines(
    input: RfqCreateInput,
  ): Promise<Prisma.RfqLineCreateManyRfqInput[]> {
    const out: Prisma.RfqLineCreateManyRfqInput[] = [];
    let lineNo = 1;
    for (const line of input.lines) {
      let hsnCode = line.hsnCode ?? null;
      let taxRate = line.taxRate;
      let specDetails: Prisma.InputJsonValue | undefined =
        (line.specDetails as Prisma.InputJsonValue | undefined) ?? undefined;
      if (line.itemId) {
        const item = await this.prisma.client.item.findUnique({
          where: { id: line.itemId },
        });
        if (item) {
          hsnCode = hsnCode ?? item.hsnCode;
          taxRate = line.taxRate === '0' ? item.gstRate.toString() : line.taxRate;
          specDetails =
            specDetails ??
            (item.qcParameters as Prisma.InputJsonValue | undefined) ??
            undefined;
        }
      }
      out.push({
        id: newId('rfqLine'),
        tenantId: this.tenantId(),
        lineNo: lineNo++,
        itemId: line.itemId ?? null,
        itemDesc: line.itemDesc,
        uom: line.uom,
        qtyRequired: new Prisma.Decimal(line.qtyRequired),
        qtyMinSplit: new Prisma.Decimal(line.qtyMinSplit),
        hsnCode,
        taxRate: new Prisma.Decimal(taxRate),
        specDetails: specDetails as Prisma.InputJsonValue,
        deliveryDateRequired: line.deliveryDateRequired
          ? new Date(line.deliveryDateRequired)
          : null,
        unitCostEstimate: line.unitCostEstimate
          ? new Prisma.Decimal(line.unitCostEstimate)
          : null,
        unitWeightKg: line.unitWeightKg ? new Prisma.Decimal(line.unitWeightKg) : null,
      });
    }
    return out;
  }

  private async assertPrLinkable(
    requisitionId: string,
    lines: RfqCreateInput['lines'],
  ): Promise<void> {
    const pr = await this.prisma.client.requisition.findUnique({
      where: { id: requisitionId },
      include: { lines: true },
    });
    if (!pr) throw new NotFoundException('Linked requisition not found');
    if (pr.status !== 'APPROVED' && pr.status !== 'PARTIALLY_ISSUED') {
      throw new SourcingStateError(
        'Only an approved (or partially issued) PR can seed an RFQ.',
        { status: pr.status },
      );
    }
    for (const line of lines) {
      if (!line.itemId) continue;
      const prLine = pr.lines.find((l) => l.itemId === line.itemId);
      if (!prLine) continue;
      const remaining = prLine.qty.minus(prLine.qtyIssued);
      if (new Prisma.Decimal(line.qtyRequired).greaterThan(remaining)) {
        throw new SourcingValidationError(
          'RFQ line quantity exceeds the linked PR line remaining quantity.',
          { itemId: line.itemId, remaining: remaining.toString() },
        );
      }
    }
  }

  private async notifyVendor(
    vendorId: string,
    n: { type: string; title: string; entityId: string; href: string },
  ): Promise<void> {
    const contact = await this.prisma.client.vendorContact.findFirst({
      where: { vendorId, isPrimary: true },
      select: { email: true },
    });
    const email = contact?.email;
    if (!email) return;
    const user = await this.prisma.client.user.findFirst({
      where: { tenantId: this.tenantId(), email },
      select: { id: true },
    });
    if (!user) return;
    await this.notifications.notify({
      userId: user.id,
      type: n.type,
      title: n.title,
      entityType: 'Rfq',
      entityId: n.entityId,
      href: n.href,
    });
  }

  private async requireRfq(
    id: string,
  ): Promise<Prisma.RfqGetPayload<Record<string, never>>> {
    const rfq = await this.prisma.client.rfq.findUnique({ where: { id } });
    if (!rfq) throw new NotFoundException('RFQ not found');
    return rfq;
  }

  private tenantId(): string {
    const tid = this.prisma.currentTenantId;
    if (!tid) throw new Error('No tenant context');
    return tid;
  }
}
