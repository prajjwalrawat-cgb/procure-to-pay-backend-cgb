import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, newId } from '@procureflow/db';
import {
  SOURCING_EVENTS,
  type ReverseAuctionBidInput,
  type ReverseAuctionLeaderboardEntry,
  type ReverseAuctionStartInput,
} from '@procureflow/shared';
import Decimal from 'decimal.js';
import { Observable, Subject, from, switchMap } from 'rxjs';

import { NotificationService } from '../approvals/notification.service';
import { DomainEventService } from '../common/events/domain-event.service';
import { PrismaService } from '../prisma/prisma.service';
import { SourcingAuditService } from './sourcing-audit.service';
import { ReverseAuctionError, SourcingStateError } from './sourcing.errors';
import { VendorResolverService } from './vendor-resolver.service';

interface LeaderboardEvent {
  data: {
    roundId: string;
    leaderboard: ReverseAuctionLeaderboardEntry[];
    extended: boolean;
  };
}

/**
 * ReverseAuctionService (Slice 6 §8). A live descending-price round after the
 * initial sealed submission. Enforces decrement-min, round-live, and
 * qualified-vendor guards, auto-extends on last-N-second bids, and broadcasts an
 * anonymised leaderboard over SSE. Frontend polish is deferred to Slice 6.5.
 */
@Injectable()
export class ReverseAuctionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: SourcingAuditService,
    private readonly events: DomainEventService,
    private readonly notifications: NotificationService,
    private readonly vendors: VendorResolverService,
  ) {}

  /** Per-round broadcast channels for the SSE leaderboard. */
  private readonly channels = new Map<string, Subject<LeaderboardEvent>>();

  /** Vendor-facing bid: resolves the vendor from the JWT, then places the bid. */
  async submitBidAsUser(
    roundId: string,
    input: ReverseAuctionBidInput,
    userId: string,
  ): Promise<{ accepted: true; extended: boolean }> {
    const vendorId = await this.vendors.resolveVendorId(userId);
    return this.submitBid(roundId, input, userId, vendorId);
  }

  /** Anonymised vendor-facing SSE stream. */
  streamForUser(roundId: string, userId: string): Observable<LeaderboardEvent> {
    return from(this.vendors.resolveVendorId(userId)).pipe(
      switchMap((vendorId) => this.stream(roundId, vendorId)),
    );
  }

  async startRound(
    rfqId: string,
    input: ReverseAuctionStartInput,
    actorId: string,
  ): Promise<{ id: string }> {
    const rfq = await this.prisma.client.rfq.findUnique({ where: { id: rfqId } });
    if (!rfq) throw new NotFoundException('RFQ not found');
    if (!rfq.isReverseAuction) {
      throw new SourcingStateError('This RFQ is not a reverse auction.');
    }
    const last = await this.prisma.client.reverseAuctionRound.findFirst({
      where: { rfqId },
      orderBy: { roundNo: 'desc' },
      select: { roundNo: true },
    });
    const id = newId('reverseAuctionRound');
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(startsAt.getTime() + input.durationMinutes * 60 * 1000);
    await this.prisma.client.reverseAuctionRound.create({
      data: {
        id,
        tenantId: rfq.tenantId,
        rfqId,
        roundNo: (last?.roundNo ?? 0) + 1,
        startsAt,
        endsAt,
        startingPrice: new Prisma.Decimal(input.startingPrice),
        decrementMin: new Prisma.Decimal(input.decrementMin),
        decrementMax: input.decrementMax ? new Prisma.Decimal(input.decrementMax) : null,
        extensionSeconds: input.extensionSeconds,
        status: startsAt.getTime() <= Date.now() ? 'LIVE' : 'SCHEDULED',
        createdBy: actorId,
      },
    });
    // Notify qualified vendors 15 minutes before start (Slice 10 emails).
    const quotes = await this.prisma.client.quote.findMany({
      where: { rfqId, status: { in: ['QUALIFIED', 'OPENED'] } },
      select: { vendorId: true },
    });
    for (const q of quotes) {
      await this.notifyVendor(
        q.vendorId,
        rfqId,
        `Reverse auction scheduled for ${rfq.number}`,
      );
    }
    await this.audit.rfq('REVERSE_AUCTION_ROUND_STARTED', rfqId, actorId, {
      roundId: id,
    });
    await this.events.emit(SOURCING_EVENTS.REVERSE_AUCTION_ROUND_STARTED, {
      roundId: id,
      rfqId,
      roundNo: (last?.roundNo ?? 0) + 1,
      startingPrice: input.startingPrice,
    });
    return { id };
  }

  async submitBid(
    roundId: string,
    input: ReverseAuctionBidInput,
    actorId: string,
    vendorId: string,
  ): Promise<{ accepted: true; extended: boolean }> {
    const round = await this.prisma.client.reverseAuctionRound.findUnique({
      where: { id: roundId },
    });
    if (!round) throw new NotFoundException('Round not found');
    this.assertLive(round);

    const quote = await this.prisma.client.quote.findUnique({
      where: { id: input.quoteId },
    });
    if (!quote || quote.vendorId !== vendorId) {
      throw new ReverseAuctionError('Quote does not belong to this vendor.');
    }
    if (!['QUALIFIED', 'OPENED'].includes(quote.status)) {
      throw new ReverseAuctionError('Only a qualified quote can bid.');
    }

    const bid = new Decimal(input.bidPrice);
    const leaderPrice = await this.currentLeaderPrice(roundId, round);
    const maxAllowed = leaderPrice.minus(round.decrementMin.toString());
    if (bid.greaterThan(maxAllowed)) {
      throw new ReverseAuctionError(
        `Bid must be at least the minimum decrement below the current leader (${maxAllowed.toFixed(2)}).`,
        { leaderPrice: leaderPrice.toFixed(2) },
      );
    }

    await this.prisma.client.reverseAuctionBid.create({
      data: {
        id: newId('reverseAuctionBid'),
        tenantId: round.tenantId,
        roundId,
        quoteId: input.quoteId,
        vendorId,
        bidPrice: new Prisma.Decimal(input.bidPrice),
      },
    });

    // Auto-extend when a bid lands in the last extensionSeconds.
    const now = Date.now();
    const remaining = (round.endsAt.getTime() - now) / 1000;
    let extended = false;
    if (round.extensionSeconds > 0 && remaining <= round.extensionSeconds) {
      await this.prisma.client.reverseAuctionRound.update({
        where: { id: roundId },
        data: { endsAt: new Date(now + round.extensionSeconds * 1000) },
      });
      extended = true;
    }
    await this.prisma.client.reverseAuctionRound.update({
      where: { id: roundId },
      data: { currentLeaderId: vendorId },
    });
    await this.audit.rfq('REVERSE_AUCTION_BID_PLACED', round.rfqId, actorId, {
      roundId,
      bidPrice: input.bidPrice,
      extended,
    });
    await this.events.emit(SOURCING_EVENTS.REVERSE_AUCTION_BID_PLACED, {
      roundId,
      quoteId: input.quoteId,
      vendorId,
      bidPrice: input.bidPrice,
      extended,
    });
    const leaderboard = await this.leaderboard(roundId, null);
    this.channel(roundId).next({ data: { roundId, leaderboard, extended } });
    return { accepted: true, extended };
  }

  async endRound(roundId: string): Promise<{ ok: true }> {
    const round = await this.prisma.client.reverseAuctionRound.findUnique({
      where: { id: roundId },
    });
    if (!round) throw new NotFoundException('Round not found');
    // Set each vendor's winning (lowest) bid onto their quote total.
    const bids = await this.prisma.client.reverseAuctionBid.findMany({
      where: { roundId, isValid: true },
      orderBy: { bidPrice: 'asc' },
    });
    const bestByQuote = new Map<string, Decimal>();
    for (const b of bids) {
      const cur = bestByQuote.get(b.quoteId);
      const price = new Decimal(b.bidPrice.toString());
      if (!cur || price.lessThan(cur)) bestByQuote.set(b.quoteId, price);
    }
    for (const [quoteId, price] of bestByQuote) {
      await this.prisma.client.quote.update({
        where: { id: quoteId },
        data: { totalCommercialValue: new Prisma.Decimal(price.toFixed(4)) },
      });
    }
    await this.prisma.client.reverseAuctionRound.update({
      where: { id: roundId },
      data: { status: 'COMPLETED' },
    });
    return { ok: true };
  }

  /** SSE observable for a round's leaderboard. `forVendorId` anonymises names. */
  stream(roundId: string, forVendorId: string | null): Observable<LeaderboardEvent> {
    return new Observable<LeaderboardEvent>((subscriber) => {
      void this.leaderboard(roundId, forVendorId).then((leaderboard) =>
        subscriber.next({ data: { roundId, leaderboard, extended: false } }),
      );
      const sub = this.channel(roundId).subscribe((ev) => {
        // Re-anonymise per subscriber viewpoint.
        void this.leaderboard(roundId, forVendorId).then((leaderboard) =>
          subscriber.next({ data: { roundId, leaderboard, extended: ev.data.extended } }),
        );
      });
      return () => sub.unsubscribe();
    });
  }

  async leaderboard(
    roundId: string,
    forVendorId: string | null,
  ): Promise<ReverseAuctionLeaderboardEntry[]> {
    const round = await this.prisma.client.reverseAuctionRound.findUnique({
      where: { id: roundId },
      include: { rfq: { select: { blindEvaluation: true } } },
    });
    if (!round) return [];
    const bids = await this.prisma.client.reverseAuctionBid.findMany({
      where: { roundId, isValid: true },
      orderBy: [{ bidPrice: 'asc' }, { bidAt: 'asc' }],
    });
    // Latest/best bid per vendor.
    const bestByVendor = new Map<string, { price: Decimal; at: Date }>();
    for (const b of bids) {
      const price = new Decimal(b.bidPrice.toString());
      const cur = bestByVendor.get(b.vendorId);
      if (!cur || price.lessThan(cur.price)) {
        bestByVendor.set(b.vendorId, { price, at: b.bidAt });
      }
    }
    const vendorIds = [...bestByVendor.keys()];
    const vendors = await this.prisma.client.vendor.findMany({
      where: { id: { in: vendorIds } },
      select: { id: true, name: true },
    });
    const nameById = new Map(vendors.map((v) => [v.id, v.name]));
    const sorted = [...bestByVendor.entries()].sort((a, b) =>
      a[1].price.comparedTo(b[1].price),
    );
    const l1 = sorted[0]?.[1].price ?? new Decimal(0);
    // Buyer view (forVendorId null) shows names + every bid. Vendor view shows
    // rank position for all, but price/gap/time ONLY for the viewer's own row —
    // a competitor's exact price never leaves the server (audit: sealed-quote).
    return sorted.map(([vendorId, { price, at }], i) => {
      const isYou = forVendorId === vendorId;
      const hideCommercials = forVendorId != null && !isYou;
      return {
        rank: i + 1,
        rankLabel: `L${i + 1}`,
        vendorName: forVendorId ? null : (nameById.get(vendorId) ?? null),
        bidPrice: hideCommercials ? null : price.toFixed(4),
        gapToL1: hideCommercials ? null : price.minus(l1).toFixed(4),
        isYou,
        bidAt: hideCommercials ? null : at.toISOString(),
      };
    });
  }

  private channel(roundId: string): Subject<LeaderboardEvent> {
    let ch = this.channels.get(roundId);
    if (!ch) {
      ch = new Subject<LeaderboardEvent>();
      this.channels.set(roundId, ch);
    }
    return ch;
  }

  private async currentLeaderPrice(
    roundId: string,
    round: Prisma.ReverseAuctionRoundGetPayload<Record<string, never>>,
  ): Promise<Decimal> {
    const best = await this.prisma.client.reverseAuctionBid.findFirst({
      where: { roundId, isValid: true },
      orderBy: { bidPrice: 'asc' },
      select: { bidPrice: true },
    });
    return best
      ? new Decimal(best.bidPrice.toString())
      : new Decimal(round.startingPrice.toString());
  }

  private assertLive(
    round: Prisma.ReverseAuctionRoundGetPayload<Record<string, never>>,
  ): void {
    const now = Date.now();
    if (
      round.status === 'COMPLETED' ||
      round.status === 'CANCELLED' ||
      round.startsAt.getTime() > now ||
      round.endsAt.getTime() < now
    ) {
      throw new ReverseAuctionError('The reverse-auction round is not live.');
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
      type: 'REVERSE_AUCTION',
      title,
      entityType: 'Rfq',
      entityId: rfqId,
      href: `/sourcing/${rfqId}/reverse-auction`,
    });
  }
}
