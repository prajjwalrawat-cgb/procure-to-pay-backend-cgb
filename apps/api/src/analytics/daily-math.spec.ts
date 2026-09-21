import { describe, expect, it } from 'vitest';

import {
  complianceScore,
  dayRange,
  deltaPct,
  deltaPoints,
  mtdWindows,
  nearestSnapshot,
  weekStart,
} from './daily-math';

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const key = (x: Date) => x.toISOString().slice(0, 10);

describe('deltaPct', () => {
  it('is the relative change, one decimal', () => {
    expect(deltaPct(110, 100)).toBe(10);
    expect(deltaPct(90, 120)).toBe(-25);
    expect(deltaPct(1, 3)).toBe(-66.7);
  });

  it('is null without a usable baseline (missing or zero)', () => {
    expect(deltaPct(5, null)).toBeNull();
    expect(deltaPct(5, 0)).toBeNull();
    expect(deltaPct(null, 10)).toBeNull();
  });

  it('handles a negative baseline by its magnitude', () => {
    expect(deltaPct(-50, -100)).toBe(50);
  });
});

describe('deltaPoints (MSME score tile)', () => {
  it('is the percentage-point difference, not a relative change', () => {
    expect(deltaPoints(95, 92)).toBe(3);
    expect(deltaPoints(80.2, 90)).toBe(-9.8);
    expect(deltaPoints(null, 90)).toBeNull();
    expect(deltaPoints(90, null)).toBeNull();
  });
});

describe('complianceScore', () => {
  it('is on-time ÷ total × 100 with two decimals', () => {
    expect(complianceScore(2, 3)).toBe(66.67);
    expect(complianceScore(5, 5)).toBe(100);
    expect(complianceScore(0, 4)).toBe(0);
  });

  it('is null when nothing fell due', () => {
    expect(complianceScore(0, 0)).toBeNull();
  });
});

describe('mtdWindows ("vs same days last month")', () => {
  it('compares 1st→today with 1st→same day last month', () => {
    const w = mtdWindows(new Date('2026-09-21T15:30:00Z'));
    expect(key(w.cur.from)).toBe('2026-09-01');
    expect(key(w.cur.to)).toBe('2026-09-21');
    expect(key(w.prev.from)).toBe('2026-08-01');
    expect(key(w.prev.to)).toBe('2026-08-21');
  });

  it('clips to the shorter previous month', () => {
    const w = mtdWindows(d('2026-03-31'));
    expect(key(w.prev.from)).toBe('2026-02-01');
    expect(key(w.prev.to)).toBe('2026-02-28');
  });

  it('rolls January back to December of the prior year', () => {
    const w = mtdWindows(d('2026-01-10'));
    expect(key(w.prev.from)).toBe('2025-12-01');
    expect(key(w.prev.to)).toBe('2025-12-10');
  });
});

describe('weekStart', () => {
  it('is the Monday of the Mon–Sun week', () => {
    expect(key(weekStart(d('2026-09-21')))).toBe('2026-09-21'); // Monday
    expect(key(weekStart(d('2026-09-27')))).toBe('2026-09-21'); // Sunday
    expect(key(weekStart(d('2026-09-23')))).toBe('2026-09-21');
  });
});

describe('dayRange', () => {
  it('is inclusive at both ends', () => {
    expect(dayRange(d('2026-02-27'), d('2026-03-02'))).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
      '2026-03-02',
    ]);
  });
});

describe('nearestSnapshot', () => {
  const pts = [
    { day: '2026-08-19', value: 10 },
    { day: '2026-08-23', value: 12 },
    { day: '2026-09-20', value: 15 },
  ];
  it('picks the closest snapshot within tolerance', () => {
    expect(nearestSnapshot(pts, d('2026-08-22'), 3)?.value).toBe(12);
  });
  it('is null when no snapshot is close enough', () => {
    expect(nearestSnapshot(pts, d('2026-09-05'), 3)).toBeNull();
  });
});
