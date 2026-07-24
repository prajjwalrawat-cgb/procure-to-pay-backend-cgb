import { describe, expect, it } from 'vitest';

import {
  autoScoreDelivery,
  autoScorePrice,
  rankByScore,
  validateCriteriaWeights,
  weightedTotal,
  DEFAULT_CRITERIA,
} from './evaluation';

describe('validateCriteriaWeights', () => {
  it('passes when weights sum to 100', () => {
    expect(validateCriteriaWeights(DEFAULT_CRITERIA)).toEqual({ valid: true, sum: 100 });
  });
  it('fails when sum is 99', () => {
    expect(validateCriteriaWeights([{ weight: 60 }, { weight: 39 }]).valid).toBe(false);
  });
  it('fails when sum is 101', () => {
    expect(validateCriteriaWeights([{ weight: 60 }, { weight: 41 }]).valid).toBe(false);
  });
  it('fails when empty', () => {
    expect(validateCriteriaWeights([])).toEqual({ valid: false, sum: 0 });
  });
  it('passes with a single 100% criterion', () => {
    expect(validateCriteriaWeights([{ weight: 100 }]).valid).toBe(true);
  });
});

describe('autoScorePrice', () => {
  const quotes = [
    { quoteId: 'a', totalCommercialValue: '100000', isMsme: false },
    { quoteId: 'b', totalCommercialValue: '120000', isMsme: false },
  ];

  it('identifies L1 and scores relative to it', () => {
    const r = autoScorePrice(quotes, 0);
    const a = r.find((x) => x.quoteId === 'a')!;
    const b = r.find((x) => x.quoteId === 'b')!;
    expect(a.score).toBe('100.00');
    expect(a.isL1Price).toBe(true);
    expect(b.score).toBe('83.33'); // 100000/120000*100
  });

  it('applies MSME preference boost', () => {
    const withMsme = [
      { quoteId: 'a', totalCommercialValue: '100000', isMsme: false },
      { quoteId: 'b', totalCommercialValue: '110000', isMsme: true },
    ];
    const r = autoScorePrice(withMsme, 15);
    const b = r.find((x) => x.quoteId === 'b')!;
    // raw = 100000/110000*100 = 90.91; boosted *1.15 = 104.55
    expect(b.rawScore).toBe('90.91');
    expect(b.score).toBe('104.55');
  });

  it('handles ties (both L1)', () => {
    const r = autoScorePrice(
      [
        { quoteId: 'a', totalCommercialValue: '100000', isMsme: false },
        { quoteId: 'b', totalCommercialValue: '100000', isMsme: false },
      ],
      0,
    );
    expect(r.every((x) => x.isL1Price && x.score === '100.00')).toBe(true);
  });

  it('scores zero-value quotes as 0 (no crash)', () => {
    const r = autoScorePrice(
      [{ quoteId: 'a', totalCommercialValue: '0', isMsme: false }],
      15,
    );
    expect(r[0]!.score).toBe('0.00');
  });
});

describe('autoScoreDelivery', () => {
  it('scores relative to shortest lead, capped at 100', () => {
    const r = autoScoreDelivery([
      { quoteId: 'a', leadDays: 38 },
      { quoteId: 'b', leadDays: 42 },
    ]);
    const a = r.find((x) => x.quoteId === 'a')!;
    const b = r.find((x) => x.quoteId === 'b')!;
    expect(a.score).toBe('100.00');
    expect(a.isL1Lead).toBe(true);
    expect(b.score).toBe('90.48'); // 38/42*100
  });

  it('penalises extreme lead times non-linearly', () => {
    const r = autoScoreDelivery([
      { quoteId: 'fast', leadDays: 10 },
      { quoteId: 'slow', leadDays: 100 },
    ]);
    expect(r.find((x) => x.quoteId === 'slow')!.score).toBe('10.00');
  });

  it('invalid (zero) lead days score 0', () => {
    const r = autoScoreDelivery([{ quoteId: 'a', leadDays: 0 }]);
    expect(r[0]!.score).toBe('0.00');
  });
});

describe('weightedTotal + rankByScore', () => {
  it('computes the weighted total across criteria', () => {
    const total = weightedTotal([
      { criterion: 'price', weight: 60, rawScore: '90' },
      { criterion: 'delivery', weight: 20, rawScore: '100' },
      { criterion: 'quality', weight: 10, rawScore: '80' },
      { criterion: 'msme', weight: 10, rawScore: '0' },
    ]);
    // 54 + 20 + 8 + 0 = 82
    expect(total).toBe('82.00');
  });

  it('ranks by weighted total descending', () => {
    const ranked = rankByScore([
      { quoteId: 'a', total: '82.40' },
      { quoteId: 'b', total: '84.60' },
    ]);
    expect(ranked[0]!.quoteId).toBe('b');
    expect(ranked[0]!.rankLabel).toBe('L1');
    expect(ranked[1]!.rankLabel).toBe('L2');
  });
});
