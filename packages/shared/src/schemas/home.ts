import { z } from 'zod';

import { AnalyticsPeriodQuerySchema } from './analytics';

/**
 * Home command center + Analytics overview contracts.
 *
 * Money is a decimal string (as everywhere else in the API); counts and
 * percentages are numbers. Every series is ascending by `day` ('YYYY-MM-DD',
 * tenant-agnostic UTC day). Figures come from the RLS-protected AnalyticsDaily
 * rollup (ADR-028 pattern — no materialized views), refreshed on read when
 * stale; `asOf` is when that rollup was last recomputed.
 */

// ── Home ─────────────────────────────────────────────────────────────────────

/** One volumetric tile: the headline, a trend series for the sparkline, a delta. */
export interface HomeTile {
  /** Headline value — a decimal string for money tiles, a number otherwise. */
  value: string | number | null;
  /**
   * Up to 30 daily points ending today, same window as `value`'s trend. Stock
   * metrics (open POs, in-flight invoices, active vendors) only have points for
   * days a snapshot was taken, so a new tenant starts with a short series.
   */
  trend: { day: string; value: number }[];
  /** % change vs the comparison window (see `deltaBasis`); null when there is no baseline. */
  deltaPct: number | null;
  /** Human wording of the comparison, e.g. "vs same days last month". */
  deltaBasis: string;
}

export interface HomeSummaryResponse {
  asOf: string;
  tiles: {
    /** Invoice-basis spend (net), month to date. */
    spendMtd: HomeTile;
    openPos: HomeTile;
    invoicesInFlight: HomeTile;
    activeVendors: HomeTile;
    /** Runs with a cycle date in the current Mon–Sun week; `amount` is their net total. */
    paymentRunsThisWeek: HomeTile & { amount: string };
    /** % of MSME invoices due in the last 90 days that were paid by their §15 due date (0–100). */
    msmeComplianceScore: HomeTile;
  };
  /** Daily invoice-basis spend, last 30 days. */
  spendTrend: { day: string; amount: string }[];
  /** Documents created per day, last 14 days. */
  throughput: { day: string; requisitions: number; purchaseOrders: number; invoices: number }[];
}

export const ACTIVITY_KINDS = ['approval', 'rejection', 'submission', 'exception', 'payment', 'receipt', 'order'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export interface ActivityItem {
  id: string;
  at: string;
  kind: ActivityKind;
  /** e.g. "PO-0502 approved". */
  title: string;
  /** e.g. "by R. Das · Purchase order". */
  detail: string | null;
  href: string | null;
}

export const ActivityQuerySchema = z.object({
  /** Cursor: ISO timestamp of the oldest item already shown. */
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type ActivityQuery = z.infer<typeof ActivityQuerySchema>;

export interface ActivityResponse {
  items: ActivityItem[];
  /** Pass as `before` to load older events; null when exhausted. */
  nextBefore: string | null;
}

/**
 * Approval pipeline for requisitions + POs: documents currently at each stage.
 * Stage labels come from the tenant's own matrix step names (most common name
 * per step number), so they read "Plant Head", "Finance Head" … not a fixed list.
 */
export interface ApprovalPipelineResponse {
  stages: { key: string; label: string; count: number }[];
  /** Documents approved in the last 30 days (the funnel's final stage). */
  approved30d: number;
}

export interface UpcomingPaymentRun {
  id: string;
  number: string;
  name: string | null;
  cycleDate: string;
  status: string;
  itemCount: number;
  net: string;
  currency: string;
}
export interface UpcomingPaymentRunsResponse {
  items: UpcomingPaymentRun[];
}

// ── Analytics (new sections) ─────────────────────────────────────────────────

export const AnalyticsOverviewQuerySchema = AnalyticsPeriodQuerySchema;

export interface AnalyticsOverviewResponse {
  asOf: string;
  /** Invoice-basis net spend in the period. */
  spendUnderManagement: string;
  posIssued: number;
  /** Invoices received in the period, excluding rejected. */
  invoicesProcessed: number;
  activeVendors: number;
  /** Median days from invoice receipt to payment, invoices paid in the period. */
  avgInvoiceToPayDays: number | null;
  msmeComplianceScore: number | null;
}

export interface SpendSavingsResponse {
  savingsRealized: { amount: string; pct: number | null; count: number };
  /** Share of period spend with the top 5 vendors (0–100). */
  top5Concentration: number | null;
  /**
   * Off-process spend: POs raised as spot buys, or with neither a contract nor
   * a requisition behind them, as a share of PO value issued in the period.
   */
  maverick: { amount: string; pct: number | null };
  rfqsAwarded: number;
}

export interface CycleStage {
  key: 'req_to_po' | 'po_to_grn' | 'invoice_to_payment';
  label: string;
  medianDays: number | null;
  p90Days: number | null;
  /** Documents measured. */
  n: number;
}
export interface VelocityResponse {
  stages: CycleStage[];
  queue: { pendingApprovals: number; pendingGrns: number; pendingPaymentRuns: number };
  slowestStep: {
    documentType: string;
    stepNo: number;
    stepName: string;
    medianHours: number;
    n: number;
  } | null;
}

export interface MsmeComplianceResponse {
  /** Outstanding (gross − paid) on MSME invoices past their 45-day due date. */
  overdueExposure: string;
  overdueCount: number;
  complianceScore: number | null;
  /** Outstanding MSME invoices due within the next 7 days. */
  approachingCount: number;
  /** All outstanding MSME payables. */
  totalExposure: string;
  /** Outstanding MSME balance by days since invoice date. */
  buckets: { key: '0_29' | '30_44' | '45_59' | '60_plus'; label: string; amount: string; count: number }[];
  /** Most overdue first, max 5. */
  atRisk: {
    invoiceId: string;
    invoiceNumber: string;
    vendorName: string;
    outstanding: string;
    daysOverdue: number;
  }[];
}
