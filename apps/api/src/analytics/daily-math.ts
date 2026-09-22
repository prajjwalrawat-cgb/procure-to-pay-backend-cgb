/**
 * Pure helpers for the AnalyticsDaily rollup, the Home tiles and the analytics
 * overview. Days are UTC calendar days ('YYYY-MM-DD'), matching the contract in
 * packages/shared/src/schemas/home.ts.
 */

const DAY_MS = 86_400_000;

/** 00:00 UTC of the day containing `d`. */
export function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}

/** 'YYYY-MM-DD' (UTC). */
export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Every day key from `from` to `to`, both inclusive, ascending. */
export function dayRange(from: Date, to: Date): string[] {
  const out: string[] = [];
  for (let d = utcDay(from); d <= to; d = addDays(d, 1)) out.push(dayKey(d));
  return out;
}

/** Monday 00:00 UTC of the ISO week containing `d`. */
export function weekStart(d: Date): Date {
  const day = utcDay(d);
  const dow = (day.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  return addDays(day, -dow);
}

/**
 * Month-to-date window and the matching window of the previous month
 * ("same days last month"): 1st → today, vs 1st → same day-of-month last month,
 * clipped to that month's length (31 Mar compares against 1–28/29 Feb).
 * All bounds are inclusive UTC days.
 */
export function mtdWindows(today: Date): {
  cur: { from: Date; to: Date };
  prev: { from: Date; to: Date };
} {
  const t = utcDay(today);
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth();
  const curFrom = new Date(Date.UTC(y, m, 1));
  const prevFrom = new Date(Date.UTC(y, m - 1, 1));
  const prevLen = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const prevTo = new Date(Date.UTC(y, m - 1, Math.min(t.getUTCDate(), prevLen)));
  return { cur: { from: curFrom, to: t }, prev: { from: prevFrom, to: prevTo } };
}

/**
 * % change of `cur` vs `base`, one decimal. null when there is no usable
 * baseline (missing, or zero — a change from nothing has no percentage).
 */
export function deltaPct(cur: number | null, base: number | null): number | null {
  if (cur === null || base === null || !Number.isFinite(base) || base === 0) return null;
  return Math.round(((cur - base) / Math.abs(base)) * 1000) / 10;
}

/**
 * Percentage-point change (for tiles whose value is already a percentage, e.g.
 * the MSME compliance score: 92 → 95 is +3, not +3.3%). One decimal.
 */
export function deltaPoints(cur: number | null, base: number | null): number | null {
  if (cur === null || base === null) return null;
  return Math.round((cur - base) * 10) / 10;
}

/** on-time / total as a 0–100 score, two decimals; null when there is nothing to measure. */
export function complianceScore(onTime: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((onTime / total) * 10000) / 100;
}

/**
 * Pick the snapshot closest to `target` among `points` whose day lies within
 * ±`toleranceDays` of it. Used for "vs 30 days ago" on stock tiles, where a
 * snapshot only exists for days the rollup was refreshed.
 */
export function nearestSnapshot<T extends { day: string }>(
  points: T[],
  target: Date,
  toleranceDays: number,
): T | null {
  let best: T | null = null;
  let bestDist = Infinity;
  const t = utcDay(target).getTime();
  for (const p of points) {
    const dist = Math.abs(new Date(`${p.day}T00:00:00Z`).getTime() - t) / DAY_MS;
    if (dist <= toleranceDays && dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  return best;
}
