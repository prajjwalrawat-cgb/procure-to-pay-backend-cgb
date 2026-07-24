/**
 * Evaluation scoring — pure math (Slice 6 §7). The weighted-criteria model
 * (price 60 / delivery 20 / quality 10 / MSME 10 by default), the sum-to-100
 * weight validator, L1-relative price + delivery auto-scores, and the MSME
 * purchase-preference boost all live here so they can be unit-tested in
 * isolation; QuoteEvaluationService just persists the results.
 */

import Decimal from 'decimal.js';

export interface EvaluationCriterion {
  key: string;
  label: string;
  /** Whole-number percentage weight; the set must sum to 100. */
  weight: number;
  /** price/delivery are auto-scored; quality/technical need a human scorer. */
  auto: boolean;
}

/** The seeded default template (Slice 6 frontend Step 3). */
export const DEFAULT_CRITERIA: EvaluationCriterion[] = [
  { key: 'price', label: 'Price', weight: 60, auto: true },
  { key: 'delivery', label: 'Delivery', weight: 20, auto: true },
  { key: 'quality', label: 'Quality', weight: 10, auto: false },
  { key: 'msme', label: 'MSME preference', weight: 10, auto: false },
];

export interface WeightValidation {
  valid: boolean;
  sum: number;
}

/** Weights must sum to exactly 100 and the set must be non-empty. */
export function validateCriteriaWeights(
  criteria: Array<{ weight: number }>,
): WeightValidation {
  if (criteria.length === 0) return { valid: false, sum: 0 };
  const sum = criteria.reduce((acc, c) => acc + c.weight, 0);
  return { valid: sum === 100, sum };
}

export interface PriceScoreInput {
  quoteId: string;
  totalCommercialValue: string;
  isMsme: boolean;
}

export interface PriceScoreResult {
  quoteId: string;
  rawScore: string;
  /** Post-MSME-preference score used for ranking. */
  score: string;
  isL1Price: boolean;
}

/**
 * price_score = (L1_price / this_price) × 100 where L1 = lowest total across
 * qualified quotes. MSME vendors get a +msmePreferencePct% boost (Indian
 * public-procurement purchase preference).
 */
export function autoScorePrice(
  quotes: PriceScoreInput[],
  msmePreferencePct = 15,
): PriceScoreResult[] {
  const valued = quotes.filter((q) => new Decimal(q.totalCommercialValue).greaterThan(0));
  if (valued.length === 0) {
    return quotes.map((q) => ({
      quoteId: q.quoteId,
      rawScore: '0.00',
      score: '0.00',
      isL1Price: false,
    }));
  }
  const l1 = valued.reduce(
    (min, q) => Decimal.min(min, new Decimal(q.totalCommercialValue)),
    new Decimal(valued[0]!.totalCommercialValue),
  );
  const boost = new Decimal(msmePreferencePct).dividedBy(100).plus(1);

  return quotes.map((q) => {
    const price = new Decimal(q.totalCommercialValue);
    if (price.lessThanOrEqualTo(0)) {
      return { quoteId: q.quoteId, rawScore: '0.00', score: '0.00', isL1Price: false };
    }
    const raw = l1.dividedBy(price).times(100);
    const score = q.isMsme ? raw.times(boost) : raw;
    return {
      quoteId: q.quoteId,
      rawScore: raw.toDecimalPlaces(2).toFixed(2),
      score: score.toDecimalPlaces(2).toFixed(2),
      isL1Price: price.equals(l1),
    };
  });
}

export interface DeliveryScoreInput {
  quoteId: string;
  leadDays: number;
}

export interface DeliveryScoreResult {
  quoteId: string;
  score: string;
  isL1Lead: boolean;
}

/**
 * delivery_score = (L1_lead / this_lead) × 100, capped at 100. Zero/negative
 * lead days score 0 (invalid). L1_lead = shortest lead time.
 */
export function autoScoreDelivery(quotes: DeliveryScoreInput[]): DeliveryScoreResult[] {
  const valid = quotes.filter((q) => q.leadDays > 0);
  if (valid.length === 0) {
    return quotes.map((q) => ({ quoteId: q.quoteId, score: '0.00', isL1Lead: false }));
  }
  const l1 = Math.min(...valid.map((q) => q.leadDays));
  return quotes.map((q) => {
    if (q.leadDays <= 0) {
      return { quoteId: q.quoteId, score: '0.00', isL1Lead: false };
    }
    const raw = new Decimal(l1).dividedBy(q.leadDays).times(100);
    const capped = Decimal.min(raw, 100);
    return {
      quoteId: q.quoteId,
      score: capped.toDecimalPlaces(2).toFixed(2),
      isL1Lead: q.leadDays === l1,
    };
  });
}

export interface CriterionScore {
  criterion: string;
  weight: number;
  rawScore: string;
}

/** Weighted total = Σ (rawScore × weight / 100), 2 dp. */
export function weightedTotal(scores: CriterionScore[]): string {
  const total = scores.reduce(
    (acc, s) => acc.plus(new Decimal(s.rawScore).times(s.weight).dividedBy(100)),
    new Decimal(0),
  );
  return total.toDecimalPlaces(2).toFixed(2);
}

/** Rank quotes by weighted total descending → L1/L2/L3 labels. */
export function rankByScore<T extends { quoteId: string; total: string }>(
  quotes: T[],
): Array<T & { rank: number; rankLabel: string }> {
  return [...quotes]
    .sort((a, b) => new Decimal(b.total).comparedTo(new Decimal(a.total)))
    .map((q, i) => ({ ...q, rank: i + 1, rankLabel: `L${i + 1}` }));
}
