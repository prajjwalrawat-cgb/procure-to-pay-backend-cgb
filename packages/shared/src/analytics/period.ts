// Analytics period resolution (pure, testable). Indian fiscal year = 1 Apr – 31 Mar.

export const ANALYTICS_PERIODS = ['LAST_12M', 'YTD', 'LAST_24M', 'CUSTOM'] as const;
export type AnalyticsPeriodKey = (typeof ANALYTICS_PERIODS)[number];

export interface ResolvedPeriod {
  /** inclusive UTC start */
  start: Date;
  /** exclusive UTC end (start of the day after `to`) */
  end: Date;
  /** every 'YYYY-MM' month touched by [start, end), ascending */
  months: string[];
  key: AnalyticsPeriodKey;
}

/** 'YYYY-MM' for a date (UTC). */
export function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The Indian fiscal-year start (1 April) on or before `now`. */
export function fyStart(now: Date): Date {
  const y = now.getUTCFullYear();
  const beforeApril = now.getUTCMonth() < 3; // Jan/Feb/Mar → previous FY
  return new Date(Date.UTC(beforeApril ? y - 1 : y, 3, 1));
}

/** Ascending list of 'YYYY-MM' from `start` (inclusive) to `end` (exclusive). */
export function monthsBetween(start: Date, end: Date): string[] {
  const out: string[] = [];
  const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  // `end` is exclusive — the last month is the one containing (end − 1ms).
  const endIncl = new Date(end.getTime() - 1);
  const last = new Date(Date.UTC(endIncl.getUTCFullYear(), endIncl.getUTCMonth(), 1));
  while (cur <= last) {
    out.push(monthKey(cur));
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return out;
}

/**
 * Resolve a period key (+ optional custom from/to) into a concrete UTC range.
 * `now` is injected so this stays pure and unit-testable.
 */
export function resolvePeriod(
  input: { period: AnalyticsPeriodKey; from?: string | null; to?: string | null },
  now: Date,
): ResolvedPeriod {
  const endExclusive = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
  let start: Date;
  let end = endExclusive;

  switch (input.period) {
    case 'YTD':
      start = fyStart(now);
      break;
    case 'LAST_24M':
      start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 23, 1));
      break;
    case 'CUSTOM': {
      start = input.from ? new Date(input.from) : fyStart(now);
      if (input.to) {
        const t = new Date(input.to);
        end = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1));
      }
      break;
    }
    case 'LAST_12M':
    default:
      start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
      break;
  }

  return { start, end, months: monthsBetween(start, end), key: input.period };
}

/** The prior-FY-overlay range for a given resolved period (same span, shifted -1 year). */
export function priorYearRange(p: ResolvedPeriod): {
  start: Date;
  end: Date;
  months: string[];
} {
  const start = new Date(
    Date.UTC(p.start.getUTCFullYear() - 1, p.start.getUTCMonth(), p.start.getUTCDate()),
  );
  const end = new Date(
    Date.UTC(p.end.getUTCFullYear() - 1, p.end.getUTCMonth(), p.end.getUTCDate()),
  );
  return { start, end, months: monthsBetween(start, end) };
}
