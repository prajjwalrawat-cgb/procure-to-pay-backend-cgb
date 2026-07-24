import type { PaymentItemBankStatus } from '../constants/status';

/**
 * Banking read models (Slice 10b). The bank-reconciliation dashboard surfaces
 * per-item submission status, discrepancies, and the manual-override path.
 */

export interface BankReconItem {
  invoiceId: string;
  invoiceNumber: string;
  vendorName: string;
  net: string;
  bankStatus: PaymentItemBankStatus;
  bankUtr: string | null;
  bankErrorMessage: string | null;
}

export interface BankReconciliationResponse {
  paymentRunId: string;
  runNumber: string;
  status: string;
  simulated: boolean;
  attemptNo: number;
  itemCount: number;
  acceptedCount: number;
  failedCount: number;
  submittedAt: string | null;
  confirmedAt: string | null;
  items: BankReconItem[];
  /** UTRs already issued for this run (stub + real, clearly distinguished). */
  records: { invoiceId: string; utr: string; isStub: boolean; net: string }[];
  canConfirm: boolean;
  canRetry: boolean;
}

export interface BankSubmissionResult {
  paymentRunId: string;
  status: string;
  attemptNo: number;
  submitted: number;
  failed: number;
  idempotentReplay: boolean;
  simulated: boolean;
}

export interface BankConfirmationResult {
  paymentRunId: string;
  status: string;
  confirmed: number;
  failed: number;
  simulated: boolean;
}
