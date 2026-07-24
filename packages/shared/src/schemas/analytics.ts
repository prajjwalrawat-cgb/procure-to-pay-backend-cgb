import { z } from 'zod';

import { ANALYTICS_PERIODS } from '../analytics/period';

// ── Input schemas ────────────────────────────────────────────────────────────

export const AnalyticsPeriodQuerySchema = z.object({
  period: z.enum(ANALYTICS_PERIODS).default('LAST_12M'),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  compareToLastYear: z.coerce.boolean().optional(),
  plantId: z.string().optional(),
  costCenterId: z.string().optional(),
  category: z.string().optional(),
});
export type AnalyticsPeriodQuery = z.infer<typeof AnalyticsPeriodQuerySchema>;

export const TopVendorsQuerySchema = AnalyticsPeriodQuerySchema.extend({
  n: z.coerce.number().int().min(1).max(50).default(10),
  sortBy: z.enum(['value', 'volume', 'savings']).default('value'),
});
export type TopVendorsQuery = z.infer<typeof TopVendorsQuerySchema>;

export const MsmeBucketParamSchema = z.enum([
  'SAFE_0_29',
  'APPROACHING_30_44',
  'BREACH_45_PLUS',
]);
export type MsmeBucketKey = z.infer<typeof MsmeBucketParamSchema>;

export const AvoidedCostInputSchema = z.object({
  vendorId: z.string().optional(),
  category: z.string().optional(),
  baselineValue: z.string(), // decimal-as-string
  awardedValue: z.string(),
  notes: z.string().min(10).max(1000), // justification required
});
export type AvoidedCostInput = z.infer<typeof AvoidedCostInputSchema>;

export const RefreshTriggerSchema = z.object({
  views: z.array(z.string()).optional(), // omit = all
});
export type RefreshTrigger = z.infer<typeof RefreshTriggerSchema>;

// ── Savings methodology (single source of truth for FE tooltips + BE labels) ──

export const SAVINGS_INITIATIVE_TYPES = [
  'HARD_RFQ',
  'PRICE_IMPROVEMENT',
  'SOFT_PAYMENT_TERM',
  'AVOIDED_COST',
] as const;
export type SavingsInitiativeType = (typeof SAVINGS_INITIATIVE_TYPES)[number];

export interface SavingsMethodologyMeta {
  label: string;
  shortLabel: string;
  methodology: string;
  selfReported: boolean;
  /** whether it may be summed into the "hard savings" headline */
  hard: boolean;
}

export const SAVINGS_METHODOLOGY: Record<SavingsInitiativeType, SavingsMethodologyMeta> =
  {
    HARD_RFQ: {
      label: 'Hard savings (RFQ-sourced)',
      shortLabel: 'Hard savings',
      methodology:
        'Baseline = highest qualified quote for the awarded line; awarded = actual award price. Auto-computed from RFQ award data.',
      selfReported: false,
      hard: true,
    },
    PRICE_IMPROVEMENT: {
      label: 'Price improvement (spot buy)',
      shortLabel: 'Price improvement',
      methodology:
        'PO unit price below the item reference price at time of order. Labelled "price improvement" — the system cannot distinguish negotiation from luck. Excludes any PO that originated from an awarded RFQ (no double counting).',
      selfReported: false,
      hard: false,
    },
    SOFT_PAYMENT_TERM: {
      label: 'Soft savings (working capital)',
      shortLabel: 'Working capital',
      methodology:
        'Estimated working-capital benefit of extended payment terms = amount × cost-of-capital × days-extended / 365. An estimate, never merged into hard savings.',
      selfReported: false,
      hard: false,
    },
    AVOIDED_COST: {
      label: 'Avoided cost (self-reported)',
      shortLabel: 'Avoided cost',
      methodology:
        'Manually logged by procurement with a justification and review. Self-reported and the most gameable category — shown separately.',
      selfReported: true,
      hard: false,
    },
  };

// ── Response types ───────────────────────────────────────────────────────────

/** Every analytics response carries the staleness stamp of its underlying view. */
export interface AsOf {
  refreshedAt: string | null;
}

export interface TotalSpendResponse extends AsOf {
  grossSpend: string;
  taxSpend: string;
  netSpend: string;
  transactionCount: number;
  periodLabel: string;
}

export interface SpendTrendPoint {
  month: string; // 'YYYY-MM'
  netSpend: string;
  priorYearNetSpend: string | null;
}
export interface SpendTrendResponse extends AsOf {
  points: SpendTrendPoint[];
  comparedToLastYear: boolean;
}

export interface CategorySlice {
  category: string;
  netSpend: string;
  pct: number;
}
export interface SpendByCategoryResponse extends AsOf {
  slices: CategorySlice[];
  totalNetSpend: string;
  basis: 'PO_LINE'; // derived from PO/requisition line category (invoices carry no category)
}

export interface TopVendorRow {
  vendorId: string;
  vendorName: string;
  isMsme: boolean;
  netSpend: string;
  transactionCount: number;
  savingsAmount: string;
  pctOfTotal: number;
}
export interface TopVendorsResponse extends AsOf {
  vendors: TopVendorRow[];
  totalNetSpend: string;
  sortBy: string;
}

export interface ConcentrationResponse extends AsOf {
  topN: number;
  concentrationPct: number;
  priorConcentrationPct: number | null;
  totalNetSpend: string;
  vendors: TopVendorRow[];
}

export interface ContractCoverageResponse extends AsOf {
  totalSpend: string;
  contractedSpend: string;
  coveragePct: number;
  note: string | null; // honest zero-state copy when no contracts exist yet
}

export interface MsmeBucket {
  bucket: MsmeBucketKey;
  invoiceCount: number;
  totalExposure: string;
  avgDays: number;
}
export interface MsmeDashboardResponse extends AsOf {
  asOfDate: string;
  buckets: MsmeBucket[];
  msmeSpendNet: string;
  totalSpendNet: string;
  msmeSpendPct: number;
  live: true; // buckets are computed live, not from an overnight refresh
}

export interface MsmeExposureRow {
  invoiceId: string;
  invoiceNumber: string;
  vendorId: string;
  vendorName: string;
  invoiceDate: string;
  dueDate: string | null;
  daysOutstanding: number;
  netAmount: string;
  interestIfBreached: string;
}
export interface MsmeExposureResponse extends AsOf {
  bucket: MsmeBucketKey;
  rows: MsmeExposureRow[];
  totalExposure: string;
  totalInterest: string;
  rbiReferenceRatePct: string;
  interestMultiplier: number; // 3 (Master Context §9)
}

export interface MsmeComplianceTrendPoint {
  month: string;
  breachCount: number;
  breachExposure: string;
}
export interface MsmeComplianceTrendResponse extends AsOf {
  points: MsmeComplianceTrendPoint[];
}

export interface SavingsCategoryTotal {
  initiativeType: SavingsInitiativeType;
  label: string;
  amount: string;
  count: number;
  selfReported: boolean;
  hard: boolean;
}
export interface SavingsInitiativeRow {
  id: string;
  initiativeType: SavingsInitiativeType;
  sourceType: string;
  sourceId: string | null;
  vendorId: string | null;
  category: string | null;
  savingsAmount: string;
  savingsPct: string;
  baselineValue: string;
  awardedValue: string;
  createdAt: string;
  status: string;
  notes: string | null;
}
export interface SavingsSummaryResponse extends AsOf {
  totals: SavingsCategoryTotal[];
  hardSavingsTotal: string;
  allInSavingsTotal: string;
  initiatives: SavingsInitiativeRow[];
  trend: { month: string; amount: string }[];
}

export interface BuyerLeaderboardRow {
  buyerId: string;
  buyerName: string;
  savingsAmount: string;
  initiativeCount: number;
}
export interface BuyerLeaderboardResponse extends AsOf {
  rows: BuyerLeaderboardRow[];
}

export interface ExceptionTypeRate {
  exceptionType: string;
  count: number;
  pct: number;
}
export interface ApPerformanceResponse extends AsOf {
  avgCycleDays: number;
  avgCycleDaysWithException: number;
  avgCycleDaysCleanMatch: number;
  firstPassYieldPct: number;
  exceptionRatePct: number;
  straightThroughPct: number;
  discountCapturePct: number | null; // null = no discount terms in use (honest)
  invoicesTotal: number;
  exceptionBreakdown: ExceptionTypeRate[];
  cycleTrend: { month: string; withException: number; cleanMatch: number }[];
  fpyTrend: { month: string; pct: number }[];
  stpTrend: { month: string; pct: number }[];
}

export interface CategoryPerformanceRow {
  category: string;
  vendorCount: number;
  avgScore: number | null;
  netSpend: string;
}
export interface CategoryPerformanceResponse extends AsOf {
  rows: CategoryPerformanceRow[];
}

export interface RiskDistributionResponse extends AsOf {
  distribution: { grade: string; count: number }[];
  totalVendors: number;
}

export interface MsmeParticipationResponse extends AsOf {
  msmeSpendPct: number;
  msmeVendorCount: number;
  totalVendorCount: number;
  msmeRfqParticipationPct: number;
}

export interface RefreshResponse {
  triggered: string[];
  refreshedAt: string;
}
