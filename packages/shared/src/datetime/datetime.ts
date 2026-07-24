/**
 * All timestamps are stored as UTC `timestamptz` (Master Context §3 rule #5).
 * Convert to IST (UTC+05:30) only at the display boundary — never in the DB or
 * domain layer.
 */

export const IST_OFFSET_MINUTES = 330; // +05:30

/** ISO-8601 UTC string, always with `Z`. Use for wire + persistence. */
export function toUtcIso(date: Date): string {
  return date.toISOString();
}

/** Format a UTC instant for display in IST. Presentation-layer only. */
export function formatIST(
  date: Date | string,
  opts: Intl.DateTimeFormatOptions = {},
): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    ...opts,
  }).format(d);
}

/** Date-only IST display, e.g. "08 Jul 2026". */
export function formatISTDate(date: Date | string): string {
  return formatIST(date, {
    hour: undefined,
    minute: undefined,
    hour12: undefined,
  });
}

/** Add whole days to a UTC instant (used for MSME due-date math in later slices). */
export function addDaysUtc(date: Date, days: number): Date {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

/**
 * Indian financial year label for a UTC instant, e.g. "FY2026-27".
 * FY runs 1 Apr → 31 Mar. Used for TDS 194Q running totals in later slices.
 */
export function indianFinancialYear(date: Date): string {
  const month = date.getUTCMonth(); // 0-based; Apr = 3
  const year = date.getUTCFullYear();
  const startYear = month >= 3 ? year : year - 1;
  const endYear = (startYear + 1) % 100;
  return `FY${startYear}-${String(endYear).padStart(2, '0')}`;
}
