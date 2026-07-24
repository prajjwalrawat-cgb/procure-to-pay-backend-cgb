import { describe, expect, it } from 'vitest';

import {
  conditionDepth,
  evaluateConditions,
  resolveField,
  type ApprovalContext,
  type Condition,
} from './evaluator';

const ctx: ApprovalContext = {
  total_amount: '216884.00',
  tax_amount: '33084.00',
  aging_days: 41,
  category: 'spares',
  currency: 'INR',
  vendor: { is_msme: true, gstin: '24AABCP1234K1Z5' },
  tags: ['fabrication', 'spares'],
};

describe('resolveField', () => {
  it('resolves a top-level field', () => {
    expect(resolveField(ctx, 'total_amount')).toBe('216884.00');
  });
  it('resolves a nested dotted field', () => {
    expect(resolveField(ctx, 'vendor.is_msme')).toBe(true);
  });
  it('returns undefined for a missing field', () => {
    expect(resolveField(ctx, 'vendor.missing')).toBeUndefined();
    expect(resolveField(ctx, 'nope.deeper')).toBeUndefined();
  });
});

describe('evaluateConditions — leaf ops', () => {
  it('eq on a numeric (money) string compares by value', () => {
    expect(
      evaluateConditions({ field: 'total_amount', op: 'eq', value: 216884 }, ctx).matched,
    ).toBe(true);
  });
  it('ne on an enum field', () => {
    expect(
      evaluateConditions({ field: 'category', op: 'ne', value: 'fuel' }, ctx).matched,
    ).toBe(true);
  });
  it('gt / gte / lt / lte on money', () => {
    expect(
      evaluateConditions({ field: 'total_amount', op: 'gt', value: '200000' }, ctx)
        .matched,
    ).toBe(true);
    expect(
      evaluateConditions({ field: 'total_amount', op: 'gte', value: '216884' }, ctx)
        .matched,
    ).toBe(true);
    expect(
      evaluateConditions({ field: 'total_amount', op: 'lt', value: '500000' }, ctx)
        .matched,
    ).toBe(true);
    expect(
      evaluateConditions({ field: 'total_amount', op: 'lte', value: '216884' }, ctx)
        .matched,
    ).toBe(true);
  });
  it('comparison against a non-numeric value is false', () => {
    expect(
      evaluateConditions({ field: 'category', op: 'gt', value: 'aaa' }, ctx).matched,
    ).toBe(false);
  });
  it('eq on a boolean field', () => {
    expect(
      evaluateConditions({ field: 'vendor.is_msme', op: 'eq', value: true }, ctx).matched,
    ).toBe(true);
    expect(
      evaluateConditions({ field: 'vendor.is_msme', op: 'ne', value: false }, ctx)
        .matched,
    ).toBe(true);
  });
  it('in / nin membership', () => {
    expect(
      evaluateConditions({ field: 'category', op: 'in', value: ['spares', 'fuel'] }, ctx)
        .matched,
    ).toBe(true);
    expect(
      evaluateConditions({ field: 'category', op: 'nin', value: ['fuel'] }, ctx).matched,
    ).toBe(true);
    expect(
      evaluateConditions({ field: 'category', op: 'in', value: 'not-array' }, ctx)
        .matched,
    ).toBe(false);
  });
  it('contains on an array and on a string', () => {
    expect(
      evaluateConditions({ field: 'tags', op: 'contains', value: 'spares' }, ctx).matched,
    ).toBe(true);
    expect(
      evaluateConditions({ field: 'category', op: 'contains', value: 'par' }, ctx)
        .matched,
    ).toBe(true);
    expect(
      evaluateConditions({ field: 'aging_days', op: 'contains', value: '4' }, ctx)
        .matched,
    ).toBe(false);
  });
  it('missing field yields a false leaf (except ne)', () => {
    expect(evaluateConditions({ field: 'nope', op: 'eq', value: '1' }, ctx).matched).toBe(
      false,
    );
    expect(evaluateConditions({ field: 'nope', op: 'ne', value: '1' }, ctx).matched).toBe(
      true,
    );
  });
});

describe('evaluateConditions — groups', () => {
  it('all (AND) — every child must pass', () => {
    const c: Condition = {
      all: [
        { field: 'total_amount', op: 'lte', value: '500000' },
        { field: 'vendor.is_msme', op: 'eq', value: true },
      ],
    };
    expect(evaluateConditions(c, ctx).matched).toBe(true);
  });
  it('all fails when one child fails', () => {
    const c: Condition = {
      all: [
        { field: 'total_amount', op: 'gt', value: '500000' },
        { field: 'vendor.is_msme', op: 'eq', value: true },
      ],
    };
    expect(evaluateConditions(c, ctx).matched).toBe(false);
  });
  it('any (OR) — at least one child passes', () => {
    const c: Condition = {
      any: [
        { field: 'total_amount', op: 'gt', value: '10000000' },
        { field: 'category', op: 'eq', value: 'spares' },
      ],
    };
    expect(evaluateConditions(c, ctx).matched).toBe(true);
  });
  it('empty any group does not match', () => {
    expect(evaluateConditions({ any: [] }, ctx).matched).toBe(false);
  });
  it('none (NOT any) — passes when no child passes', () => {
    const c: Condition = { none: [{ field: 'category', op: 'eq', value: 'fuel' }] };
    expect(evaluateConditions(c, ctx).matched).toBe(true);
  });
  it('none fails when a child passes', () => {
    const c: Condition = { none: [{ field: 'category', op: 'eq', value: 'spares' }] };
    expect(evaluateConditions(c, ctx).matched).toBe(false);
  });
  it('nested all/any/none combine correctly', () => {
    const c: Condition = {
      all: [
        { field: 'total_amount', op: 'gte', value: '100000' },
        {
          any: [
            { field: 'vendor.is_msme', op: 'eq', value: true },
            { field: 'category', op: 'eq', value: 'fuel' },
          ],
        },
        { none: [{ field: 'currency', op: 'ne', value: 'INR' }] },
      ],
    };
    const res = evaluateConditions(c, ctx);
    expect(res.matched).toBe(true);
    expect(res.trace.length).toBeGreaterThan(0);
  });
  it('empty condition {} is a vacuous match (applies to everything)', () => {
    expect(evaluateConditions({}, ctx).matched).toBe(true);
  });
  it('produces a trace with a matched flag per node', () => {
    const res = evaluateConditions(
      { all: [{ field: 'total_amount', op: 'lte', value: '500000' }] },
      ctx,
    );
    const leaf = res.trace.find((t) => t.kind === 'leaf');
    expect(leaf?.matched).toBe(true);
    expect(leaf?.actual).toBe('216884.00');
    expect(res.trace.some((t) => t.kind === 'all')).toBe(true);
  });
});

describe('conditionDepth', () => {
  it('a leaf is depth 1', () => {
    expect(conditionDepth({ field: 'x', op: 'eq', value: 1 })).toBe(1);
  });
  it('counts nesting depth', () => {
    const c: Condition = {
      all: [{ any: [{ none: [{ field: 'x', op: 'eq', value: 1 }] }] }],
    };
    expect(conditionDepth(c)).toBe(4);
  });
});
