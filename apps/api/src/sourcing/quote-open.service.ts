import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, newId, type Quote } from '@procureflow/db';
import {
  RBI_REFERENCE_RATES,
  SOURCING_EVENTS,
  normalise,
  type Incoterm,
  type QuoteQualifyInput,
} from '@procureflow/shared';
import Decimal from 'decimal.js';

import { NotificationService } from '../approvals/notification.service';
import { DomainEventService } from '../common/events/domain-event.service';
import { PrismaService } from '../prisma/prisma.service';
import { SourcingAuditService } from './sourcing-audit.service';
import { OpenQuorumError, SourcingStateError } from './sourcing.errors';

type QuoteWithLines = Quote & {
  lines: Prisma.QuoteLineGetPayload<Record<string, never>>[];
};

/**
 * QuoteOpenService (Slice 6 §5). Runs the sealed-quote opening ceremony:
 * multi-party quorum above the tenant threshold, a witnessed QuoteOpenLog per
 * quote, technical-then-commercial gating for two-envelope RFQs, and
 * landed-cost normalisation at commercial open.
 */
@Injectable()
export class QuoteOpenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: SourcingAuditService,
    private readonly events: DomainEventService,
    private readonly notifications: NotificationService,
  ) {}

  async openTechnical(
    rfqId: string,
    participantUserIds: string[],
    actorId: string,
  ): Promise<{ opened: number }> {
    const rfq = await this.requireRfq(rfqId);
    if (rfq.rfqType !== 'TWO_ENVELOPE') {
      throw new SourcingStateError('Technical open applies to two-envelope RFQs only.');
    }
    this.assertBidClosed(rfq.bidDeadline);
    await this.assertQuorum(rfq.tenantId, rfq.estimatedValue, participantUserIds);

    const quotes = await this.prisma.client.quote.findMany({
      where: { rfqId, status: 'SUBMITTED' },
    });
    for (const q of quotes) {
      await this.markOpened(q, 'TECHNICAL', participantUserIds);
    }
    await this.prisma.client.rfq.update({
      where: { id: rfqId },
      data: { status: 'TECH_OPEN' },
    });
    await this.audit.rfq('QUOTES_OPENED_TECHNICAL', rfqId, actorId, {
      participants: participantUserIds,
      quoteCount: quotes.length,
    });
    await this.events.emit(SOURCING_EVENTS.QUOTE_OPENED, {
      rfqId,
      envelope: 'TECHNICAL',
      quoteCount: quotes.length,
      participants: participantUserIds,
    });
    return { opened: quotes.length };
  }

  async qualifyTechnically(
    quoteId: string,
    input: QuoteQualifyInput,
    actorId: string,
  ): Promise<{ ok: true }> {
    const quote = await this.prisma.client.quote.findUnique({
      where: { id: quoteId },
      include: { invitation: true },
    });
    if (!quote) throw new NotFoundException('Quote not found');
    if (quote.status !== 'OPENED') {
      throw new SourcingStateError('Only an opened quote can be technically qualified.', {
        status: quote.status,
      });
    }
    const qualified = input.decision === 'QUALIFIED';
    await this.prisma.client.quote.update({
      where: { id: quoteId },
      data: {
        status: qualified ? 'QUALIFIED' : 'DISQUALIFIED_TECH',
        techQualifiedAt: new Date(),
        techQualifyNotes: input.notes ?? null,
      },
    });
    if (!qualified) {
      await this.prisma.client.rfqInvitation.update({
        where: { id: quote.invitationId },
        data: { status: 'DISQUALIFIED' },
      });
    }
    await this.audit.quote(
      qualified ? 'QUOTE_TECH_QUALIFIED' : 'QUOTE_TECH_DISQUALIFIED',
      quoteId,
      actorId,
      { notes: input.notes ?? null },
    );
    await this.notifyVendor(
      quote.vendorId,
      quote.rfqId,
      qualified ? 'Your technical bid qualified' : 'Your technical bid did not qualify',
    );
    return { ok: true };
  }

  async openCommercial(
    rfqId: string,
    participantUserIds: string[],
    actorId: string,
  ): Promise<{ opened: number }> {
    const rfq = await this.requireRfq(rfqId);
    if (rfq.rfqType === 'TWO_ENVELOPE') {
      if (rfq.status !== 'TECH_OPEN') {
        throw new SourcingStateError('Open the technical envelope first.');
      }
    } else if (rfq.rfqType === 'SINGLE_ENVELOPE') {
      this.assertBidClosed(rfq.bidDeadline);
    } else {
      throw new SourcingStateError(
        'Commercial open applies to single/two-envelope RFQs.',
      );
    }
    await this.assertQuorum(rfq.tenantId, rfq.estimatedValue, participantUserIds);

    // Two-envelope: only QUALIFIED quotes. Single: all submitted.
    const status = rfq.rfqType === 'TWO_ENVELOPE' ? 'QUALIFIED' : 'SUBMITTED';
    const quotes = await this.prisma.client.quote.findMany({
      where: { rfqId, status },
      include: { lines: true },
    });
    const rfqLines = await this.prisma.client.rfqLine.findMany({ where: { rfqId } });
    const vendor = new Map(
      (
        await this.prisma.client.vendor.findMany({
          where: { id: { in: quotes.map((q) => q.vendorId) } },
          select: { id: true, gstin: true },
        })
      ).map((v) => [v.id, v.gstin]),
    );

    for (const q of quotes) {
      // Single-envelope has no prior technical open — mark opened here.
      if (rfq.rfqType === 'SINGLE_ENVELOPE' && q.status === 'SUBMITTED') {
        await this.prisma.client.quote.update({
          where: { id: q.id },
          data: { status: 'OPENED', openedAt: new Date() },
        });
      }
      await this.revealCommercial(
        q,
        rfqLines,
        vendor.get(q.vendorId) ?? null,
        participantUserIds,
      );
    }
    await this.prisma.client.rfq.update({
      where: { id: rfqId },
      data: { status: 'COMMERCIAL_OPEN' },
    });
    await this.audit.rfq('QUOTES_OPENED_COMMERCIAL', rfqId, actorId, {
      participants: participantUserIds,
      quoteCount: quotes.length,
    });
    await this.events.emit(SOURCING_EVENTS.QUOTE_OPENED, {
      rfqId,
      envelope: 'COMMERCIAL',
      quoteCount: quotes.length,
      participants: participantUserIds,
    });
    return { opened: quotes.length };
  }

  /** Single-envelope: open + reveal commercial in one witnessed step. */
  async openSingle(
    rfqId: string,
    participantUserIds: string[],
    actorId: string,
  ): Promise<{ opened: number }> {
    const rfq = await this.requireRfq(rfqId);
    if (rfq.rfqType !== 'SINGLE_ENVELOPE') {
      throw new SourcingStateError('Single open applies to single-envelope RFQs only.');
    }
    this.assertBidClosed(rfq.bidDeadline);
    await this.assertQuorum(rfq.tenantId, rfq.estimatedValue, participantUserIds);
    const quotes = await this.prisma.client.quote.findMany({
      where: { rfqId, status: 'SUBMITTED' },
      include: { lines: true },
    });
    for (const q of quotes) {
      await this.markOpened(q, 'COMMERCIAL', participantUserIds);
    }
    const rfqLines = await this.prisma.client.rfqLine.findMany({ where: { rfqId } });
    const vendors = new Map(
      (
        await this.prisma.client.vendor.findMany({
          where: { id: { in: quotes.map((q) => q.vendorId) } },
          select: { id: true, gstin: true },
        })
      ).map((v) => [v.id, v.gstin]),
    );
    for (const q of quotes) {
      await this.revealCommercial(
        q,
        rfqLines,
        vendors.get(q.vendorId) ?? null,
        participantUserIds,
        false,
      );
    }
    await this.prisma.client.rfq.update({
      where: { id: rfqId },
      data: { status: 'COMMERCIAL_OPEN' },
    });
    await this.audit.rfq('QUOTES_OPENED_SINGLE', rfqId, actorId, {
      participants: participantUserIds,
      quoteCount: quotes.length,
    });
    return { opened: quotes.length };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async markOpened(
    quote: Quote,
    envelope: 'TECHNICAL' | 'COMMERCIAL',
    participants: string[],
  ): Promise<void> {
    await this.prisma.client.quote.update({
      where: { id: quote.id },
      data: { status: 'OPENED', openedAt: new Date() },
    });
    await this.writeOpenLog(quote, envelope, participants);
  }

  private async revealCommercial(
    quote: QuoteWithLines,
    rfqLines: Prisma.RfqLineGetPayload<Record<string, never>>[],
    vendorGstin: string | null,
    participants: string[],
    log = true,
  ): Promise<void> {
    const rfqLineById = new Map(rfqLines.map((l) => [l.id, l]));
    const originState =
      quote.currency === 'INR' ? (vendorGstin?.slice(0, 2) ?? '27') : 'FOREIGN';
    let total = new Decimal(0);
    for (const line of quote.lines) {
      const rfqLine = rfqLineById.get(line.rfqLineId);
      const { unitPriceInrLanded, breakdown } = normalise(
        {
          unitPriceNative: line.unitPriceNative.toString(),
          currency: quote.currency,
          incoterm: quote.incoterm as Incoterm,
          originState,
          hsnCode: rfqLine?.hsnCode ?? null,
          unitWeightKg: rfqLine?.unitWeightKg?.toString(),
        },
        { exchangeRates: RBI_REFERENCE_RATES },
      );
      const lineTotal = new Decimal(unitPriceInrLanded)
        .times(line.qtyQuoted.toString())
        .times(new Decimal(1).minus(line.discountPct.toString()))
        .times(new Decimal(1).plus(line.taxRate.toString()));
      total = total.plus(lineTotal);
      await this.prisma.client.quoteLine.update({
        where: { id: line.id },
        data: {
          unitPriceInrLanded: new Prisma.Decimal(unitPriceInrLanded),
          landedBreakdown: breakdown as unknown as Prisma.InputJsonValue,
        },
      });
    }
    await this.prisma.client.quote.update({
      where: { id: quote.id },
      data: { totalCommercialValue: new Prisma.Decimal(total.toFixed(4)) },
    });
    if (log) await this.writeOpenLog(quote, 'COMMERCIAL', participants);
  }

  private async writeOpenLog(
    quote: Quote,
    envelope: 'TECHNICAL' | 'COMMERCIAL',
    participants: string[],
  ): Promise<void> {
    await this.prisma.client.quoteOpenLog.create({
      data: {
        id: newId('quoteOpenLog'),
        tenantId: quote.tenantId,
        quoteId: quote.id,
        envelope,
        participants: participants as unknown as Prisma.InputJsonValue,
        hashBefore: quote.submissionHash,
        hashAfter: quote.submissionHash,
      },
    });
  }

  private async assertQuorum(
    tenantId: string,
    estimatedValue: Prisma.Decimal,
    participantUserIds: string[],
  ): Promise<void> {
    const tenant = await this.prisma.client.tenant.findUniqueOrThrow({
      where: { id: tenantId },
    });
    if (
      new Decimal(estimatedValue.toString()).lessThan(
        tenant.rfqMultiPartyOpenThreshold.toString(),
      )
    ) {
      return; // below threshold — a single participant may open
    }
    if (participantUserIds.length < 2) {
      throw new OpenQuorumError(
        'This RFQ is above the multi-party threshold — opening requires at least 2 participants from different roles.',
        { threshold: tenant.rfqMultiPartyOpenThreshold.toString() },
      );
    }
    const roleSets = await Promise.all(participantUserIds.map((id) => this.rolesOf(id)));
    const distinctRoles = new Set(roleSets.flat());
    if (distinctRoles.size < 2) {
      throw new OpenQuorumError(
        'The multi-party quorum requires participants from at least two different roles.',
      );
    }
  }

  private async rolesOf(userId: string): Promise<string[]> {
    const rows = await this.prisma.client.userRole.findMany({
      where: { userId },
      include: { role: { select: { name: true } } },
    });
    return rows.map((r) => r.role.name);
  }

  private assertBidClosed(bidDeadline: Date | null): void {
    if (!bidDeadline || bidDeadline.getTime() > Date.now()) {
      throw new SourcingStateError('The bid deadline has not passed yet.');
    }
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
      type: 'RFQ_TECH_RESULT',
      title,
      entityType: 'Rfq',
      entityId: rfqId,
      href: `/sourcing/${rfqId}`,
    });
  }

  private async requireRfq(
    id: string,
  ): Promise<Prisma.RfqGetPayload<Record<string, never>>> {
    const rfq = await this.prisma.client.rfq.findUnique({ where: { id } });
    if (!rfq) throw new NotFoundException('RFQ not found');
    return rfq;
  }
}
