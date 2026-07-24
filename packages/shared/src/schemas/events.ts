/**
 * Typed domain-event payloads for Slice 4 (Master Context §3 rule #9). The event
 * bus persists `Record<string, unknown>`; these interfaces document the shape
 * emitters and consumers agree on.
 */

export interface RequisitionDraftedEvent {
  requisitionId: string;
  requesterId: string;
  totalAmount: string;
}

export interface RequisitionApprovedEvent {
  requisitionId: string;
  costCenterId: string;
  totalAmount: string;
}

export interface PurchaseOrderDraftedEvent {
  poId: string;
  requisitionId: string | null;
  vendorId: string;
}

export interface PurchaseOrderIssuedEvent {
  poId: string;
  vendorId: string;
  requisitionId: string | null;
  totalAmount: string;
}

export interface PurchaseOrderCancelledEvent {
  poId: string;
  reason: string;
}

export interface BudgetCommittedEvent {
  budgetId: string;
  commitmentId: string;
  costCenterId: string;
  sourceType: 'PR' | 'PO' | 'SPOT_BUY';
  sourceId: string;
  amount: string;
}

export interface BudgetReleasedEvent {
  commitmentId: string;
  budgetId: string;
  amount: string;
  reason: string;
}

export interface BudgetTransferredEvent {
  fromCommitmentId: string;
  toCommitmentId: string;
  budgetId: string;
  poId: string;
  amount: string;
}

// ── Goods receipt / RMA / stock (Slice 5) ────────────────────────────────────

export interface GrnDraftedEvent {
  grnId: string;
  poId: string;
  vendorId: string;
}

export interface GrnQcCompletedEvent {
  grnId: string;
  poId: string;
  qcStatus: string;
  hasRejections: boolean;
}

export interface GrnPostedEvent {
  grnId: string;
  poId: string;
  vendorId: string;
  totalAcceptedValue: string;
  /** Per-line accepted quantity — the basis the 3-way match uses (ADR-026). */
  lines: { poLineId: string; qtyAccepted: string }[];
}

export interface GrnReversedEvent {
  grnId: string;
  poId: string;
  reason: string;
}

export interface RmaIssuedEvent {
  rmaId: string;
  grnId: string;
  vendorId: string;
  totalReturnValue: string;
}

export interface RmaClosedEvent {
  rmaId: string;
  vendorId: string;
  creditNoteRef: string | null;
}

export interface StockMovementRecordedEvent {
  stockLedgerId: string;
  itemId: string | null;
  movementType: string;
  qtyDelta: string;
  sourceType: string;
  sourceId: string;
}

// ── Contracts (Slice 9) ──────────────────────────────────────────────────────

export interface ContractExecutedEvent {
  contractId: string;
  vendorId: string;
  contractType: string;
  totalValueEstimate: string;
  validityEnd: string;
}

export interface ContractAmendedEvent {
  contractId: string;
  amendmentId: string;
  amendmentNo: number;
}

export interface ContractRenewalInitiatedEvent {
  parentContractId: string;
  newContractId: string;
}

export interface ContractExpiredEvent {
  contractId: string;
  vendorId: string;
}

export interface ContractTerminatedEvent {
  contractId: string;
  reason: string;
  early: boolean;
}

export interface CallOffCreatedEvent {
  contractId: string;
  poId: string;
  qty: string;
  value: string;
}

export interface VolumeTrackingShortfallDetectedEvent {
  contractId: string;
  period: string;
  status: 'AT_RISK' | 'SHORTFALL';
  shortfallValue: string | null;
}

export const DOMAIN_EVENTS = {
  REQUISITION_DRAFTED: 'RequisitionDrafted',
  REQUISITION_APPROVED: 'RequisitionApproved',
  PURCHASE_ORDER_DRAFTED: 'PurchaseOrderDrafted',
  PURCHASE_ORDER_ISSUED: 'PurchaseOrderIssued',
  PURCHASE_ORDER_CANCELLED: 'PurchaseOrderCancelled',
  BUDGET_COMMITTED: 'BudgetCommitted',
  BUDGET_RELEASED: 'BudgetReleased',
  BUDGET_TRANSFERRED: 'BudgetTransferred',
  GRN_DRAFTED: 'GrnDrafted',
  GRN_QC_COMPLETED: 'GrnQcCompleted',
  GRN_POSTED: 'GrnPosted',
  GRN_REVERSED: 'GrnReversed',
  RMA_ISSUED: 'RmaIssued',
  RMA_CLOSED: 'RmaClosed',
  STOCK_MOVEMENT_RECORDED: 'StockMovementRecorded',
  CONTRACT_EXECUTED: 'ContractExecuted',
  CONTRACT_AMENDED: 'ContractAmended',
  CONTRACT_RENEWAL_INITIATED: 'ContractRenewalInitiated',
  CONTRACT_EXPIRED: 'ContractExpired',
  CONTRACT_TERMINATED: 'ContractTerminated',
  CALL_OFF_CREATED: 'CallOffCreated',
  VOLUME_TRACKING_SHORTFALL_DETECTED: 'VolumeTrackingShortfallDetected',
  // Slice 10a — document & compliance integrations
  INBOUND_EMAIL_RECEIVED: 'InboundEmailReceived',
  INVOICE_OCR_FAILED: 'InvoiceOcrFailed',
  INVOICE_OCR_LOW_CONFIDENCE: 'InvoiceOcrLowConfidence',
  GSTR2B_RECONCILED: 'Gstr2bReconciled',
  IRN_VALIDATED: 'IrnValidated',
  // Slice 10b — banking
  PAYMENT_BATCH_SUBMITTED: 'PaymentBatchSubmitted',
  PAYMENT_BANK_CONFIRMED: 'PaymentBankConfirmed',
  PAYMENT_ITEM_FAILED: 'PaymentItemFailed',
} as const;

export interface InboundEmailReceivedEvent {
  inboundEmailId: string;
  fromEmail: string;
  status: string;
  invoiceId: string | null;
}

export interface Gstr2bReconciledEvent {
  invoiceId: string;
  status: string;
}
