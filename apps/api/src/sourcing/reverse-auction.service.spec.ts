import { Prisma } from '@procureflow/db';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import { ReverseAuctionService } from './reverse-auction.service';
import { ReverseAuctionError } from './sourcing.errors';

const now = Date.now();

interface RoundShape {
  status: string;
  startsAt: Date;
  endsAt: Date;
  startingPrice: string;
  decrementMin: string;
  extensionSeconds: number;
  rfqId: string;
  tenantId: string;
}

function makeService(opts: {
  round?: Partial<RoundShape>;
  quote?: { vendorId: string; status: string } | null;
  bestBid?: string | null;
}): {
  svc: ReverseAuctionService;
  roundUpdate: ReturnType<typeof vi.fn>;
  bidCreate: ReturnType<typeof vi.fn>;
} {
  const round: RoundShape = {
    status: 'LIVE',
    startsAt: new Date(now - 60_000),
    endsAt: new Date(now + 600_000),
    startingPrice: '4000',
    decrementMin: '50',
    extensionSeconds: 120,
    rfqId: 'rfq_1',
    tenantId: 'ten_1',
    ...opts.round,
  };
  const roundUpdate = vi.fn().mockResolvedValue({});
  const bidCreate = vi.fn().mockResolvedValue({});
  const prisma = {
    currentTenantId: 'ten_1',
    client: {
      reverseAuctionRound: {
        findUnique: vi.fn().mockResolvedValue(round),
        update: roundUpdate,
      },
      quote: {
        findUnique: vi
          .fn()
          .mockResolvedValue(
            opts.quote === undefined
              ? { vendorId: 'ven_1', status: 'QUALIFIED' }
              : opts.quote,
          ),
      },
      reverseAuctionBid: {
        create: bidCreate,
        findFirst: vi
          .fn()
          .mockResolvedValue(
            opts.bestBid ? { bidPrice: new Prisma.Decimal(opts.bestBid) } : null,
          ),
      },
    },
  } as unknown as PrismaService;

  const audit = { rfq: vi.fn().mockResolvedValue(undefined) } as never;
  const events = { emit: vi.fn().mockResolvedValue(undefined) } as never;
  const notifications = { notify: vi.fn() } as never;
  const vendors = { resolveVendorId: vi.fn() } as never;
  const svc = new ReverseAuctionService(prisma, audit, events, notifications, vendors);
  // Silence the leaderboard broadcast (reads more rows).
  vi.spyOn(svc, 'leaderboard').mockResolvedValue([]);
  return { svc, roundUpdate, bidCreate };
}

const bid = (roundId: string, price: string) => ({
  roundId,
  quoteId: 'qt_1',
  bidPrice: price,
});

describe('ReverseAuctionService.submitBid', () => {
  it('accepts a bid at least the minimum decrement below the leader', async () => {
    const { svc, bidCreate } = makeService({ bestBid: '4000' });
    const r = await svc.submitBid('rar_1', bid('rar_1', '3950'), 'usr_1', 'ven_1');
    expect(r.accepted).toBe(true);
    expect(bidCreate).toHaveBeenCalled();
  });

  it('rejects a bid at or above the current leader', async () => {
    const { svc } = makeService({ bestBid: '4000' });
    await expect(
      svc.submitBid('rar_1', bid('rar_1', '3960'), 'usr_1', 'ven_1'),
    ).rejects.toThrow(ReverseAuctionError);
  });

  it('rejects a decrement below the minimum', async () => {
    const { svc } = makeService({ bestBid: '4000' });
    await expect(
      svc.submitBid('rar_1', bid('rar_1', '3951'), 'usr_1', 'ven_1'),
    ).rejects.toThrow(/minimum decrement/);
  });

  it('rejects when the round is not live (ended)', async () => {
    const { svc } = makeService({ round: { endsAt: new Date(now - 1000) } });
    await expect(
      svc.submitBid('rar_1', bid('rar_1', '3900'), 'usr_1', 'ven_1'),
    ).rejects.toThrow(/not live/);
  });

  it('rejects when the round is scheduled (not started)', async () => {
    const { svc } = makeService({ round: { startsAt: new Date(now + 60_000) } });
    await expect(
      svc.submitBid('rar_1', bid('rar_1', '3900'), 'usr_1', 'ven_1'),
    ).rejects.toThrow(/not live/);
  });

  it('rejects a bid from an unqualified quote', async () => {
    const { svc } = makeService({
      quote: { vendorId: 'ven_1', status: 'SUBMITTED' },
      bestBid: '4000',
    });
    await expect(
      svc.submitBid('rar_1', bid('rar_1', '3900'), 'usr_1', 'ven_1'),
    ).rejects.toThrow(/qualified/);
  });

  it('rejects a quote that belongs to another vendor', async () => {
    const { svc } = makeService({
      quote: { vendorId: 'ven_2', status: 'QUALIFIED' },
      bestBid: '4000',
    });
    await expect(
      svc.submitBid('rar_1', bid('rar_1', '3900'), 'usr_1', 'ven_1'),
    ).rejects.toThrow(/does not belong/);
  });

  it('auto-extends when a bid lands in the last N seconds', async () => {
    const { svc, roundUpdate } = makeService({
      round: { endsAt: new Date(now + 30_000) }, // within 120s window
      bestBid: '4000',
    });
    const r = await svc.submitBid('rar_1', bid('rar_1', '3900'), 'usr_1', 'ven_1');
    expect(r.extended).toBe(true);
    // one update extends endsAt, one sets the leader
    expect(roundUpdate).toHaveBeenCalledTimes(2);
  });

  it('uses the starting price as the leader when no bids yet', async () => {
    const { svc, bidCreate } = makeService({ bestBid: null });
    // starting 4000, min decrement 50 → 3950 allowed
    await svc.submitBid('rar_1', bid('rar_1', '3950'), 'usr_1', 'ven_1');
    expect(bidCreate).toHaveBeenCalled();
  });
});

function makeLeaderboardService(): ReverseAuctionService {
  const prisma = {
    currentTenantId: 'ten_1',
    client: {
      reverseAuctionRound: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'rar_1',
          rfq: { blindEvaluation: true },
        }),
      },
      reverseAuctionBid: {
        findMany: vi.fn().mockResolvedValue([
          {
            vendorId: 'ven_1',
            bidPrice: new Prisma.Decimal('3800'),
            bidAt: new Date(now),
            isValid: true,
          },
          {
            vendorId: 'ven_2',
            bidPrice: new Prisma.Decimal('3900'),
            bidAt: new Date(now),
            isValid: true,
          },
        ]),
      },
      vendor: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'ven_1', name: 'Alpha Traders' },
          { id: 'ven_2', name: 'Beta Supplies' },
        ]),
      },
    },
  } as unknown as PrismaService;
  const audit = { rfq: vi.fn() } as never;
  const events = { emit: vi.fn() } as never;
  const notifications = { notify: vi.fn() } as never;
  const vendors = { resolveVendorId: vi.fn() } as never;
  return new ReverseAuctionService(prisma, audit, events, notifications, vendors);
}

describe('ReverseAuctionService.leaderboard — anonymisation', () => {
  it('buyer view (forVendorId null) exposes names and every bid', async () => {
    const board = await makeLeaderboardService().leaderboard('rar_1', null);
    expect(board.map((r) => r.vendorName)).toEqual(['Alpha Traders', 'Beta Supplies']);
    expect(board.every((r) => r.bidPrice !== null && r.gapToL1 !== null)).toBe(true);
  });

  it('vendor view exposes price/gap ONLY for the viewer’s own row; competitors show rank only', async () => {
    const board = await makeLeaderboardService().leaderboard('rar_1', 'ven_2');
    const l1 = board.find((r) => r.rank === 1)!; // competitor (Alpha, ven_1)
    const you = board.find((r) => r.isYou)!; // ven_2

    // Competitor: rank position visible, but no name / price / gap / time leaks.
    expect(l1.isYou).toBe(false);
    expect(l1.vendorName).toBeNull();
    expect(l1.bidPrice).toBeNull();
    expect(l1.gapToL1).toBeNull();
    expect(l1.bidAt).toBeNull();

    // Own row: your price and your gap-to-leader are shown (the RA signal).
    expect(you.bidPrice).toBe('3900.0000');
    expect(you.gapToL1).toBe('100.0000');
  });
});
