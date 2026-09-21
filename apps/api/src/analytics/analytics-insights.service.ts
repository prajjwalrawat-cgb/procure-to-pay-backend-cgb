import { Injectable } from '@nestjs/common';
import {
  resolvePeriod,
  type AnalyticsPeriodQuery,
  type AnalyticsOverviewResponse,
  type CycleStage,
  type MsmeComplianceResponse,
  type SpendSavingsResponse,
  type VelocityResponse,
} from '@procureflow/shared';
import Decimal from 'decimal.js';

import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsDailyService, SPEND_EXCLUDED_SQL } from './analytics-daily.service';
import { utcDay } from './daily-math';

/** Runs not yet handed to the bank — the payment-run "queue". */
const PENDING_RUN_STATUSES = ['DRAFT', 'COMPOSED', 'PENDING_APPROVAL', 'AWAITING_APPROVAL', 'APPROVED'];
/** POs issued to the vendor and still waiting on (some) goods. */
const AWAITING_GRN_PO_STATUSES = ['ISSUED', 'ACKNOWLEDGED', 'PARTIALLY_RECEIVED'];
/** Minimum decided approvals before a step can be named the slowest. */
const SLOWEST_STEP_MIN_N = 3;

/**
 * Settlement date of a fully paid invoice: Invoice.paid_at, else (older rows)
 * the last PaymentRecord. Expects the invoice aliased `i`.
 */
const PAID_AT_SQL = `COALESCE(i.paid_at, (SELECT MAX(r.paid_at) FROM "PaymentRecord" r WHERE r.invoice_id = i.id))`;

/** MSME outstanding: gross − paid, on invoices neither rejected nor fully paid. */
const MSME_OUTSTANDING_CTE = `
  SELECT i.id, i.number, v.name AS vendor_name, i."invoiceDate",
         GREATEST(i."grossAmount" - i.paid_amount, 0) AS outstanding,
         (COALESCE(i."msmeDueDate", i."invoiceDate" + interval '45 days') AT TIME ZONE 'UTC')::date AS due,
         ($2::date - (i."invoiceDate" AT TIME ZONE 'UTC')::date) AS age_days
  FROM "Invoice" i
  JOIN "Vendor" v ON v.id = i.vendor_id AND v."isMsme" = true
  WHERE i.tenant_id = $1::uuid
    AND i.status NOT IN ('REJECTED','PAID')
    AND i."grossAmount" - i.paid_amount > 0`;

const MSME_BUCKETS: { key: MsmeComplianceResponse['buckets'][number]['key']; label: string }[] = [
  { key: '0_29', label: '0–29 days' },
  { key: '30_44', label: '30–44 days' },
  { key: '45_59', label: '45–59 days' },
  { key: '60_plus', label: '60+ days' },
];

const round1 = (n: number | null | undefined): number | null =>
  n === null || n === undefined || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 10) / 10;

const pctOf = (part: Decimal, whole: Decimal): number | null =>
  whole.gt(0) ? part.div(whole).times(100).toDP(2).toNumber() : null;

/**
 * AnalyticsInsightsService — the rebuilt Analytics page's new sections
 * (overview KPIs, spend & savings, process velocity, MSME compliance). Live
 * aggregate SQL over the period (each a handful of GROUP BYs), except
 * top-5 concentration which reads the vendor-monthly summary like
 * SpendAnalyticsService.getConcentrationRisk.
 */
@Injectable()
export class AnalyticsInsightsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly daily: AnalyticsDailyService,
  ) {}

  private tenantId(): string {
    const t = this.prisma.currentTenantId;
    if (!t) throw new Error('AnalyticsInsightsService requires a tenant context');
    return t;
  }

  async getOverview(q: AnalyticsPeriodQuery, now = new Date()): Promise<AnalyticsOverviewResponse> {
    const tenantId = this.tenantId();
    const asOf = await this.daily.ensureFresh(tenantId);
    const p = resolvePeriod(q, now);
    const rows = await this.prisma.client.$queryRawUnsafe<
      {
        spend: string;
        pos_issued: number;
        invoices_processed: number;
        active_vendors: number;
        median_days: number | null;
      }[]
    >(
      `SELECT
         (SELECT COALESCE(SUM("netAmount"),0)::text FROM "Invoice"
            WHERE tenant_id = $1::uuid AND status NOT IN (${SPEND_EXCLUDED_SQL})
              AND "invoiceDate" >= $2::timestamptz AND "invoiceDate" < $3::timestamptz) AS spend,
         (SELECT COUNT(*)::int FROM "PurchaseOrder"
            WHERE tenant_id = $1::uuid AND "issuedAt" >= $2::timestamptz AND "issuedAt" < $3::timestamptz) AS pos_issued,
         (SELECT COUNT(*)::int FROM "Invoice"
            WHERE tenant_id = $1::uuid AND status <> 'REJECTED'
              AND "receivedAt" >= $2::timestamptz AND "receivedAt" < $3::timestamptz) AS invoices_processed,
         (SELECT COUNT(*)::int FROM "Vendor"
            WHERE tenant_id = $1::uuid AND lifecycle_status = 'ACTIVE') AS active_vendors,
         (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY (EXTRACT(EPOCH FROM (x.paid - x."receivedAt")) / 86400.0)::float8)
            FROM (SELECT i."receivedAt", ${PAID_AT_SQL} AS paid FROM "Invoice" i
                  WHERE i.tenant_id = $1::uuid AND i.status = 'PAID') x
            WHERE x.paid >= $2::timestamptz AND x.paid < $3::timestamptz AND x.paid >= x."receivedAt") AS median_days`,
      tenantId,
      p.start.toISOString(),
      p.end.toISOString(),
    );
    const r = rows[0];
    // Score as of the period's last day (today for the rolling periods).
    const scoreDay = utcDay(new Date(Math.min(now.getTime(), p.end.getTime() - 1)));
    const [score] = await this.daily.msmeScoreSeries(tenantId, scoreDay, scoreDay);
    return {
      asOf: asOf.toISOString(),
      spendUnderManagement: new Decimal(r?.spend ?? '0').toFixed(4),
      posIssued: Number(r?.pos_issued ?? 0),
      invoicesProcessed: Number(r?.invoices_processed ?? 0),
      activeVendors: Number(r?.active_vendors ?? 0),
      avgInvoiceToPayDays: round1(r?.median_days),
      msmeComplianceScore: score?.score ?? null,
    };
  }

  async getSpendSavings(q: AnalyticsPeriodQuery, now = new Date()): Promise<SpendSavingsResponse> {
    const tenantId = this.tenantId();
    const p = resolvePeriod(q, now);

    // Savings: CONFIRMED ledger entries in the period's months (as the savings
    // tracker does); pct = savings ÷ baseline value.
    const savings = await this.prisma.client.savingsLedgerEntry.aggregate({
      where: { periodMonth: { in: p.months }, status: 'CONFIRMED' },
      _sum: { savingsAmount: true, baselineValue: true },
      _count: { _all: true },
    });
    const savedAmt = new Decimal(savings._sum.savingsAmount?.toString() ?? '0');
    const baseline = new Decimal(savings._sum.baselineValue?.toString() ?? '0');

    // Top-5 concentration from the vendor-monthly summary.
    const vm = await this.prisma.client.analyticsVendorMonthly.groupBy({
      by: ['vendorId'],
      where: { month: { in: p.months } },
      _sum: { netSpend: true },
    });
    const nets = vm
      .map((v) => new Decimal(v._sum.netSpend?.toString() ?? '0'))
      .sort((a, b) => b.comparedTo(a));
    const total = nets.reduce((s, n) => s.plus(n), new Decimal(0));
    const top5 = nets.slice(0, 5).reduce((s, n) => s.plus(n), new Decimal(0));

    const po = await this.prisma.client.$queryRawUnsafe<{ total: string; maverick: string }[]>(
      `SELECT COALESCE(SUM("totalAmount"),0)::text AS total,
              COALESCE(SUM("totalAmount") FILTER (
                WHERE po_type = 'SPOT_BUY' OR is_spot_buy
                   OR (contract_id IS NULL AND requisition_id IS NULL)),0)::text AS maverick
       FROM "PurchaseOrder"
       WHERE tenant_id = $1::uuid AND "issuedAt" >= $2::timestamptz AND "issuedAt" < $3::timestamptz`,
      tenantId,
      p.start.toISOString(),
      p.end.toISOString(),
    );
    const poTotal = new Decimal(po[0]?.total ?? '0');
    const maverick = new Decimal(po[0]?.maverick ?? '0');

    const rfqsAwarded = await this.prisma.client.award.count({
      where: {
        status: { in: ['APPROVED', 'PO_ISSUED'] },
        approvedAt: { gte: p.start, lt: p.end },
      },
    });

    return {
      savingsRealized: {
        amount: savedAmt.toFixed(4),
        pct: pctOf(savedAmt, baseline),
        count: savings._count._all,
      },
      top5Concentration: pctOf(top5, total),
      maverick: { amount: maverick.toFixed(4), pct: pctOf(maverick, poTotal) },
      rfqsAwarded,
    };
  }

  async getVelocity(q: AnalyticsPeriodQuery, now = new Date()): Promise<VelocityResponse> {
    const tenantId = this.tenantId();
    const p = resolvePeriod(q, now);
    const args = [tenantId, p.start.toISOString(), p.end.toISOString()] as const;
    const pct = `percentile_cont(0.5) WITHIN GROUP (ORDER BY d) AS median,
                 percentile_cont(0.9) WITHIN GROUP (ORDER BY d) AS p90, COUNT(*)::int AS n`;
    type Agg = { median: number | null; p90: number | null; n: number };

    // Requisition submitted (earliest SUBMITTED_FOR_APPROVAL audit, else first
    // approval row) → its first PO; measured for first POs created in the period.
    const reqToPo = await this.prisma.client.$queryRawUnsafe<Agg[]>(
      `WITH first_po AS (
         SELECT requisition_id, MIN("createdAt") AS at FROM "PurchaseOrder"
         WHERE tenant_id = $1::uuid AND requisition_id IS NOT NULL
         GROUP BY 1
       ),
       x AS (
         SELECT fp.at,
                COALESCE(
                  (SELECT MIN(a."timestamp") FROM "AuditLog" a
                    WHERE a.tenant_id = $1::uuid AND a."entityType" = 'Requisition'
                      AND a."entityId" = fp.requisition_id AND a.action = 'SUBMITTED_FOR_APPROVAL'),
                  (SELECT MIN(ap."createdAt") FROM "Approval" ap
                    WHERE ap.tenant_id = $1::uuid AND ap."documentType" = 'REQUISITION'
                      AND ap.document_id = fp.requisition_id)
                ) AS submitted
         FROM first_po fp
         WHERE fp.at >= $2::timestamptz AND fp.at < $3::timestamptz
       )
       SELECT ${pct} FROM (
         SELECT (EXTRACT(EPOCH FROM (at - submitted)) / 86400.0)::float8 AS d FROM x
         WHERE submitted IS NOT NULL AND at >= submitted
       ) s`,
      ...args,
    );

    // PO issued → first (non-draft, non-reversed) GRN received, for first GRNs in the period.
    const poToGrn = await this.prisma.client.$queryRawUnsafe<Agg[]>(
      `SELECT ${pct} FROM (
         SELECT (EXTRACT(EPOCH FROM (g.first_at - po."issuedAt")) / 86400.0)::float8 AS d
         FROM "PurchaseOrder" po
         JOIN (
           SELECT po_id, MIN("receivedAt") AS first_at FROM "GoodsReceiptNote"
           WHERE tenant_id = $1::uuid AND status NOT IN ('DRAFT','REVERSED')
           GROUP BY 1
         ) g ON g.po_id = po.id
         WHERE po.tenant_id = $1::uuid AND po."issuedAt" IS NOT NULL
           AND g.first_at >= $2::timestamptz AND g.first_at < $3::timestamptz
           AND g.first_at >= po."issuedAt"
       ) s`,
      ...args,
    );

    // Invoice received → fully paid, for invoices paid in the period.
    const invToPay = await this.prisma.client.$queryRawUnsafe<Agg[]>(
      `SELECT ${pct} FROM (
         SELECT (EXTRACT(EPOCH FROM (x.paid - x."receivedAt")) / 86400.0)::float8 AS d
         FROM (SELECT i."receivedAt", ${PAID_AT_SQL} AS paid FROM "Invoice" i
               WHERE i.tenant_id = $1::uuid AND i.status = 'PAID') x
         WHERE x.paid >= $2::timestamptz AND x.paid < $3::timestamptz AND x.paid >= x."receivedAt"
       ) s`,
      ...args,
    );

    const stage = (key: CycleStage['key'], label: string, a: Agg | undefined): CycleStage => ({
      key,
      label,
      medianDays: round1(a?.median),
      p90Days: round1(a?.p90),
      n: Number(a?.n ?? 0),
    });

    const queue = await this.prisma.client.$queryRawUnsafe<
      { approvals: number; grns: number; runs: number }[]
    >(
      `SELECT
         (SELECT COUNT(DISTINCT ("documentType", document_id))::int FROM "Approval"
            WHERE tenant_id = $1::uuid AND decision = 'PENDING') AS approvals,
         (SELECT COUNT(*)::int FROM "PurchaseOrder"
            WHERE tenant_id = $1::uuid AND status::text = ANY($2::text[])) AS grns,
         (SELECT COUNT(*)::int FROM "PaymentRun"
            WHERE tenant_id = $1::uuid AND status::text = ANY($3::text[])) AS runs`,
      tenantId,
      AWAITING_GRN_PO_STATUSES,
      PENDING_RUN_STATUSES,
    );

    const slow = await this.prisma.client.$queryRawUnsafe<
      { document_type: string; step_no: number; step_name: string | null; median_hours: number; n: number }[]
    >(
      `SELECT "documentType"::text AS document_type, "stepNo" AS step_no,
              mode() WITHIN GROUP (ORDER BY step_name) AS step_name,
              percentile_cont(0.5) WITHIN GROUP (
                ORDER BY (EXTRACT(EPOCH FROM ("decidedAt" - "createdAt")) / 3600.0)::float8) AS median_hours,
              COUNT(*)::int AS n
       FROM "Approval"
       WHERE tenant_id = $1::uuid AND "decidedAt" IS NOT NULL
         AND decision IN ('APPROVED','REJECTED','CHANGES_REQUESTED')
         AND "decidedAt" >= $2::timestamptz AND "decidedAt" < $3::timestamptz
       GROUP BY 1, 2
       HAVING COUNT(*) >= ${SLOWEST_STEP_MIN_N}
       ORDER BY median_hours DESC
       LIMIT 1`,
      ...args,
    );
    const s = slow[0];

    return {
      stages: [
        stage('req_to_po', 'Requisition → PO', reqToPo[0]),
        stage('po_to_grn', 'PO → Goods receipt', poToGrn[0]),
        stage('invoice_to_payment', 'Invoice → Payment', invToPay[0]),
      ],
      queue: {
        pendingApprovals: Number(queue[0]?.approvals ?? 0),
        pendingGrns: Number(queue[0]?.grns ?? 0),
        pendingPaymentRuns: Number(queue[0]?.runs ?? 0),
      },
      slowestStep: s
        ? {
            documentType: s.document_type,
            stepNo: Number(s.step_no),
            stepName: s.step_name ?? `Step ${s.step_no}`,
            medianHours: round1(s.median_hours) ?? 0,
            n: Number(s.n),
          }
        : null,
    };
  }

  /**
   * MSME compliance (period-independent: a snapshot of what is owed now; the
   * period query is accepted for route symmetry). Outstanding = gross − paid on
   * MSME invoices that are neither rejected nor fully paid; due date = the §15
   * msmeDueDate, else invoice date + 45 days.
   */
  async getMsmeCompliance(_q: AnalyticsPeriodQuery, now = new Date()): Promise<MsmeComplianceResponse> {
    const tenantId = this.tenantId();
    const today = utcDay(now);
    const todayKey = today.toISOString().slice(0, 10);

    const totals = await this.prisma.client.$queryRawUnsafe<
      {
        total: string;
        overdue: string;
        overdue_cnt: number;
        approaching_cnt: number;
        b0: string; c0: number; b30: string; c30: number;
        b45: string; c45: number; b60: string; c60: number;
      }[]
    >(
      `WITH o AS (${MSME_OUTSTANDING_CTE})
       SELECT COALESCE(SUM(outstanding),0)::text AS total,
              COALESCE(SUM(outstanding) FILTER (WHERE due < $2::date),0)::text AS overdue,
              COUNT(*) FILTER (WHERE due < $2::date)::int AS overdue_cnt,
              COUNT(*) FILTER (WHERE due >= $2::date AND due < $2::date + 7)::int AS approaching_cnt,
              COALESCE(SUM(outstanding) FILTER (WHERE age_days < 30),0)::text AS b0,
              COUNT(*) FILTER (WHERE age_days < 30)::int AS c0,
              COALESCE(SUM(outstanding) FILTER (WHERE age_days >= 30 AND age_days < 45),0)::text AS b30,
              COUNT(*) FILTER (WHERE age_days >= 30 AND age_days < 45)::int AS c30,
              COALESCE(SUM(outstanding) FILTER (WHERE age_days >= 45 AND age_days < 60),0)::text AS b45,
              COUNT(*) FILTER (WHERE age_days >= 45 AND age_days < 60)::int AS c45,
              COALESCE(SUM(outstanding) FILTER (WHERE age_days >= 60),0)::text AS b60,
              COUNT(*) FILTER (WHERE age_days >= 60)::int AS c60
       FROM o`,
      tenantId,
      todayKey,
    );
    const t = totals[0];
    const atRisk = await this.prisma.client.$queryRawUnsafe<
      { id: string; number: string; vendor_name: string; outstanding: string; days_overdue: number }[]
    >(
      `WITH o AS (${MSME_OUTSTANDING_CTE})
       SELECT id, number, vendor_name, outstanding::text AS outstanding,
              ($2::date - due)::int AS days_overdue
       FROM o WHERE due < $2::date
       ORDER BY days_overdue DESC, outstanding DESC
       LIMIT 5`,
      tenantId,
      todayKey,
    );
    const [score] = await this.daily.msmeScoreSeries(tenantId, today, today);

    const money = (v: string | undefined): string => new Decimal(v ?? '0').toFixed(4);
    const bucketVals: [string | undefined, number | undefined][] = [
      [t?.b0, t?.c0],
      [t?.b30, t?.c30],
      [t?.b45, t?.c45],
      [t?.b60, t?.c60],
    ];
    return {
      overdueExposure: money(t?.overdue),
      overdueCount: Number(t?.overdue_cnt ?? 0),
      complianceScore: score?.score ?? null,
      approachingCount: Number(t?.approaching_cnt ?? 0),
      totalExposure: money(t?.total),
      buckets: MSME_BUCKETS.map((b, i) => ({
        key: b.key,
        label: b.label,
        amount: money(bucketVals[i]![0]),
        count: Number(bucketVals[i]![1] ?? 0),
      })),
      atRisk: atRisk.map((r) => ({
        invoiceId: r.id,
        invoiceNumber: r.number,
        vendorName: r.vendor_name,
        outstanding: money(r.outstanding),
        daysOverdue: Number(r.days_overdue),
      })),
    };
  }
}
