import { z } from 'zod';

import { BANK_FORMAT_KEYS } from '../bank-formats/types';
import type { LiveApprovalStep } from './approvals';

// ── Mutation inputs ──────────────────────────────────────────────────────────

export const CreatePaymentRunInputSchema = z.object({
  cycleDate: z.string().datetime(),
  bankAccountId: z.string().min(1),
  name: z.string().min(1).max(120).nullish(),
});
export type CreatePaymentRunInput = z.infer<typeof CreatePaymentRunInputSchema>;

export const SuggestInvoicesInputSchema = z.object({
  dueWithinDays: z.number().int().min(0).max(365).nullish(),
  vendorIds: z.array(z.string().min(1)).nullish(),
  costCenterId: z.string().min(1).nullish(),
  msmeOnly: z.boolean().default(false),
});
export type SuggestInvoicesInput = z.infer<typeof SuggestInvoicesInputSchema>;

export const AddPaymentItemInputSchema = z.object({
  invoiceId: z.string().min(1),
});
export type AddPaymentItemInput = z.infer<typeof AddPaymentItemInputSchema>;

const amountString = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,2})?$/, 'Enter an amount, e.g. 8260 or 8260.50');

/**
 * How much of an invoice a run pays — before TDS, against the invoice's gross.
 * Anything below the outstanding balance is a part-payment; the rest stays
 * payable for a later run.
 */
export const SetPaymentItemAmountInputSchema = z.object({
  amount: amountString,
});
export type SetPaymentItemAmountInput = z.infer<typeof SetPaymentItemAmountInputSchema>;

export const MANUAL_PAYMENT_MODES = ['NEFT', 'RTGS', 'IMPS', 'UPI', 'CHEQUE', 'OTHER'] as const;
export type ManualPaymentMode = (typeof MANUAL_PAYMENT_MODES)[number];

/** A payment finance made outside the app, recorded against the invoice. */
export const RecordManualPaymentInputSchema = z.object({
  /** Part of the invoice this payment settles, before TDS. */
  amount: amountString,
  /**
   * TDS withheld from this payment. Omit it and the invoice's TDS is split in
   * proportion to the amount settled.
   */
  tds: amountString.nullish(),
  paidAt: z.string().datetime(),
  mode: z.enum(MANUAL_PAYMENT_MODES),
  /** UTR, cheque number, or whatever reference the bank gave. */
  reference: z.string().trim().min(1, 'Enter the UTR or cheque number').max(64),
  note: z.string().trim().max(500).nullish(),
});
export type RecordManualPaymentInput = z.infer<typeof RecordManualPaymentInputSchema>;

export const ReorderPaymentItemsInputSchema = z.object({
  itemIds: z.array(z.string().min(1)).min(1),
  /** Required only when the reorder forces an MSME item below its fold. */
  reason: z.string().min(1).max(500).nullish(),
});
export type ReorderPaymentItemsInput = z.infer<typeof ReorderPaymentItemsInputSchema>;

export const CancelPaymentRunInputSchema = z.object({
  reason: z.string().min(1).max(500),
});
export type CancelPaymentRunInput = z.infer<typeof CancelPaymentRunInputSchema>;

/** Decision on a payment-run approval — mirrors the invoice decide route. */
export const PaymentRunDecisionInputSchema = z.object({
  approvalId: z.string().min(1),
  decision: z.enum(['APPROVE', 'REJECT', 'REQUEST_CHANGES']),
  comment: z.string().max(2000).nullish(),
});
export type PaymentRunDecisionInput = z.infer<typeof PaymentRunDecisionInputSchema>;

export const PaymentRunListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().nullish(),
  tab: z
    .enum(['draft', 'awaiting', 'submitted', 'completed', 'failed', 'all'])
    .default('all'),
});
export type PaymentRunListQuery = z.infer<typeof PaymentRunListQuerySchema>;

export const bankFormatKeyEnum = z.enum(BANK_FORMAT_KEYS);


/**
 * A tenant disbursement account — the account a payment run debits.
 *
 * Only the last four digits of the account number are held: the file the bank
 * receives is built from the format template plus the tenant code, and keeping
 * the full number would put a payment credential in the application database
 * for no operational gain.
 */
export const BankAccountInputSchema = z.object({
  bankName: z.string().trim().min(1, "Bank name is required").max(120),
  accountNoLast4: z
    .string()
    .trim()
    .regex(/^[0-9]{4}$/, "Enter the last 4 digits of the account number"),
  ifsc: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "Enter a valid 11-character IFSC"),
  holderName: z.string().trim().min(1, "Account holder name is required").max(160),
  /** Which bank file layout this account is submitted in. */
  formatKey: bankFormatKeyEnum,
  /** Optional ceiling on a single run against this account. */
  dailyLimit: z
    .string()
    .regex(/^\d+(\.\d+)?$/, 'Enter an amount')
    .nullish(),
  /** Format-specific extras, e.g. the corporate/tenant code some layouts embed. */
  tenantCode: z.string().trim().max(40).nullish(),
  isActive: z.boolean().optional(),
});
export type BankAccountInput = z.infer<typeof BankAccountInputSchema>;

// ── Read models (shared with the frontend) ───────────────────────────────────

export interface BankAccountView {
  id: string;
  bankName: string;
  accountNoLast4: string;
  ifsc: string;
  holderName: string;
  formatKey: string;
  dailyLimit: string | null;
  tenantCode: string | null;
  isActive: boolean;
}

export interface PaymentRunKpis {
  itemCount: number;
  gross: string;
  tdsTotal: string;
  net: string;
  msmePriorityCount: number;
}

export interface PaymentRunListItem {
  id: string;
  number: string;
  name: string | null;
  cycleDate: string;
  status: string;
  itemCount: number;
  gross: string;
  net: string;
  currency: string;
  bankName: string | null;
  composedByName: string | null;
}

export interface PaymentRunTabCounts {
  all: number;
  draft: number;
  awaiting: number;
  submitted: number;
  completed: number;
  failed: number;
}

export interface PaymentRunListResponse {
  items: PaymentRunListItem[];
  nextCursor: string | null;
  totalEstimate: number;
  counts: PaymentRunTabCounts;
}

export interface SuggestedInvoice {
  invoiceId: string;
  number: string;
  vendorInvoiceRef: string;
  vendorName: string;
  isMsme: boolean;
  msmeDaysRemaining: number | null;
  msmeApproaching: boolean;
  gross: string;
  tds: string;
  net: string;
  /** Already settled by earlier payments, and what is left — both before TDS. */
  paidAmount: string;
  outstanding: string;
  agingDays: number;
  bankVerified: boolean;
  /** Auto-included because it is an MSME invoice approaching the 45-day cap. */
  autoIncluded: boolean;
}

export interface SuggestInvoicesResponse {
  items: SuggestedInvoice[];
  /** Set when MSME invoices were force-included past the user's filter. */
  msmeAutoIncludedCount: number;
}

export interface PaymentRunItemView {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  vendorName: string;
  isMsme: boolean;
  msmeDaysRemaining: number | null;
  /** What this run settles of the invoice, before TDS. */
  gross: string;
  tds: string;
  net: string;
  /** The invoice's full value, what earlier payments settled, and what was left for this run. */
  invoiceGross: string;
  paidBefore: string;
  outstanding: string;
  /** This run pays less than the outstanding balance. */
  isPartial: boolean;
  bankVerified: boolean;
  orderInBatch: number;
}

export interface BankFilePreview {
  filename: string;
  content: string;
  rowCount: number;
  checksum: string;
  /** Draft/awaiting previews are watermarked; only the submitted file is final. */
  watermarked: boolean;
}

export interface MsmeAtRiskInvoice {
  invoiceId: string;
  number: string;
  vendorName: string;
  daysRemaining: number;
  dueDate: string;
  inRun: boolean;
  excludedReason: string | null;
}

export interface MsmeAuditResult {
  /** MSME invoices at day 40+ that are NOT in this run and have no documented reason. */
  atRisk: MsmeAtRiskInvoice[];
  checkedCount: number;
}

export interface PaymentRecordView {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  vendorName: string;
  gross: string;
  tds: string;
  net: string;
  utr: string;
  isStub: boolean;
  paidAt: string;
}

export interface TdsReportRow {
  vendorName: string;
  gstin: string | null;
  gross: string;
  tds: string;
  net: string;
}

export interface PaymentRunDetailResponse {
  id: string;
  number: string;
  name: string | null;
  cycleDate: string;
  status: string;
  currency: string;
  composedByName: string | null;
  composedAt: string;
  submittedAt: string | null;
  bankAccount: BankAccountView | null;
  kpis: PaymentRunKpis;
  items: PaymentRunItemView[];
  bankFilePreview: BankFilePreview | null;
  liveApprovalChain: LiveApprovalStep[];
  myApprovalId: string | null;
  canDecide: boolean;
  msmeAudit: MsmeAuditResult;
  bankFileHash: string | null;
  isStubMode: boolean;
}

/** Payment posting shown on the invoice detail's "Payments" tab (Slice 3). */
export interface InvoicePaymentInfo {
  id: string;
  source: 'PAYMENT_RUN' | 'MANUAL';
  /** Null for a MANUAL payment — it was made outside any run. */
  paymentRunId: string | null;
  paymentRunNumber: string | null;
  utr: string;
  isStub: boolean;
  gross: string;
  tds: string;
  net: string;
  paidAt: string;
  mode: string | null;
  note: string | null;
  recordedByName: string | null;
}
