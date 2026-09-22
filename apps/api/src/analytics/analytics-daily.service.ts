import { Injectable } from '@nestjs/common';
import { newId } from '@procureflow/db';

import { PrismaService } from '../prisma/prisma.service';
import { OPEN_PO_STATUSES } from '../purchase-orders/purchase-order-query.service';
import { addDays, complianceScore, dayKey, utcDay } from './daily-math';

/** AnalyticsRefreshLog view name for the AnalyticsDaily rollup. */
export const DAILY_VIEW = 'daily';

/**
 * Trailing window of flow columns recomputed on each refresh. 62 days (not 45)
 * so the Home spend tile's "same days last month" baseline — which can reach
 * back to the 1st of the previous month, up to 61 days ago — is always inside it.
 */
export const DAILY_FLOW_WINDOW_DAYS = 62;

/** Rollup older than this is recomputed inline before a Home/overview answer. */
export const DAILY_STALE_MS = 5 * 60 * 1000;

/**
 * Invoice statuses excluded from invoice-basis spend: rejected, and not yet
 * recognised (still at intake/OCR). Shared with the monthly spend refresh.
 */
export const SPEND_EXCLUDED_STATUSES = ['REJECTED', 'RECEIVED', 'OCR_PENDING', 'OCR_DONE'];
export const SPEND_EXCLUDED_SQL = SPEND_EXCLUDED_STATUSES.map((s) => `'${s}'`).join(',');

export interface LiveSnapshot {
  openPos: number;
  invoicesInFlight: number;
  activeVendors: number;
}

export interface MsmeScorePoint {
  day: string;
  score: number | null;
  total: number;
  onTime: number;
}

/**
 * The MSME compliance cohort for one measurement day D: MSME-vendor invoices
 * (not rejected) whose §15 due date fell in (D−90, D]; "on time" = fully paid
 * (Invoice.paidAt, else the last PaymentRecord for a PAID invoice) on or before
 * the due date. Because an on-time payment necessarily predates D, this can be
 * evaluated for past days from today's data — one pass over generate_series.
 */
const MSME_SCORE_SQL = `
WITH inv AS (
  SELECT (i."msmeDueDate" AT TIME ZONE 'UTC')::date AS due,
         CASE WHEN i.status = 'PAID'
              THEN (COALESCE(i.paid_at, pr.last_paid) AT TIME ZONE 'UTC')::date END AS paid
  FROM "Invoice" i
  JOIN "Vendor" v ON v.id = i.vendor_id AND v."isMsme" = true
  LEFT JOIN LATERAL (
    SELECT MAX(r.paid_at) AS last_paid FROM "PaymentRecord" r WHERE r.invoice_id = i.id
  ) pr ON i.status = 'PAID' AND i.paid_at IS NULL
  WHERE i.tenant_id = $1::uuid
    AND i.status <> 'REJECTED'
    AND i."msmeDueDate" IS NOT NULL
    AND i."msmeDueDate" >= (($2::date - 90)::timestamp AT TIME ZONE 'UTC')
    AND i."msmeDueDate" <  (($3::date + 1)::timestamp AT TIME ZONE 'UTC')
),
days AS (
  SELECT g::date AS day FROM generate_series($2::date, $3::date, interval '1 day') g
)
SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
       COUNT(inv.due)::int AS total,
       COUNT(*) FILTER (WHERE inv.paid IS NOT NULL AND inv.paid <= inv.due)::int AS on_time
FROM days d
LEFT JOIN inv ON inv.due > d.day - 90 AND inv.due <= d.day
GROUP BY d.day
ORDER BY d.day`;

/**
 * AnalyticsDailyService — the AnalyticsDaily summary table (ADR-028: an
 * RLS-protected table, never a materialized view). Flow columns (spend,
 * documents created) are recomputed for the trailing window with a single
 * INSERT … ON CONFLICT; stock columns are a snapshot written for today only.
 * Everything runs inside the caller's tenant context and filters on tenant_id
 * explicitly as well (index use + belt-and-braces over RLS).
 */
@Injectable()
export class AnalyticsDailyService {
  constructor(private readonly prisma: PrismaService) {}

  /** Recompute the rollup for one tenant (must run inside its context). */
  async refresh(tenantId: string, now: Date = new Date()): Promise<void> {
    await this.refreshFlows(tenantId, now);
    await this.writeSnapshot(tenantId, now);
  }

  /**
   * Refresh-on-read: recompute when the rollup is older than `maxAgeMs`. A
   * transaction-scoped advisory lock keeps concurrent Home requests from all
   * recomputing at once — the losers answer from the current rows instead of
   * queueing behind the winner's row locks inside their 5s transaction.
   * Returns the rollup's as-of time.
   */
  async ensureFresh(tenantId: string, maxAgeMs: number = DAILY_STALE_MS): Promise<Date> {
    const log = await this.prisma.client.analyticsRefreshLog.findFirst({
      where: { tenantId, viewName: DAILY_VIEW },
      select: { refreshedAt: true },
    });
    const now = new Date();
    if (log && now.getTime() - log.refreshedAt.getTime() < maxAgeMs) return log.refreshedAt;

    const lock = await this.prisma.client.$queryRawUnsafe<{ locked: boolean }[]>(
      `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked`,
      `analytics_daily:${tenantId}`,
    );
    if (!lock[0]?.locked) return log?.refreshedAt ?? now;

    const start = Date.now();
    await this.refresh(tenantId, now);
    await this.stamp(tenantId, 'READ', Date.now() - start, now);
    return now;
  }

  /** Upsert the refresh-log row (raw ON CONFLICT so concurrent stamps can't collide). */
  async stamp(tenantId: string, trigger: string, durationMs: number, at = new Date()): Promise<void> {
    await this.prisma.client.$executeRawUnsafe(
      `INSERT INTO "AnalyticsRefreshLog" (id, tenant_id, view_name, refreshed_at, "trigger", duration_ms, status)
       VALUES ($1, $2::uuid, $3, $4::timestamptz, $5, $6, 'OK')
       ON CONFLICT (tenant_id, view_name) DO UPDATE
         SET refreshed_at = EXCLUDED.refreshed_at, "trigger" = EXCLUDED."trigger",
             duration_ms = EXCLUDED.duration_ms, status = 'OK'`,
      newId('analyticsRefreshLog'),
      tenantId,
      DAILY_VIEW,
      at.toISOString(),
      trigger,
      durationMs,
    );
  }

  /** When the daily rollup was last recomputed for this tenant (null = never). */
  async refreshedAt(tenantId: string): Promise<Date | null> {
    const log = await this.prisma.client.analyticsRefreshLog.findFirst({
      where: { tenantId, viewName: DAILY_VIEW },
      select: { refreshedAt: true },
    });
    return log?.refreshedAt ?? null;
  }

  private async refreshFlows(tenantId: string, now: Date): Promise<void> {
    const today = utcDay(now);
    const days: string[] = [];
    const ids: string[] = [];
    for (let i = DAILY_FLOW_WINDOW_DAYS - 1; i >= 0; i--) {
      days.push(dayKey(addDays(today, -i)));
      ids.push(newId('analyticsDaily'));
    }
    const lo = days[0];
    const hi = days[days.length - 1];
    // Bounds as UTC-midnight timestamptz so the per-table range scans use the
    // (tenant_id, <date column>) indexes; each CTE is one GROUP BY.
    await this.prisma.client.$executeRawUnsafe(
      `WITH b AS (
         SELECT ($3::date)::timestamp AT TIME ZONE 'UTC' AS lo,
                ($4::date + 1)::timestamp AT TIME ZONE 'UTC' AS hi
       ),
       sp AS (
         SELECT ("invoiceDate" AT TIME ZONE 'UTC')::date AS day, SUM("netAmount") AS net
         FROM "Invoice", b
         WHERE tenant_id = $1::uuid AND status NOT IN (${SPEND_EXCLUDED_SQL})
           AND "invoiceDate" >= b.lo AND "invoiceDate" < b.hi
         GROUP BY 1
       ),
       rq AS (
         SELECT ("createdAt" AT TIME ZONE 'UTC')::date AS day, COUNT(*)::int AS n
         FROM "Requisition", b
         WHERE tenant_id = $1::uuid AND "createdAt" >= b.lo AND "createdAt" < b.hi
         GROUP BY 1
       ),
       po AS (
         SELECT ("createdAt" AT TIME ZONE 'UTC')::date AS day, COUNT(*)::int AS n
         FROM "PurchaseOrder", b
         WHERE tenant_id = $1::uuid AND "createdAt" >= b.lo AND "createdAt" < b.hi
         GROUP BY 1
       ),
       iv AS (
         SELECT ("receivedAt" AT TIME ZONE 'UTC')::date AS day, COUNT(*)::int AS n
         FROM "Invoice", b
         WHERE tenant_id = $1::uuid AND "receivedAt" >= b.lo AND "receivedAt" < b.hi
         GROUP BY 1
       )
       INSERT INTO "AnalyticsDaily"
         (id, tenant_id, day, spend_net, requisitions_created, pos_created, invoices_received, refreshed_at)
       SELECT d.id, $1::uuid, d.day, COALESCE(sp.net, 0), COALESCE(rq.n, 0), COALESCE(po.n, 0),
              COALESCE(iv.n, 0), now()
       FROM unnest($2::date[], $5::text[]) AS d(day, id)
       LEFT JOIN sp ON sp.day = d.day
       LEFT JOIN rq ON rq.day = d.day
       LEFT JOIN po ON po.day = d.day
       LEFT JOIN iv ON iv.day = d.day
       ON CONFLICT (tenant_id, day) DO UPDATE SET
         spend_net = EXCLUDED.spend_net,
         requisitions_created = EXCLUDED.requisitions_created,
         pos_created = EXCLUDED.pos_created,
         invoices_received = EXCLUDED.invoices_received,
         refreshed_at = EXCLUDED.refreshed_at`,
      tenantId,
      days,
      lo,
      hi,
      ids,
    );
  }

  private async writeSnapshot(tenantId: string, now: Date): Promise<void> {
    const snap = await this.liveSnapshot(tenantId);
    const today = dayKey(utcDay(now));
    const [msme] = await this.msmeScoreSeries(tenantId, utcDay(now), utcDay(now));
    await this.prisma.client.$executeRawUnsafe(
      `UPDATE "AnalyticsDaily"
         SET open_pos = $3, invoices_in_flight = $4, active_vendors = $5,
             msme_compliance_score = $6::numeric
       WHERE tenant_id = $1::uuid AND day = $2::date`,
      tenantId,
      today,
      snap.openPos,
      snap.invoicesInFlight,
      snap.activeVendors,
      msme?.score === null || msme?.score === undefined ? null : String(msme.score),
    );
  }

  /**
   * Current stock counts. Open POs = the PO list's Open tab; invoices in flight
   * = anything not PAID or REJECTED; active vendors = the vendor list's Active
   * tab (lifecycle ACTIVE).
   */
  async liveSnapshot(tenantId: string): Promise<LiveSnapshot> {
    const rows = await this.prisma.client.$queryRawUnsafe<
      { open_pos: number; in_flight: number; active_vendors: number }[]
    >(
      `SELECT
         (SELECT COUNT(*)::int FROM "PurchaseOrder"
            WHERE tenant_id = $1::uuid AND status::text = ANY($2::text[])) AS open_pos,
         (SELECT COUNT(*)::int FROM "Invoice"
            WHERE tenant_id = $1::uuid AND status NOT IN ('PAID','REJECTED')) AS in_flight,
         (SELECT COUNT(*)::int FROM "Vendor"
            WHERE tenant_id = $1::uuid AND lifecycle_status = 'ACTIVE') AS active_vendors`,
      tenantId,
      OPEN_PO_STATUSES,
    );
    const r = rows[0];
    return {
      openPos: Number(r?.open_pos ?? 0),
      invoicesInFlight: Number(r?.in_flight ?? 0),
      activeVendors: Number(r?.active_vendors ?? 0),
    };
  }

  /** MSME compliance score for every day in [from, to] (inclusive, UTC days). */
  async msmeScoreSeries(tenantId: string, from: Date, to: Date): Promise<MsmeScorePoint[]> {
    const rows = await this.prisma.client.$queryRawUnsafe<
      { day: string; total: number; on_time: number }[]
    >(MSME_SCORE_SQL, tenantId, dayKey(from), dayKey(to));
    return rows.map((r) => ({
      day: r.day,
      total: Number(r.total),
      onTime: Number(r.on_time),
      score: complianceScore(Number(r.on_time), Number(r.total)),
    }));
  }
}
