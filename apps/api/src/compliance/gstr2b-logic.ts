import type { Gstr2bStatusValue } from '@procureflow/shared';
import Decimal from 'decimal.js';

/** ₹ tolerance for rounding differences before flagging MISMATCH_AMOUNT. */
export const GSTR2B_AMOUNT_TOLERANCE = new Decimal('1');

export interface Gstr2bMatchInput {
  invoiceGross: string;
  invoiceDay: string; // yyyy-mm-dd
  entry: { invoiceValue: string; docDate: string } | undefined;
}

/**
 * Pure §9 GSTR-2B classification (Slice 10a). Precedence: not-on-2B → NOT_FOUND;
 * amount beyond rounding tolerance → MISMATCH_AMOUNT; different doc date →
 * MISMATCH_DATE; else MATCHED.
 */
export function classifyGstr2b(input: Gstr2bMatchInput): Gstr2bStatusValue {
  if (!input.entry) return 'NOT_FOUND';
  const diff = new Decimal(input.invoiceGross).minus(input.entry.invoiceValue).abs();
  if (diff.greaterThan(GSTR2B_AMOUNT_TOLERANCE)) return 'MISMATCH_AMOUNT';
  if (input.invoiceDay !== input.entry.docDate) return 'MISMATCH_DATE';
  return 'MATCHED';
}
