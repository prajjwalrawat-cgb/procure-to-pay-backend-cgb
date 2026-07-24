/**
 * Vendor scorecard + risk scoring math (Slice 7 §6, ADR-022) — pure, testable.
 * The backend gathers raw GRN/invoice/PO/RFQ data (Slices 1/4/5/6); these
 * functions turn metrics into a 0-100 composite score, a grade, and a separate
 * risk-of-doing-business score with time-decay weighting.
 */

import type { VendorRiskGrade } from '../constants/vendor-status';

export interface ScorecardMetrics {
  otifPct: number | null;
  qualityPct: number | null;
  responseTimeAvgHrs: number | null;
  disputeRatePct: number | null;
  paymentCycleDays: number | null;
  rfqParticipationPct: number | null;
  winRatePct: number | null;
}

/** Default composite weights (sum to 1). Tenant-configurable in a later slice. */
export const DEFAULT_SCORECARD_WEIGHTS = {
  otif: 0.3,
  quality: 0.3,
  responseTime: 0.1,
  disputeRate: 0.1,
  paymentCycle: 0.05,
  rfqParticipation: 0.05,
  winRate: 0.1,
} as const;

export type ScorecardWeights = typeof DEFAULT_SCORECARD_WEIGHTS;

/** Cold-start threshold — below this many transactions, grade is N/A. */
export const COLD_START_MIN_TRANSACTIONS = 3;

/** Grade mapping (spec §6): A+ ≥90, A ≥80, B ≥65, C ≥50, D <50. */
export function gradeFromScore(score: number): VendorRiskGrade {
  if (score >= 90) return 'A+';
  if (score >= 80) return 'A';
  if (score >= 65) return 'B';
  if (score >= 50) return 'C';
  return 'D';
}

/** Time-decay weight by record age: ≤90d ×2, ≤365d ×1, older ×0.5. */
export function timeDecayWeight(ageDays: number): number {
  if (ageDays <= 90) return 2;
  if (ageDays <= 365) return 1;
  return 0.5;
}

/** Sub-scores are 0-100. Lower-is-better metrics (response time, dispute rate,
 *  payment cycle) are inverted onto a 0-100 scale before weighting. */
function subScores(m: ScorecardMetrics): Record<keyof ScorecardWeights, number | null> {
  return {
    otif: m.otifPct,
    quality: m.qualityPct,
    // 0 hrs → 100; 168 hrs (1 week) → 0.
    responseTime:
      m.responseTimeAvgHrs === null
        ? null
        : clamp(100 - (m.responseTimeAvgHrs / 168) * 100),
    // 0% disputes → 100; 20%+ → 0.
    disputeRate:
      m.disputeRatePct === null ? null : clamp(100 - (m.disputeRatePct / 20) * 100),
    // 30-day cycle → 100; 90+ → 0.
    paymentCycle:
      m.paymentCycleDays === null
        ? null
        : clamp(100 - ((m.paymentCycleDays - 30) / 60) * 100),
    rfqParticipation: m.rfqParticipationPct,
    winRate: m.winRatePct,
  };
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, n));
}

export interface CompositeResult {
  score: number | null;
  grade: VendorRiskGrade | 'N/A';
  insufficientData: boolean;
}

/**
 * Weighted composite over available metrics (null metrics are skipped and the
 * remaining weights re-normalised). Below the cold-start transaction count the
 * grade is N/A with an "insufficient data" flag; a score is still computed if
 * any metric is present, else null.
 */
export function computeComposite(
  metrics: ScorecardMetrics,
  transactionCount: number,
  weights: ScorecardWeights = DEFAULT_SCORECARD_WEIGHTS,
): CompositeResult {
  const subs = subScores(metrics);
  let weighted = 0;
  let weightSum = 0;
  for (const key of Object.keys(weights) as (keyof ScorecardWeights)[]) {
    const value = subs[key];
    if (value === null || value === undefined) continue;
    weighted += value * weights[key];
    weightSum += weights[key];
  }
  const score = weightSum === 0 ? null : Math.round((weighted / weightSum) * 100) / 100;
  const insufficientData = transactionCount < COLD_START_MIN_TRANSACTIONS;
  return {
    score,
    grade: insufficientData || score === null ? 'N/A' : gradeFromScore(score),
    insufficientData,
  };
}

export interface RiskInputs {
  sanctionsFlagged: boolean;
  adverseMediaFlagged: boolean;
  creditRating: number | null; // 0-100, higher = better
  documentsExpiringSoon: number; // count within 30 days
  documentsExpired: number;
  disputeRatePct: number | null;
  blacklistHistory: boolean;
}

export interface RiskResult {
  score: number; // 0-100, higher = lower risk
  grade: VendorRiskGrade;
}

/**
 * Risk-of-doing-business score (distinct from performance). Sanctions or
 * blacklist history hard-caps the score into D; expired/expiring docs and
 * disputes apply defined deltas.
 */
export function computeRiskScore(inputs: RiskInputs): RiskResult {
  // Hard caps: any sanctions hit or blacklist history → D regardless of the rest.
  if (inputs.sanctionsFlagged || inputs.blacklistHistory) {
    return { score: 20, grade: 'D' };
  }
  let score = 100;
  if (inputs.adverseMediaFlagged) score -= 25;
  if (inputs.creditRating !== null) score -= (100 - inputs.creditRating) * 0.3;
  score -= inputs.documentsExpiringSoon * 5;
  score -= inputs.documentsExpired * 20;
  if (inputs.disputeRatePct !== null) score -= inputs.disputeRatePct * 0.5;
  score = clamp(score);
  return { score: Math.round(score * 100) / 100, grade: gradeFromScore(score) };
}
