import Decimal from 'decimal.js';

import { sha256Hex } from './sha256';
import type { BankFileOutput } from './types';

/**
 * Shared helpers for the bank formatters. All date formatting is done in UTC so
 * output is deterministic regardless of the server's timezone (golden tests
 * depend on byte-for-byte stability).
 */

/** Strip separators/newlines banks reject, so a field never breaks a row. */
export function sanitizeField(value: string): string {
  return value.replace(/[,\r\n|]+/g, ' ').trim();
}

/** Rupees with 2 decimals from a canonical 4-dp decimal string. */
export function amount2dp(value: string): string {
  return new Decimal(value).toFixed(2);
}

/** Sum of a list of decimal strings, 2-dp rupees. */
export function sum2dp(values: string[]): string {
  return values.reduce((acc, v) => acc.plus(new Decimal(v)), new Decimal(0)).toFixed(2);
}

function parts(iso: string): { y: string; m: string; d: string } {
  const dt = new Date(iso);
  return {
    y: String(dt.getUTCFullYear()).padStart(4, '0'),
    m: String(dt.getUTCMonth() + 1).padStart(2, '0'),
    d: String(dt.getUTCDate()).padStart(2, '0'),
  };
}

export function yyyymmdd(iso: string): string {
  const { y, m, d } = parts(iso);
  return `${y}${m}${d}`;
}

export function ddmmyyyy(iso: string, sep: string): string {
  const { y, m, d } = parts(iso);
  return `${d}${sep}${m}${sep}${y}`;
}

/** Finalize a formatter's text into the full `BankFileOutput` (bytes + hash). */
export function toOutput(
  filename: string,
  content: string,
  rowCount: number,
): BankFileOutput {
  const contentBytes = new TextEncoder().encode(content);
  return { filename, content, contentBytes, checksum: sha256Hex(contentBytes), rowCount };
}
