import { Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { Prisma, newId } from '@procureflow/db';
import {
  SOURCING_EVENTS,
  type AwardRecommendInput,
  type Incoterm,
  type PaymentTerms,
} from '@procureflow/shared';
import Decimal from 'decimal.js';

import { ApprovalRoutingService } from '../approvals/approval-routing.service';
import { NotificationService } from '../approvals/notification.service';
import { DomainEventService } from '../common/events/domain-event.service';
import { PrismaService } from '../prisma/prisma.service';
import { PurchaseOrderService } from '../purchase-orders/purchase-order.service';
import { SourcingAuditService } from './sourcing-audit.service';
import {
  SourcingStateError,
  SourcingValidationError,
  VarianceJustificationError,
} from './sourcing.errors';

/**
 * AwardService (Slice 6 §9). Records a single- or split-award recommendation
 * with L1-variance justification, routes it through the Slice 2 approval engine
 * (RFQ_AWARD document type), and — on approval — creates the PO(s) via Slice 4's
 * createFromRequisition (or a spot-buy PO for a standalone RFQ).
 */
@Injectable()
export class AwardService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: SourcingAuditService,
    private readonly events: DomainEventService,
    private readonly routing: ApprovalRoutingService,
    private readonly notifications: NotificationService,
    private readonly purchaseOrders: PurchaseOrderService,
  ) {}

  onModuleInit(): void {
    this.routing.onApproved('RFQ_AWARD', (awardId, actorId) =>
      this.onApproved(awardId, actorId),
    );
  }

  async recommendAward(
    rfqId: string,
    input: AwardRecommendInput,
    actorId: string,
  ): Promise<{ id: string }> {
    const rfq = await this.prisma.client.rfq.findUnique({
      where: { id: rfqId },
      include: { lines: true },
    });
    if (!rfq) throw new NotFoundException('RFQ not found');
    if (!['COMMERCIAL_OPEN', 'EVALUATION'].includes(rfq.status)) {
      throw new SourcingStateError(
        'An award can only be recommended after commercial open.',
        {
          status: rfq.status,
        },
      );
    }

    const quotes = await this.prisma.client.quote.findMany({
      where: { rfqId, status: { in: ['QUALIFIED', 'OPENED'] } },
    });
    const quoteById = new Map(quotes.map((q) => [q.id, q]));
    const lineById = new Map(rfq.lines.map((l) => [l.id, l]));

    // Per-line allocation cannot exceed required qty; min-split respected.
    const perLine = new Map<string, Decimal>();
    for (const a of input.allocations) {
      const quote = quoteById.get(a.quoteId);
      if (!quote) {
        throw new SourcingValidationError(
          'Allocation references a non-qualified quote.',
          {
            quoteId: a.quoteId,
          },
        );
      }
      const line = lineById.get(a.rfqLineId);
      if (!line)
        throw new SourcingValidationError('Allocation references an unknown line.');
      const running = (perLine.get(a.rfqLineId) ?? new Decimal(0)).plus(a.qtyAllocated);
      perLine.set(a.rfqLineId, running);
      if (running.greaterThan(line.qtyRequired.toString())) {
        throw new SourcingValidationError(
          'Allocated quantity exceeds the line requirement.',
          {
            rfqLineId: a.rfqLineId,
          },
        );
      }
      if (
        line.qtyMinSplit.greaterThan(0) &&
        new Decimal(a.qtyAllocated).lessThan(line.qtyMinSplit.toString())
      ) {
        throw new SourcingValidationError(
          'Allocation is below the minimum split quantity.',
          {
            rfqLineId: a.rfqLineId,
          },
        );
      }
    }

    // L1 = lowest total commercial value. Non-L1 award needs justification.
    const l1QuoteId = this.l1QuoteId(quotes);
    const awardedNonL1 = input.allocations.some(
      (a) => l1QuoteId && a.quoteId !== l1QuoteId,
    );
    if (awardedNonL1 && !input.varianceFromL1Reason) {
      throw new VarianceJustificationError(
        'Awarding away from L1 requires a documented variance-from-L1 justification.',
      );
    }

    const id = newId('award');
    let total = new Decimal(0);
    const allocations = input.allocations.map((a) => {
      const totalValue = new Decimal(a.qtyAllocated).times(a.unitPrice);
      total = total.plus(totalValue);
      return {
        id: newId('awardAllocation'),
        tenantId: rfq.tenantId,
        awardId: id,
        quoteId: a.quoteId,
        vendorId: quoteById.get(a.quoteId)!.vendorId,
        rfqLineId: a.rfqLineId,
        qtyAllocated: new Prisma.Decimal(a.qtyAllocated),
        unitPrice: new Prisma.Decimal(a.unitPrice),
        totalValue: new Prisma.Decimal(totalValue.toFixed(4)),
      };
    });

    // I6: only lifecycle-ACTIVE vendors with a verified bank may be recommended
    // for award — they will receive a PO on approval. Fail before persisting.
    for (const vId of new Set(allocations.map((a) => a.vendorId))) {
      await this.purchaseOrders.assertVendorEligible(vId);
    }

    await this.prisma.client.award.create({
      data: {
        id,
        tenantId: rfq.tenantId,
        rfqId,
        recommendationBy: actorId,
        recommendationNotes: input.notes ?? null,
        varianceFromL1Reason: input.varianceFromL1Reason ?? null,
        totalValue: new Prisma.Decimal(total.toFixed(4)),
        status: 'RECOMMENDED',
        allocations: { createMany: { data: allocations } },
      },
    });
    await this.prisma.client.rfq.update({
      where: { id: rfqId },
      data: { status: 'EVALUATION' },
    });
    await this.audit.award('AWARD_RECOMMENDED', id, actorId, {
      rfqId,
      total: total.toFixed(4),
      vendorCount: new Set(allocations.map((a) => a.vendorId)).size,
      varianceFromL1: input.varianceFromL1Reason ?? null,
    });
    await this.events.emit(SOURCING_EVENTS.AWARD_RECOMMENDED, {
      awardId: id,
      rfqId,
      vendorIds: [...new Set(allocations.map((a) => a.vendorId))],
      totalValue: total.toFixed(4),
    });
    return { id };
  }

  async submitForApproval(awardId: string, actorId: string): Promise<{ ok: true }> {
    const award = await this.prisma.client.award.findUnique({ where: { id: awardId } });
    if (!award) throw new NotFoundException('Award not found');
    if (award.status !== 'RECOMMENDED') {
      throw new SourcingStateError('Only a recommended award can be submitted.', {
        status: award.status,
      });
    }
    await this.prisma.client.rfq.update({
      where: { id: award.rfqId },
      data: { status: 'AWARD_PENDING' },
    });
    await this.routing.submit('RFQ_AWARD', awardId, actorId);
    return { ok: true };
  }

  async decide(
    approvalId: string,
    action: 'APPROVE' | 'REJECT' | 'CHANGES',
    comment: string | null,
    actorId: string,
  ): Promise<{ ok: true }> {
    const mapped = action === 'CHANGES' ? 'REQUEST_CHANGES' : action;
    await this.routing.decide(approvalId, mapped, comment, actorId);
    return { ok: true };
  }

  async cancel(awardId: string, reason: string, actorId: string): Promise<{ ok: true }> {
    const award = await this.prisma.client.award.findUnique({ where: { id: awardId } });
    if (!award) throw new NotFoundException('Award not found');
    if (award.status !== 'RECOMMENDED') {
      throw new SourcingStateError('Only a pre-approval award can be cancelled.');
    }
    await this.prisma.client.award.update({
      where: { id: awardId },
      data: { status: 'REJECTED' },
    });
    await this.audit.award('AWARD_CANCELLED', awardId, actorId, { reason });
    return { ok: true };
  }

  /** Fired by the approval engine when the award is fully approved. */
  async onApproved(awardId: string, actorId: string): Promise<void> {
    const award = await this.prisma.client.award.findUnique({
      where: { id: awardId },
      include: { allocations: true, rfq: { include: { lines: true } } },
    });
    if (!award) return;
    // I6: re-check every awarded vendor is still lifecycle-ACTIVE BEFORE moving
    // the award/RFQ to terminal state. A vendor suspended between recommendation
    // and approval must not yield a PO — and failing here (rather than mid-loop)
    // keeps the award re-runnable instead of leaving orphaned allocations.
    for (const vId of new Set(award.allocations.map((a) => a.vendorId))) {
      await this.purchaseOrders.assertVendorEligible(vId);
    }
    await this.prisma.client.award.update({
      where: { id: awardId },
      data: { status: 'APPROVED', approvedAt: new Date(), approvedBy: actorId },
    });
    await this.prisma.client.rfq.update({
      where: { id: award.rfqId },
      data: { status: 'AWARDED' },
    });

    const byVendor = new Map<string, typeof award.allocations>();
    for (const a of award.allocations) {
      byVendor.set(a.vendorId, [...(byVendor.get(a.vendorId) ?? []), a]);
    }
    const rfq = award.rfq;
    const paymentTerms: PaymentTerms = { kind: 'NET_45' };
    const expected =
      rfq.lines[0]?.deliveryDateRequired ??
      new Date(Date.now() + 45 * 24 * 60 * 60 * 1000);

    for (const [vendorId, allocs] of byVendor) {
      let poId: string | null = null;
      if (rfq.requisitionId) {
        const pr = await this.prisma.client.requisition.findUnique({
          where: { id: rfq.requisitionId },
          include: { lines: true },
        });
        const lines = allocs
          .map((a) => {
            const rfqLine = rfq.lines.find((l) => l.id === a.rfqLineId);
            const prLine = pr?.lines.find(
              (pl) => pl.itemId && pl.itemId === rfqLine?.itemId,
            );
            if (!prLine) return null;
            return {
              prLineId: prLine.id,
              qtyOrdered: a.qtyAllocated.toString(),
              unitPrice: a.unitPrice.toString(),
            };
          })
          .filter((l): l is NonNullable<typeof l> => l !== null);
        if (lines.length > 0 && pr) {
          const created = await this.purchaseOrders.createFromRequisition(
            {
              kind: 'FROM_PR',
              requisitionId: rfq.requisitionId,
              vendorId,
              deliveryTerms: rfq.incotermDefault as Incoterm,
              paymentTerms,
              expectedDeliveryDate: expected.toISOString(),
              lines,
              // The award screen has no duplicate-confirm step to send the buyer
              // back to, so a match here is recorded on the audit trail rather
              // than blocking an award that has already been decided.
              confirmDuplicate: true,
            },
            actorId,
          );
          poId = created.id;
        }
      }
      if (!poId) {
        poId = await this.createSpotBuyPo(rfq, vendorId, allocs, actorId, expected);
      }
      if (poId) {
        for (const a of allocs) {
          await this.prisma.client.awardAllocation.update({
            where: { id: a.id },
            data: { poId },
          });
        }
      }
      await this.notifyVendor(
        vendorId,
        award.rfqId,
        `Congratulations — you were awarded on ${rfq.number}`,
      );
    }

    // Non-awarded invited vendors get a thank-you note.
    const awardedVendors = new Set(award.allocations.map((a) => a.vendorId));
    const invitations = await this.prisma.client.rfqInvitation.findMany({
      where: { rfqId: award.rfqId, status: { in: ['QUOTE_SUBMITTED', 'DISQUALIFIED'] } },
    });
    for (const inv of invitations) {
      if (awardedVendors.has(inv.vendorId)) continue;
      await this.notifyVendor(
        inv.vendorId,
        award.rfqId,
        `Thank you for bidding on ${rfq.number}`,
      );
    }

    await this.audit.award('AWARD_APPROVED', awardId, actorId, { rfqId: award.rfqId });
    await this.events.emit(SOURCING_EVENTS.AWARD_APPROVED, {
      awardId,
      rfqId: award.rfqId,
    });
  }

  private async createSpotBuyPo(
    rfq: Prisma.RfqGetPayload<{ include: { lines: true } }>,
    vendorId: string,
    allocs: Prisma.AwardAllocationGetPayload<Record<string, never>>[],
    actorId: string,
    expected: Date,
  ): Promise<string | null> {
    const costCenter = await this.prisma.client.costCenter.findFirst({
      where: { tenantId: rfq.tenantId },
      select: { id: true },
    });
    if (!costCenter) return null;
    const lines = allocs.map((a) => {
      const rfqLine = rfq.lines.find((l) => l.id === a.rfqLineId);
      return {
        itemId: rfqLine?.itemId ?? null,
        itemDesc: rfqLine?.itemDesc ?? 'Awarded item',
        hsnCode: rfqLine?.hsnCode ?? null,
        uom: rfqLine?.uom ?? 'NOS',
        qtyOrdered: a.qtyAllocated.toString(),
        unitPrice: a.unitPrice.toString(),
        discountPct: '0',
        taxRate: rfqLine?.taxRate.toString() ?? '0',
      };
    });
    const created = await this.purchaseOrders.createSpotBuy(
      {
        kind: 'SPOT_BUY',
        vendorId,
        costCenterId: costCenter.id,
        deliveryTerms: rfq.incotermDefault as Incoterm,
        paymentTerms: { kind: 'NET_45' },
        expectedDeliveryDate: expected.toISOString(),
        lines,
        // As above — the award is already decided; a duplicate is audited, not blocked.
        confirmDuplicate: true,
      },
      actorId,
    );
    return created.id;
  }

  private l1QuoteId(
    quotes: Prisma.QuoteGetPayload<Record<string, never>>[],
  ): string | null {
    const valued = quotes.filter((q) => q.totalCommercialValue != null);
    if (valued.length === 0) return null;
    return valued.reduce((min, q) =>
      new Decimal(q.totalCommercialValue!.toString()).lessThan(
        min.totalCommercialValue!.toString(),
      )
        ? q
        : min,
    ).id;
  }

  private async notifyVendor(
    vendorId: string,
    rfqId: string,
    title: string,
  ): Promise<void> {
    const contact = await this.prisma.client.vendorContact.findFirst({
      where: { vendorId, isPrimary: true },
      select: { email: true },
    });
    if (!contact?.email) return;
    const user = await this.prisma.client.user.findFirst({
      where: { tenantId: this.prisma.currentTenantId ?? undefined, email: contact.email },
      select: { id: true },
    });
    if (!user) return;
    await this.notifications.notify({
      userId: user.id,
      type: 'RFQ_AWARD_RESULT',
      title,
      entityType: 'Rfq',
      entityId: rfqId,
      href: `/sourcing/${rfqId}`,
    });
  }
}
