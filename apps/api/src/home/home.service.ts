import { Injectable } from '@nestjs/common';
import type {
  ApprovalPipelineResponse,
  HomeSummaryResponse,
  HomeTile,
  UpcomingPaymentRunsResponse,
} from '@procureflow/shared';
import Decimal from 'decimal.js';

import { AnalyticsDailyService } from '../analytics/analytics-daily.service';
import {
  addDays,
  dayKey,
  dayRange,
  deltaPct,
  deltaPoints,
  mtdWindows,
  nearestSnapshot,
  utcDay,
  weekStart,
} from '../analytics/daily-math';
import { PrismaService } from '../prisma/prisma.service';
import { buildPipelineStages } from './home-format';

const TREND_DAYS = 30;
const THROUGHPUT_DAYS = 14;
/** How far either side of "30 days ago" a stock snapshot may sit and still be the baseline. */
const SNAPSHOT_TOLERANCE_DAYS = 3;
const PIPELINE_DOC_TYPES = ['REQUISITION', 'PURCHASE_ORDER'];
/** Document statuses in which a pending approval is live (not a stale row on a withdrawn doc). */
const AWAITING_STATUSES = ['AWAITING_APPROVAL', 'PENDING_APPROVAL'];
const RUN_DONE_STATUSES = ['COMPLETED', 'CANCELLED', 'FAILED'] as const;

type StockKey = 'openPos' | 'invoicesInFlight' | 'activeVendors';

/**
 * HomeService — the Home command center's summary tiles, approval pipeline and
 * upcoming payment runs. Tiles read the AnalyticsDaily rollup (refreshed on
 * read when older than 5 minutes); headline stock values are live counts.
 */
@Injectable()
export class HomeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly daily: AnalyticsDailyService,
  ) {}

  private tenantId(): string {
    const t = this.prisma.currentTenantId;
    if (!t) throw new Error('HomeService requires a tenant context');
    return t;
  }

  async getSummary(now = new Date()): Promise<HomeSummaryResponse> {
    const tenantId = this.tenantId();
    const asOf = await this.daily.ensureFresh(tenantId);
    const today = utcDay(now);
    const trendFrom = addDays(today, -(TREND_DAYS - 1));
    const trendDays = dayRange(trendFrom, today);
    const mtd = mtdWindows(today);
    const lo = new Date(Math.min(mtd.prev.from.getTime(), addDays(today, -35).getTime()));

    const rows = await this.prisma.client.analyticsDaily.findMany({
      where: { tenantId, day: { gte: lo, lte: today } },
      orderBy: { day: 'asc' },
    });
    const byDay = new Map(rows.map((r) => [dayKey(r.day), r]));
    const spendOn = (d: string): Decimal =>
      new Decimal(byDay.get(d)?.spendNet.toString() ?? '0');
    const sumSpend = (from: Date, to: Date): Decimal =>
      dayRange(from, to).reduce((s, d) => s.plus(spendOn(d)), new Decimal(0));

    // ── Spend MTD ────────────────────────────────────────────────────────────
    const mtdCur = sumSpend(mtd.cur.from, mtd.cur.to);
    const mtdPrev = sumSpend(mtd.prev.from, mtd.prev.to);
    const spendMtd: HomeTile = {
      value: mtdCur.toFixed(4),
      trend: trendDays.map((d) => ({ day: d, value: spendOn(d).toNumber() })),
      deltaPct: deltaPct(mtdCur.toNumber(), mtdPrev.toNumber()),
      deltaBasis: 'vs same days last month',
    };

    // ── Stock tiles: live value, snapshot trend, vs ~30 days ago ─────────────
    const live = await this.daily.liveSnapshot(tenantId);
    const todayKey = dayKey(today);
    const stockTile = (key: StockKey): HomeTile => {
      const points = rows
        .filter((r) => r[key] !== null)
        .map((r) => ({ day: dayKey(r.day), value: Number(r[key]) }));
      const trend = points
        .filter((p) => p.day >= trendDays[0]! && p.day !== todayKey)
        .concat({ day: todayKey, value: live[key] });
      const base = nearestSnapshot(
        points.filter((p) => p.day !== todayKey),
        addDays(today, -30),
        SNAPSHOT_TOLERANCE_DAYS,
      );
      return {
        value: live[key],
        trend,
        deltaPct: deltaPct(live[key], base?.value ?? null),
        deltaBasis: 'vs 30 days ago',
      };
    };

    return {
      asOf: asOf.toISOString(),
      tiles: {
        spendMtd,
        openPos: stockTile('openPos'),
        invoicesInFlight: stockTile('invoicesInFlight'),
        activeVendors: stockTile('activeVendors'),
        paymentRunsThisWeek: await this.paymentRunTile(tenantId, today, trendDays),
        msmeComplianceScore: await this.msmeTile(tenantId, today),
      },
      spendTrend: trendDays.map((d) => ({ day: d, amount: spendOn(d).toFixed(4) })),
      throughput: dayRange(addDays(today, -(THROUGHPUT_DAYS - 1)), today).map((d) => {
        const r = byDay.get(d);
        return {
          day: d,
          requisitions: r?.requisitionsCreated ?? 0,
          purchaseOrders: r?.posCreated ?? 0,
          invoices: r?.invoicesReceived ?? 0,
        };
      }),
    };
  }

  /** Runs by cycle date (cancelled excluded): this Mon–Sun week vs last; daily counts for the trend. */
  private async paymentRunTile(
    tenantId: string,
    today: Date,
    trendDays: string[],
  ): Promise<HomeTile & { amount: string }> {
    const ws = weekStart(today);
    const lastWs = addDays(ws, -7);
    const trendFrom = new Date(`${trendDays[0]}T00:00:00Z`);
    const lo = new Date(Math.min(lastWs.getTime(), trendFrom.getTime()));
    const hi = new Date(Math.max(addDays(ws, 7).getTime(), addDays(today, 1).getTime()));
    const rows = await this.prisma.client.$queryRawUnsafe<{ day: string; n: number; net: string }[]>(
      `SELECT to_char(("cycleDate" AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day,
              COUNT(*)::int AS n, COALESCE(SUM("netAmount"),0)::text AS net
       FROM "PaymentRun"
       WHERE tenant_id = $1::uuid AND status <> 'CANCELLED'
         AND "cycleDate" >= $2::timestamptz AND "cycleDate" < $3::timestamptz
       GROUP BY 1`,
      tenantId,
      lo.toISOString(),
      hi.toISOString(),
    );
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const inRange = (from: Date, toExcl: Date) =>
      rows.filter((r) => r.day >= dayKey(from) && r.day < dayKey(toExcl));
    const thisWeek = inRange(ws, addDays(ws, 7));
    const lastWeek = inRange(lastWs, ws);
    const count = thisWeek.reduce((a, r) => a + Number(r.n), 0);
    const lastCount = lastWeek.reduce((a, r) => a + Number(r.n), 0);
    return {
      value: count,
      amount: thisWeek.reduce((s, r) => s.plus(r.net), new Decimal(0)).toFixed(4),
      trend: trendDays.map((d) => ({ day: d, value: Number(byDay.get(d)?.n ?? 0) })),
      deltaPct: deltaPct(count, lastCount),
      deltaBasis: 'vs last week',
    };
  }

  /**
   * MSME compliance tile. `deltaPct` here is the change in PERCENTAGE POINTS vs
   * the score 30 days ago (92 → 95 = 3), not a relative % change — the value is
   * already a percentage, and "+3.3%" of a score reads wrong. `deltaBasis`
   * says so ("pts vs 30 days ago").
   */
  private async msmeTile(tenantId: string, today: Date): Promise<HomeTile> {
    const series = await this.daily.msmeScoreSeries(tenantId, addDays(today, -TREND_DAYS), today);
    const current = series[series.length - 1]?.score ?? null;
    const base = series[0]?.score ?? null;
    return {
      value: current,
      trend: series
        .slice(1)
        .filter((p) => p.score !== null)
        .map((p) => ({ day: p.day, value: p.score as number })),
      deltaPct: deltaPoints(current, base),
      deltaBasis: 'pts vs 30 days ago',
    };
  }

  async getApprovalPipeline(now = new Date()): Promise<ApprovalPipelineResponse> {
    const tenantId = this.tenantId();
    await this.daily.ensureFresh(tenantId);
    // Each awaiting document sits at its earliest step that still has a
    // PENDING approval — counted once however many parallel approvers it has.
    const steps = await this.prisma.client.$queryRawUnsafe<{ step: number; count: number }[]>(
      `WITH pend AS (
         SELECT a."documentType", a.document_id, MIN(a."stepNo") AS step
         FROM "Approval" a
         LEFT JOIN "Requisition" r ON a."documentType" = 'REQUISITION' AND r.id = a.document_id
         LEFT JOIN "PurchaseOrder" p ON a."documentType" = 'PURCHASE_ORDER' AND p.id = a.document_id
         WHERE a.tenant_id = $1::uuid AND a.decision = 'PENDING'
           AND a."documentType"::text = ANY($2::text[])
           AND (r.status::text = ANY($3::text[]) OR p.status::text = ANY($3::text[]))
         GROUP BY 1, 2
       )
       SELECT step, COUNT(*)::int AS count FROM pend GROUP BY step ORDER BY step`,
      tenantId,
      PIPELINE_DOC_TYPES,
      AWAITING_STATUSES,
    );
    const stepNos = steps.map((s) => Number(s.step)).filter((n) => n > 1);
    const names = stepNos.length
      ? await this.prisma.client.$queryRawUnsafe<{ step: number; name: string | null; count: number }[]>(
          `SELECT "stepNo" AS step, step_name AS name, COUNT(*)::int AS count
           FROM "Approval"
           WHERE tenant_id = $1::uuid AND "documentType"::text = ANY($2::text[])
             AND "stepNo" = ANY($3::int[]) AND step_name IS NOT NULL
           GROUP BY 1, 2`,
          tenantId,
          PIPELINE_DOC_TYPES,
          stepNos,
        )
      : [];
    const approved = await this.prisma.client.$queryRawUnsafe<{ n: number }[]>(
      `SELECT COUNT(DISTINCT "entityId")::int AS n FROM "AuditLog"
       WHERE tenant_id = $1::uuid AND action = 'DOCUMENT_APPROVED'
         AND "entityType" IN ('Requisition','PurchaseOrder')
         AND "timestamp" >= $2::timestamptz`,
      tenantId,
      addDays(now, -30).toISOString(),
    );
    return {
      stages: buildPipelineStages(
        steps.map((s) => ({ step: Number(s.step), count: Number(s.count) })),
        names.map((n) => ({ step: Number(n.step), name: n.name, count: Number(n.count) })),
      ),
      approved30d: Number(approved[0]?.n ?? 0),
    };
  }

  async getUpcomingPaymentRuns(now = new Date()): Promise<UpcomingPaymentRunsResponse> {
    const tenantId = this.tenantId();
    await this.daily.ensureFresh(tenantId);
    const runs = await this.prisma.client.paymentRun.findMany({
      where: {
        tenantId,
        cycleDate: { gte: utcDay(now) },
        status: { notIn: [...RUN_DONE_STATUSES] },
      },
      orderBy: [{ cycleDate: 'asc' }, { number: 'asc' }],
      take: 3,
      select: {
        id: true,
        number: true,
        name: true,
        cycleDate: true,
        status: true,
        netAmount: true,
        currency: true,
        _count: { select: { items: true } },
      },
    });
    return {
      items: runs.map((r) => ({
        id: r.id,
        number: r.number,
        name: r.name,
        cycleDate: r.cycleDate.toISOString(),
        status: r.status,
        itemCount: r._count.items,
        net: new Decimal(r.netAmount.toString()).toFixed(4),
        currency: r.currency,
      })),
    };
  }
}
