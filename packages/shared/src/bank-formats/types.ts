/**
 * Bank-file formatter contracts (Slice 3, Master Context §9 / §3 rule #4).
 *
 * Formatters are PURE functions of their input (ADR-007): the same
 * `BankFileInput` always yields byte-identical output, so a file can be
 * previewed, hashed, approved, then regenerated at submission and proven
 * unchanged. They live in `@procureflow/shared` so any future module can also
 * produce bank files, and use only Web-standard APIs (no Node builtins) so the
 * browser can import the package without pulling in server-only code.
 */

export const BANK_FORMAT_KEYS = ['NEFT_BULK', 'ICICI_CINB', 'SBI_CINB'] as const;
export type BankFormatKey = (typeof BANK_FORMAT_KEYS)[number];

/** One beneficiary line in a bank file. Amounts are canonical decimal strings. */
export interface BankFilePayee {
  beneficiaryName: string;
  beneficiaryAccount: string;
  ifsc: string;
  /** Net payable to this beneficiary — 4-dp decimal string (§3 rule #4). */
  amount: string;
  /** Payment reference — the invoice number. */
  ref: string;
  narration: string;
}

/** Run-level header context shared across all formats. */
export interface BankFileRunMeta {
  runNumber: string;
  /** Cycle / value date as ISO. Formatted per-bank in UTC (deterministic). */
  cycleDate: string;
  /** Short tenant code carried in the file header (bank onboarding id). */
  tenantCode: string;
  debitAccountLast4: string;
  debitIfsc: string;
  holderName: string;
}

export interface BankFileInput {
  meta: BankFileRunMeta;
  payees: BankFilePayee[];
}

export interface BankFileOutput {
  filename: string;
  /** The exact file text (line endings are part of the format). */
  content: string;
  /** UTF-8 encoded bytes of `content`. */
  contentBytes: Uint8Array;
  /** SHA-256 hex of `contentBytes` — the tamper-evidence anchor. */
  checksum: string;
  /** Beneficiary (data) rows, excluding header/trailer. */
  rowCount: number;
}

export interface IBankFileFormatter {
  readonly key: BankFormatKey;
  format(input: BankFileInput): BankFileOutput;
}
