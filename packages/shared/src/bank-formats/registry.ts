import { hdfcNeftBulkFormatter } from './hdfc-neft-bulk';
import { iciciCinbFormatter } from './icici-cinb';
import { sbiCinbFormatter } from './sbi-cinb';
import { BANK_FORMAT_KEYS, type BankFormatKey, type IBankFileFormatter } from './types';

/**
 * Type-safe formatter registry (ADR-007). Adding a bank is a single-file change:
 * add the formatter here and the `BankFormatKey` union in `types.ts`; the record
 * type then forces every key to have an implementation.
 */
export const BANK_FORMATTERS: Record<BankFormatKey, IBankFileFormatter> = {
  NEFT_BULK: hdfcNeftBulkFormatter,
  ICICI_CINB: iciciCinbFormatter,
  SBI_CINB: sbiCinbFormatter,
};

export function isBankFormatKey(key: string): key is BankFormatKey {
  return (BANK_FORMAT_KEYS as readonly string[]).includes(key);
}

/** Resolve a formatter by key. Throws on an unknown/`CUSTOM` format (Slice 3 §Ambiguities). */
export function getBankFormatter(key: string): IBankFileFormatter {
  if (!isBankFormatKey(key)) {
    throw new Error(`Unsupported bank file format: ${key}`);
  }
  return BANK_FORMATTERS[key];
}
