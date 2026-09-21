import { describe, expect, it, vi } from 'vitest';

import type { AnalyticsDailyService } from '../analytics/analytics-daily.service';
import type { PrismaService } from '../prisma/prisma.service';
import { HomeService } from './home.service';

const NOW = new Date('2026-09-21T09:00:00Z'); // a Monday
const TENANT = '00000000-0000-0000-0000-00000000000a';

function dailyRow(day: string, over: Record<string, unknown> = {}) {
  return {
    day: new Date(`${day}T00:00:00Z`),
    spendNet: '0',
    requisitionsCreated: 0,
    posCreated: 0,
    invoicesReceived: 0,
    openPos: null,
    invoicesInFlight: null,
    activeVendors: null,
    msmeComplianceScore: null,
    ...over,
  };
}

function build(opts: {
  rows?: ReturnType<typeof dailyRow>[];
  runs?: { day: string; n: number; net: string }[];
  msme?: { day: string; score: number | null }[];
  raw?: (sql: string) => unknown[];
  paymentRuns?: unknown[];
}) {
  const findMany = vi.fn().mockResolvedValue(opts.rows ?? []);
  const client = {
    analyticsDaily: { findMany },
    paymentRun: { findMany: vi.fn().mockResolvedValue(opts.paymentRuns ?? []) },
    $queryRawUnsafe: vi.fn((sql: string) =>
      Promise.resolve(opts.raw ? opts.raw(sql) : sql.includes('"PaymentRun"') ? (opts.runs ?? []) : []),
    ),
  };
  const prisma = { client, currentTenantId: TENANT } as unknown as PrismaService;
  const daily = {
    ensureFresh: vi.fn().mockResolvedValue(new Date('2026-09-21T08:58:00Z')),
    liveSnapshot: vi.fn().mockResolvedValue({ openPos: 12, invoicesInFlight: 30, activeVendors: 44 }),
    msmeScoreSeries: vi.fn().mockResolvedValue(
      (opts.msme ?? []).map((p) => ({ ...p, total: 1, onTime: 1 })),
    ),
  } as unknown as AnalyticsDailyService;
  return { svc: new HomeService(prisma, daily), client, daily };
}

describe('HomeService.getSummary', () => {
  it('spend MTD vs same days last month, 30-point trend, 14-point throughput', async () => {
    const rows = [
      dailyRow('2026-08-05', { spendNet: '100' }),
      dailyRow('2026-08-25', { spendNet: '999' }), // after Aug 21 → outside the baseline
      dailyRow('2026-09-02', { spendNet: '150', posCreated: 2 }),
      dailyRow('2026-09-21', { spendNet: '50', requisitionsCreated: 3, invoicesReceived: 1 }),
    ];
    const { svc, daily } = build({ rows });
    const res = await svc.getSummary(NOW);

    expect(daily.ensureFresh).toHaveBeenCalledWith(TENANT);
    expect(res.asOf).toBe('2026-09-21T08:58:00.000Z');
    expect(res.tiles.spendMtd.value).toBe('200.0000');
    expect(res.tiles.spendMtd.deltaPct).toBe(100); // 200 vs 100
    expect(res.tiles.spendMtd.deltaBasis).toBe('vs same days last month');
    expect(res.spendTrend).toHaveLength(30);
    expect(res.spendTrend[0]!.day).toBe('2026-08-23');
    expect(res.spendTrend.at(-1)).toEqual({ day: '2026-09-21', amount: '50.0000' });
    expect(res.throughput).toHaveLength(14);
    expect(res.throughput.at(-1)).toEqual({
      day: '2026-09-21',
      requisitions: 3,
      purchaseOrders: 0,
      invoices: 1,
    });
  });

  it('stock tiles: live value, snapshot trend ending in the live point, delta vs ~30 days ago', async () => {
    const rows = [
      dailyRow('2026-08-22', { openPos: 10 }), // 30 days before 21 Sep
      dailyRow('2026-09-10', { openPos: 11 }),
      dailyRow('2026-09-21', { openPos: 9 }), // stale snapshot → replaced by live 12
    ];
    const { svc } = build({ rows });
    const res = await svc.getSummary(NOW);
    const t = res.tiles.openPos;
    expect(t.value).toBe(12);
    expect(t.trend).toEqual([
      { day: '2026-09-10', value: 11 },
      { day: '2026-09-21', value: 12 },
    ]);
    expect(t.deltaPct).toBe(20); // 12 vs 10
    // No snapshot ~30 days ago → no delta.
    expect(res.tiles.activeVendors.deltaPct).toBeNull();
    expect(res.tiles.activeVendors.trend).toEqual([{ day: '2026-09-21', value: 44 }]);
  });

  it('payment runs: this Mon–Sun week vs last week, amount = net total', async () => {
    const runs = [
      { day: '2026-09-15', n: 1, net: '500' }, // last week
      { day: '2026-09-21', n: 2, net: '1000.5' }, // this week (Mon)
      { day: '2026-09-25', n: 1, net: '250' }, // this week (Fri, future)
    ];
    const { svc } = build({ runs });
    const t = (await svc.getSummary(NOW)).tiles.paymentRunsThisWeek;
    expect(t.value).toBe(3);
    expect(t.amount).toBe('1250.5000');
    expect(t.deltaPct).toBe(200);
    expect(t.trend).toHaveLength(30);
    expect(t.trend.at(-1)).toEqual({ day: '2026-09-21', value: 2 });
  });

  it('MSME tile: deltaPct is the point change vs 30 days ago', async () => {
    const { svc } = build({
      msme: [
        { day: '2026-08-22', score: 90 },
        { day: '2026-08-23', score: null },
        { day: '2026-09-21', score: 95.5 },
      ],
    });
    const t = (await svc.getSummary(NOW)).tiles.msmeComplianceScore;
    expect(t.value).toBe(95.5);
    expect(t.deltaPct).toBe(5.5);
    expect(t.deltaBasis).toBe('pts vs 30 days ago');
    expect(t.trend).toEqual([{ day: '2026-09-21', value: 95.5 }]);
  });
});

describe('HomeService.getApprovalPipeline', () => {
  it('counts documents per earliest pending step and labels steps from the matrix names', async () => {
    const { svc } = build({
      raw: (sql) => {
        if (sql.includes('WITH pend')) return [{ step: 1, count: 3 }, { step: 2, count: 2 }];
        if (sql.includes('step_name AS name')) return [{ step: 2, name: 'Plant Head', count: 5 }];
        if (sql.includes('DOCUMENT_APPROVED')) return [{ n: 7 }];
        return [];
      },
    });
    const res = await svc.getApprovalPipeline(NOW);
    expect(res).toEqual({
      stages: [
        { key: 'submitted', label: 'Submitted', count: 3 },
        { key: 'step_2', label: 'Plant Head', count: 2 },
      ],
      approved30d: 7,
    });
  });
});

describe('HomeService.getUpcomingPaymentRuns', () => {
  it('returns the nearest open runs from today, excluding finished statuses', async () => {
    const { svc, client } = build({
      paymentRuns: [
        {
          id: 'pr_1',
          number: 'PR-0007',
          name: 'Week 39',
          cycleDate: new Date('2026-09-24T00:00:00Z'),
          status: 'AWAITING_APPROVAL',
          netAmount: '12345.6',
          currency: 'INR',
          _count: { items: 4 },
        },
      ],
    });
    const res = await svc.getUpcomingPaymentRuns(NOW);
    expect(res.items[0]).toEqual({
      id: 'pr_1',
      number: 'PR-0007',
      name: 'Week 39',
      cycleDate: '2026-09-24T00:00:00.000Z',
      status: 'AWAITING_APPROVAL',
      itemCount: 4,
      net: '12345.6000',
      currency: 'INR',
    });
    const args = client.paymentRun.findMany.mock.calls[0]![0];
    expect(args.take).toBe(3);
    expect(args.where.status.notIn).toEqual(['COMPLETED', 'CANCELLED', 'FAILED']);
    expect(args.where.cycleDate.gte.toISOString()).toBe('2026-09-21T00:00:00.000Z');
    expect(args.where.tenantId).toBe(TENANT);
  });
});
