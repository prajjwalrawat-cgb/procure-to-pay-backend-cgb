import { describe, expect, it } from 'vitest';

import {
  classifyVolumeTracking,
  commitmentPeriodKey,
  computeEscalatedRate,
  crossedRenewalThresholds,
  daysBetween,
  fyLabel,
  renewalBucket,
} from './contract-logic';

describe('computeEscalatedRate — indexed escalation', () => {
  it('applies a linear index ratio (10% index rise → 10% rate rise)', () => {
    const r = computeEscalatedRate({
      currentRate: '100',
      baseIndex: '92.50',
      newIndex: '101.75',
    });
    // 101.75 / 92.50 = 1.1 → 110.00
    expect(r.proposedRate).toBe('110.0000');
    expect(r.upliftPct).toBe('10.0000');
    expect(r.capped).toBe(false);
  });

  it('caps the uplift at capPct at the boundary', () => {
    // 20% raw uplift, cap 10% → proposed = 110, capped
    const r = computeEscalatedRate({
      currentRate: '100',
      baseIndex: '100',
      newIndex: '120',
      capPct: '10',
    });
    expect(r.proposedRate).toBe('110.0000');
    expect(r.upliftPct).toBe('10.0000');
    expect(r.capped).toBe(true);
  });

  it('does not cap when uplift is exactly at the cap', () => {
    const r = computeEscalatedRate({
      currentRate: '100',
      baseIndex: '100',
      newIndex: '110',
      capPct: '10',
    });
    expect(r.proposedRate).toBe('110.0000');
    expect(r.capped).toBe(false);
  });

  it('handles a rate decrease (index falls)', () => {
    const r = computeEscalatedRate({
      currentRate: '100',
      baseIndex: '100',
      newIndex: '95',
    });
    expect(r.proposedRate).toBe('95.0000');
    expect(Number(r.upliftPct)).toBeCloseTo(-5, 4);
  });

  it('throws on a non-positive base index', () => {
    expect(() =>
      computeEscalatedRate({ currentRate: '100', baseIndex: '0', newIndex: '5' }),
    ).toThrow();
  });
});

describe('classifyVolumeTracking — take-or-pay boundaries', () => {
  it('is ON_TRACK when no commitment is set', () => {
    expect(
      classifyVolumeTracking({ committedQty: null, actualQty: 0, elapsedFraction: 0.5 })
        .status,
    ).toBe('ON_TRACK');
  });

  it('ON_TRACK when projected ≥ 90% of commitment', () => {
    // half the period elapsed, 45% consumed → projected 90%
    const r = classifyVolumeTracking({
      committedQty: 100,
      actualQty: 45,
      elapsedFraction: 0.5,
    });
    expect(r.status).toBe('ON_TRACK');
    expect(r.projectedPctOfCommitment).toBeCloseTo(0.9, 4);
  });

  it('AT_RISK when projected between 70% and 90%', () => {
    // half elapsed, 40% consumed → projected 80%
    const r = classifyVolumeTracking({
      committedQty: 100,
      actualQty: 40,
      elapsedFraction: 0.5,
    });
    expect(r.status).toBe('AT_RISK');
  });

  it('SHORTFALL when projected below 70%', () => {
    // half elapsed, 30% consumed → projected 60%
    const r = classifyVolumeTracking({
      committedQty: 100,
      actualQty: 30,
      elapsedFraction: 0.5,
    });
    expect(r.status).toBe('SHORTFALL');
  });

  it('does not extrapolate too early in the period', () => {
    const r = classifyVolumeTracking({
      committedQty: 100,
      actualQty: 0,
      elapsedFraction: 0.005,
    });
    expect(r.status).toBe('ON_TRACK');
    expect(r.projectedPctOfCommitment).toBeNull();
  });
});

describe('crossedRenewalThresholds — alert scheduling', () => {
  it('creates only the 90-day alert at 85 days out', () => {
    expect(crossedRenewalThresholds(85)).toEqual(['NOTICE_90D']);
  });

  it('creates 90 + 60 at 55 days out', () => {
    expect(crossedRenewalThresholds(55)).toEqual(['NOTICE_90D', 'NOTICE_60D']);
  });

  it('creates 90 + 60 + 30 at 20 days out', () => {
    expect(crossedRenewalThresholds(20)).toEqual([
      'NOTICE_90D',
      'NOTICE_60D',
      'NOTICE_30D',
    ]);
  });

  it('creates EXPIRED (plus all notices) once past validity', () => {
    expect(crossedRenewalThresholds(-1)).toEqual([
      'EXPIRED',
      'NOTICE_90D',
      'NOTICE_60D',
      'NOTICE_30D',
    ]);
  });

  it('creates nothing beyond 90 days', () => {
    expect(crossedRenewalThresholds(120)).toEqual([]);
  });

  it('handles a contract shorter than 90 days (all notices at once)', () => {
    // A 45-day contract on day 1 has 44 days to expiry → 90 + 60 fire.
    expect(crossedRenewalThresholds(44)).toEqual(['NOTICE_90D', 'NOTICE_60D']);
  });
});

describe('renewalBucket', () => {
  it('buckets by horizon', () => {
    expect(renewalBucket(-1)).toBe('expired');
    expect(renewalBucket(15)).toBe('30d');
    expect(renewalBucket(45)).toBe('60d');
    expect(renewalBucket(80)).toBe('90d');
  });
});

describe('fyLabel + commitmentPeriodKey', () => {
  it('resolves the Indian FY (1 Apr–31 Mar)', () => {
    expect(fyLabel(new Date('2026-07-01T00:00:00Z'))).toBe('FY2026');
    expect(fyLabel(new Date('2026-02-15T00:00:00Z'))).toBe('FY2025');
    expect(fyLabel(new Date('2026-04-01T00:00:00Z'))).toBe('FY2026');
  });

  it('keys annual commitments by FY and lifetime as LIFETIME', () => {
    expect(commitmentPeriodKey('ANNUAL', new Date('2026-07-01T00:00:00Z'))).toBe(
      'FY2026',
    );
    expect(
      commitmentPeriodKey('CONTRACT_LIFETIME', new Date('2026-07-01T00:00:00Z')),
    ).toBe('LIFETIME');
  });
});

describe('daysBetween', () => {
  it('floors whole days and is negative for past dates', () => {
    const from = new Date('2026-07-20T00:00:00Z');
    expect(daysBetween(from, new Date('2026-07-30T00:00:00Z'))).toBe(10);
    expect(daysBetween(from, new Date('2026-07-10T00:00:00Z'))).toBe(-10);
  });
});
