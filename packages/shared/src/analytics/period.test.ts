import { describe, expect, it } from 'vitest';

import {
  fyStart,
  monthKey,
  monthsBetween,
  priorYearRange,
  resolvePeriod,
} from './period';

const at = (iso: string): Date => new Date(iso);

describe('period utilities', () => {
  it('monthKey formats UTC year-month', () => {
    expect(monthKey(at('2026-07-20T00:00:00Z'))).toBe('2026-07');
    expect(monthKey(at('2026-01-05T00:00:00Z'))).toBe('2026-01');
  });

  it('Indian FY starts 1 April; Jan–Mar roll to previous FY', () => {
    expect(fyStart(at('2026-07-20T00:00:00Z')).toISOString()).toBe(
      '2026-04-01T00:00:00.000Z',
    );
    expect(fyStart(at('2026-02-15T00:00:00Z')).toISOString()).toBe(
      '2025-04-01T00:00:00.000Z',
    );
  });

  it('YTD resolves to FY-start → now', () => {
    const p = resolvePeriod({ period: 'YTD' }, at('2026-07-20T00:00:00Z'));
    expect(p.start.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(p.months).toEqual(['2026-04', '2026-05', '2026-06', '2026-07']);
  });

  it('LAST_12M spans 12 months inclusive', () => {
    const p = resolvePeriod({ period: 'LAST_12M' }, at('2026-07-20T00:00:00Z'));
    expect(p.months).toHaveLength(12);
    expect(p.months[0]).toBe('2025-08');
    expect(p.months[11]).toBe('2026-07');
  });

  it('LAST_24M spans 24 months', () => {
    const p = resolvePeriod({ period: 'LAST_24M' }, at('2026-07-20T00:00:00Z'));
    expect(p.months).toHaveLength(24);
  });

  it('CUSTOM honours from/to', () => {
    const p = resolvePeriod(
      { period: 'CUSTOM', from: '2026-01-01T00:00:00Z', to: '2026-03-31T00:00:00Z' },
      at('2026-07-20T00:00:00Z'),
    );
    expect(p.months).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  it('monthsBetween is inclusive of both ends', () => {
    expect(monthsBetween(at('2026-05-10T00:00:00Z'), at('2026-07-02T00:00:00Z'))).toEqual(
      ['2026-05', '2026-06', '2026-07'],
    );
  });

  it('priorYearRange shifts the span back one year, same length', () => {
    const p = resolvePeriod({ period: 'YTD' }, at('2026-07-20T00:00:00Z'));
    const prior = priorYearRange(p);
    expect(prior.months).toEqual(['2025-04', '2025-05', '2025-06', '2025-07']);
    expect(prior.months).toHaveLength(p.months.length);
  });
});
