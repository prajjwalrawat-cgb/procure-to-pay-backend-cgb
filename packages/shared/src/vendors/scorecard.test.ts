import { describe, expect, it } from 'vitest';

import { isVendorFaultRejection } from '../constants/status';
import {
  computeComposite,
  computeRiskScore,
  gradeFromScore,
  timeDecayWeight,
  type ScorecardMetrics,
} from './scorecard';

const FULL: ScorecardMetrics = {
  otifPct: 94,
  qualityPct: 98.2,
  responseTimeAvgHrs: 24,
  disputeRatePct: 2,
  paymentCycleDays: 38,
  rfqParticipationPct: 80,
  winRatePct: 60,
};

describe('gradeFromScore', () => {
  it('maps score bands to grades', () => {
    expect(gradeFromScore(95)).toBe('A+');
    expect(gradeFromScore(90)).toBe('A+');
    expect(gradeFromScore(85)).toBe('A');
    expect(gradeFromScore(70)).toBe('B');
    expect(gradeFromScore(55)).toBe('C');
    expect(gradeFromScore(40)).toBe('D');
  });
});

describe('timeDecayWeight', () => {
  it('weights recent records more', () => {
    expect(timeDecayWeight(30)).toBe(2);
    expect(timeDecayWeight(200)).toBe(1);
    expect(timeDecayWeight(500)).toBe(0.5);
  });
});

describe('computeComposite', () => {
  it('cold-start (<3 transactions) → N/A grade, insufficient flag', () => {
    const r = computeComposite(FULL, 2);
    expect(r.insufficientData).toBe(true);
    expect(r.grade).toBe('N/A');
    expect(r.score).not.toBeNull();
  });

  it('computes a graded score with ≥3 transactions', () => {
    const r = computeComposite(FULL, 10);
    expect(r.insufficientData).toBe(false);
    expect(r.score).toBeGreaterThan(80);
    expect(r.grade).toBe('A');
  });

  it('re-normalises weights when some metrics are null', () => {
    const partial: ScorecardMetrics = {
      ...FULL,
      responseTimeAvgHrs: null,
      disputeRatePct: null,
      paymentCycleDays: null,
      rfqParticipationPct: null,
      winRatePct: null,
    };
    const r = computeComposite(partial, 5);
    // Only OTIF (94) + quality (98.2) remain → ~96.
    expect(r.score).toBeGreaterThan(95);
    expect(r.grade).toBe('A+');
  });

  it('returns null score when no metrics present', () => {
    const empty: ScorecardMetrics = {
      otifPct: null,
      qualityPct: null,
      responseTimeAvgHrs: null,
      disputeRatePct: null,
      paymentCycleDays: null,
      rfqParticipationPct: null,
      winRatePct: null,
    };
    expect(computeComposite(empty, 5).score).toBeNull();
  });
});

describe('computeRiskScore', () => {
  it('clean vendor scores A+', () => {
    const r = computeRiskScore({
      sanctionsFlagged: false,
      adverseMediaFlagged: false,
      creditRating: 95,
      documentsExpiringSoon: 0,
      documentsExpired: 0,
      disputeRatePct: 1,
      blacklistHistory: false,
    });
    expect(r.grade).toBe('A+');
  });

  it('sanctions hit → D regardless of other metrics', () => {
    const r = computeRiskScore({
      sanctionsFlagged: true,
      adverseMediaFlagged: false,
      creditRating: 100,
      documentsExpiringSoon: 0,
      documentsExpired: 0,
      disputeRatePct: 0,
      blacklistHistory: false,
    });
    expect(r.grade).toBe('D');
  });

  it('blacklist history → D', () => {
    const r = computeRiskScore({
      sanctionsFlagged: false,
      adverseMediaFlagged: false,
      creditRating: 100,
      documentsExpiringSoon: 0,
      documentsExpired: 0,
      disputeRatePct: 0,
      blacklistHistory: true,
    });
    expect(r.grade).toBe('D');
  });

  it('expired documents drop the score', () => {
    const base = {
      sanctionsFlagged: false,
      adverseMediaFlagged: false,
      creditRating: 95,
      documentsExpiringSoon: 0,
      documentsExpired: 0,
      disputeRatePct: 1,
      blacklistHistory: false,
    };
    const clean = computeRiskScore(base).score;
    const expired = computeRiskScore({ ...base, documentsExpired: 2 }).score;
    expect(expired).toBeLessThan(clean);
    expect(clean - expired).toBeCloseTo(40, 0);
  });
});

describe('isVendorFaultRejection (I9 — quality attribution)', () => {
  it('counts vendor-fault defects against quality', () => {
    for (const r of [
      'VISIBLE_DAMAGE',
      'WRONG_SPEC',
      'QUALITY_FAIL_DIM',
      'DOCUMENTATION_MISSING',
    ]) {
      expect(isVendorFaultRejection(r)).toBe(true);
    }
  });
  it('excludes buyer-fault over-supply rejections (QUANTITY_SHORT)', () => {
    expect(isVendorFaultRejection('QUANTITY_SHORT')).toBe(false);
  });
  it('treats unknown/null reasons as vendor-fault (conservative)', () => {
    expect(isVendorFaultRejection(null)).toBe(true);
    expect(isVendorFaultRejection(undefined)).toBe(true);
  });
});
