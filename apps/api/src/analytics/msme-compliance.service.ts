import { Injectable } from '@nestjs/common';
import {
  resolvePeriod,
  type AnalyticsPeriodQuery,
  type MsmeBucketKey,
  type MsmeComplianceTrendResponse,
  type MsmeDashboardResponse,
  type MsmeExposureResponse,
  type MsmeExposureRow,
} from '@procureflow/shared';
import Decimal from 'decimal.js';

import { PrismaService } from '../prisma/prisma.service';

/** MSME §15 interest accrues at RBI reference rate × 3 (Master Context §9). */
const INTEREST_MULTIPLIER = 3;
const APPROACHING_DAYS = 30;
const BREACH_DAYS = 45; // aligned to the default 45-day cap

/**
 * What is still owed on an open MSME invoice: the net amount, or — once part
 * of it has been paid — the unpaid balance (gross − paid). Rejected and fully
 * paid invoices are excluded by OPEN_MSME_FILTER.
 */
const EXPOSURE_SQL = `CASE WHEN i.status = 'PARTIALLY_PAID'
  THEN GREATEST(i."grossAmount" - i.paid_amount, 0) ELSE i."netAmount" END`;
const OPEN_MSME_FILTER = `i.status NOT IN ('PAID','REJECTED')`;

interface BucketRow {
  bucket: MsmeBucketKey;
  cnt: number;
  exposure: string;
  avg_days: number;
}
interface ExposureQueryRow {
  id: string;
  number: string;
  vendorId: string;
  vendorName: string;
  invoiceDate: Date;
  msmeDueDate: Date | null;
  netAmount: string;
  daysOutstanding: number;
  daysLate: number;
}

/**
 * MsmeComplianceService (Slice 8). Section-15 aging + interest exposure. Buckets
 * are computed LIVE (same-day accuracy — the demo depends on INV-4471 landing in
 * the right bucket for its actual day-count, not last night's refresh). Trend
 * reads the AnalyticsMsmeMonthly summary.
 */
@Injectable()
export class MsmeComplianceService {
  constructor(private readonly prisma: PrismaService) {}

  private async rbiRatePct(): Promise<Decimal> {
    const cfg = await this.prisma.client.tenantComplianceConfig.findFirst();
    return new Decimal(cfg?.rbiReferenceRatePct.toString() ?? '6.5');
  }

  async getAgingDashboard(): Promise<MsmeDashboardResponse> {
    const buckets = await this.prisma.client.$queryRawUnsafe<BucketRow[]>(
      `SELECT
         CASE WHEN (CURRENT_DATE - i."invoiceDate"::date) >= ${BREACH_DAYS} THEN 'BREACH_45_PLUS'
              WHEN (CURRENT_DATE - i."invoiceDate"::date) >= ${APPROACHING_DAYS} THEN 'APPROACHING_30_44'
              ELSE 'SAFE_0_29' END AS bucket,
         COUNT(*)::int AS cnt,
         COALESCE(SUM(${EXPOSURE_SQL}),0)::text AS exposure,
         COALESCE(AVG(CURRENT_DATE - i."invoiceDate"::date),0)::float AS avg_days
       FROM "Invoice" i
       JOIN "Vendor" v ON v.id = i.vendor_id AND v."isMsme" = true
       WHERE ${OPEN_MSME_FILTER}
       GROUP BY 1`,
    );
    const order: MsmeBucketKey[] = ['SAFE_0_29', 'APPROACHING_30_44', 'BREACH_45_PLUS'];
    const byKey = new Map(buckets.map((b) => [b.bucket, b]));
    const bucketOut = order.map((k) => {
      const b = byKey.get(k);
      return {
        bucket: k,
        invoiceCount: b ? Number(b.cnt) : 0,
        totalExposure: b ? new Decimal(b.exposure).toFixed(4) : '0.0000',
        avgDays: b ? Math.round(b.avg_days) : 0,
      };
    });

    const spend = await this.prisma.client.$queryRawUnsafe<
      { msme: string; total: string }[]
    >(
      `SELECT COALESCE(SUM(i."netAmount") FILTER (WHERE v."isMsme"),0)::text AS msme,
              COALESCE(SUM(i."netAmount"),0)::text AS total
       FROM "Invoice" i JOIN "Vendor" v ON v.id = i.vendor_id
       WHERE i.status NOT IN ('REJECTED','RECEIVED','OCR_PENDING','OCR_DONE')`,
    );
    const msmeSpend = new Decimal(spend[0]?.msme ?? '0');
    const totalSpend = new Decimal(spend[0]?.total ?? '0');
    return {
      asOfDate: new Date().toISOString(),
      buckets: bucketOut,
      msmeSpendNet: msmeSpend.toFixed(4),
      totalSpendNet: totalSpend.toFixed(4),
      msmeSpendPct: totalSpend.gt(0)
        ? msmeSpend.div(totalSpend).times(100).toDP(2).toNumber()
        : 0,
      live: true,
      refreshedAt: null, // live
    };
  }

  async getExposureDetail(bucket: MsmeBucketKey): Promise<MsmeExposureResponse> {
    const lo =
      bucket === 'BREACH_45_PLUS'
        ? BREACH_DAYS
        : bucket === 'APPROACHING_30_44'
          ? APPROACHING_DAYS
          : 0;
    const hi =
      bucket === 'SAFE_0_29'
        ? APPROACHING_DAYS
        : bucket === 'APPROACHING_30_44'
          ? BREACH_DAYS
          : 100000;
    const rows = await this.prisma.client.$queryRawUnsafe<ExposureQueryRow[]>(
      `SELECT i.id, i.number, i.vendor_id AS "vendorId", v.name AS "vendorName",
              i."invoiceDate", i."msmeDueDate", (${EXPOSURE_SQL})::text AS "netAmount",
              (CURRENT_DATE - i."invoiceDate"::date)::int AS "daysOutstanding",
              GREATEST(0, (CURRENT_DATE - i."msmeDueDate"::date))::int AS "daysLate"
       FROM "Invoice" i
       JOIN "Vendor" v ON v.id = i.vendor_id AND v."isMsme" = true
       WHERE ${OPEN_MSME_FILTER}
             AND (CURRENT_DATE - i."invoiceDate"::date) >= $1
             AND (CURRENT_DATE - i."invoiceDate"::date) < $2
       ORDER BY "daysOutstanding" DESC`,
      lo,
      hi,
    );
    const rbi = await this.rbiRatePct();
    const annualRate = rbi.times(INTEREST_MULTIPLIER).div(100);
    let totalExposure = new Decimal(0);
    let totalInterest = new Decimal(0);
    const out: MsmeExposureRow[] = rows.map((r) => {
      const net = new Decimal(r.netAmount);
      const interest = net.times(annualRate).times(r.daysLate).div(365);
      totalExposure = totalExposure.plus(net);
      totalInterest = totalInterest.plus(interest);
      return {
        invoiceId: r.id,
        invoiceNumber: r.number,
        vendorId: r.vendorId,
        vendorName: r.vendorName,
        invoiceDate: r.invoiceDate.toISOString(),
        dueDate: r.msmeDueDate ? r.msmeDueDate.toISOString() : null,
        daysOutstanding: r.daysOutstanding,
        netAmount: net.toFixed(4),
        interestIfBreached: interest.toFixed(4),
      };
    });
    return {
      bucket,
      rows: out,
      totalExposure: totalExposure.toFixed(4),
      totalInterest: totalInterest.toFixed(4),
      rbiReferenceRatePct: rbi.toFixed(4),
      interestMultiplier: INTEREST_MULTIPLIER,
      refreshedAt: null, // live
    };
  }

  async getComplianceTrend(
    q: AnalyticsPeriodQuery,
  ): Promise<MsmeComplianceTrendResponse> {
    const p = resolvePeriod(q, new Date());
    const rows = await this.prisma.client.analyticsMsmeMonthly.findMany({
      where: { month: { in: p.months } },
      orderBy: { month: 'asc' },
    });
    const byMonth = new Map(rows.map((r) => [r.month, r]));
    const log = await this.prisma.client.analyticsRefreshLog.findFirst({
      where: { viewName: 'msme_monthly' },
    });
    return {
      points: p.months.map((m) => {
        const r = byMonth.get(m);
        return {
          month: m,
          breachCount: r?.breachCount ?? 0,
          breachExposure: r ? r.breachExposure.toFixed(4) : '0.0000',
        };
      }),
      refreshedAt: log?.refreshedAt.toISOString() ?? null,
    };
  }
}
