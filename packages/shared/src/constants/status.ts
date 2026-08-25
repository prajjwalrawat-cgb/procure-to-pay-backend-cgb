/**
 * Status enums shared across apps. Financial documents never soft-delete
 * (Master Context §3 rule #10) — they transition through these states.
 */

export const REQUISITION_STATUS = [
  'DRAFT',
  'SUBMITTED', // legacy
  'PENDING_APPROVAL', // legacy
  'CONVERTED', // legacy
  'BUDGET_BREACH_HELD',
  'AWAITING_APPROVAL',
  'APPROVED',
  'PARTIALLY_ISSUED',
  'FULLY_ISSUED',
  'REJECTED',
  'WITHDRAWN',
  'CANCELLED',
  'CLOSED',
] as const;
export type RequisitionStatus = (typeof REQUISITION_STATUS)[number];

export const REQUISITION_PRIORITY = ['LOW', 'STANDARD', 'HIGH', 'CRITICAL'] as const;
export type RequisitionPriority = (typeof REQUISITION_PRIORITY)[number];

export const NON_CATALOG_REASON = [
  'NEW_PRODUCT',
  'EMERGENCY',
  'ONE_OFF_SPEND',
  'OTHER',
] as const;
export type NonCatalogReason = (typeof NON_CATALOG_REASON)[number];

export const PO_STATUS = [
  'DRAFT',
  'PENDING_APPROVAL', // legacy
  'AWAITING_APPROVAL',
  'APPROVED',
  'ISSUED',
  'ACKNOWLEDGED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'PARTIALLY_INVOICED',
  'INVOICED',
  'CLOSED',
  'CANCELLED',
  'ON_HOLD',
] as const;
export type PoStatus = (typeof PO_STATUS)[number];

export const PO_TYPE = ['STANDARD', 'SPOT_BUY', 'BLANKET', 'AMENDMENT'] as const;
export type PoType = (typeof PO_TYPE)[number];

export const INCOTERMS = ['EXW', 'FOB', 'DDP', 'CIF'] as const;
export type Incoterm = (typeof INCOTERMS)[number];

export const BUDGET_PERIOD_TYPE = ['ANNUAL', 'QUARTERLY', 'MONTHLY'] as const;
export type BudgetPeriodType = (typeof BUDGET_PERIOD_TYPE)[number];

export const BUDGET_COMMITMENT_STATUS = [
  'COMMITTED',
  'PARTIALLY_TRANSFERRED',
  'TRANSFERRED',
  'RELEASED',
  'CONSUMED',
] as const;
export type BudgetCommitmentStatus = (typeof BUDGET_COMMITMENT_STATUS)[number];

export const COMMENT_SOURCE = ['BUYER', 'VENDOR'] as const;
export type CommentSource = (typeof COMMENT_SOURCE)[number];

export const GRN_QC_STATUS = [
  'PENDING', // legacy
  'PARTIAL', // legacy
  'NOT_STARTED',
  'IN_PROGRESS',
  'PASSED',
  'FAILED',
  'CONDITIONAL_PASS',
  'WAIVED',
] as const;
export type GrnQcStatus = (typeof GRN_QC_STATUS)[number];

// ── Goods receipt (Slice 5) ─────────────────────────────────────────────────

export const GRN_STATUS = ['DRAFT', 'PENDING_QC', 'POSTED', 'HOLD', 'REVERSED'] as const;
export type GrnStatus = (typeof GRN_STATUS)[number];

export const GRN_RECEIPT_TYPE = [
  'FULL',
  'PARTIAL',
  'OVER_RECEIPT',
  'RETURN_RECEIPT',
] as const;
export type GrnReceiptType = (typeof GRN_RECEIPT_TYPE)[number];

export const GRN_PACKING_CONDITION = [
  'OK',
  'DAMAGED_PACKING',
  'WET',
  'TAMPERED',
] as const;
export type GrnPackingCondition = (typeof GRN_PACKING_CONDITION)[number];

export const QC_SAMPLE_TYPE = ['ROUTINE', 'AQL', 'DESTRUCTIVE'] as const;
export type QcSampleType = (typeof QC_SAMPLE_TYPE)[number];

export const QC_SAMPLE_RESULT = ['PASS', 'FAIL', 'CONDITIONAL_PASS'] as const;
export type QcSampleResultStatus = (typeof QC_SAMPLE_RESULT)[number];

export const QC_DEFECT_SEVERITY = ['NONE', 'MINOR', 'MAJOR', 'CRITICAL'] as const;
export type QcDefectSeverity = (typeof QC_DEFECT_SEVERITY)[number];

export const GRN_ATTACHMENT_TYPE = [
  'DELIVERY_CHALLAN',
  'INVOICE_COPY',
  'COA',
  'PACKING_PHOTO',
  'DAMAGE_PHOTO',
  'LAB_REPORT',
] as const;
export type GrnAttachmentType = (typeof GRN_ATTACHMENT_TYPE)[number];

export const REJECTION_REASON = [
  'VISIBLE_DAMAGE',
  'WRONG_SPEC',
  'QUALITY_FAIL_DIM',
  'QUANTITY_SHORT',
  'DOCUMENTATION_MISSING',
] as const;
export type RejectionReason = (typeof REJECTION_REASON)[number];

/**
 * Rejections caused by the buyer (over-supply — the buyer over-ordered and
 * returns the excess) rather than a vendor defect. These must NOT count against
 * the vendor's quality score (audit I9). `QUANTITY_SHORT` is the codebase's
 * over-supply/return-excess reason (see REASON_FROM_REJECTION in rma.service).
 */
export const BUYER_FAULT_REJECTION_REASONS: readonly string[] = ['QUANTITY_SHORT'];

/** True when a rejection reflects vendor fault (and so dents quality). Unknown /
 *  null reasons are treated as vendor-fault (conservative — never hide a defect). */
export function isVendorFaultRejection(reason: string | null | undefined): boolean {
  return reason == null || !BUYER_FAULT_REJECTION_REASONS.includes(reason);
}

export const RMA_REASON_CODE = [
  'DAMAGED',
  'WRONG_ITEM',
  'QUALITY_FAIL',
  'OVER_SUPPLY',
] as const;
export type RmaReasonCode = (typeof RMA_REASON_CODE)[number];

export const RMA_STATUS = [
  'DRAFT',
  'ISSUED',
  'PICKED_UP',
  'CREDIT_NOTE_RECEIVED',
  'CLOSED',
  'CANCELLED',
] as const;
export type RmaStatus = (typeof RMA_STATUS)[number];

export const RETURN_FREIGHT_BORNE_BY = ['VENDOR', 'BUYER'] as const;
export type ReturnFreightBorneBy = (typeof RETURN_FREIGHT_BORNE_BY)[number];

export const STOCK_MOVEMENT_TYPE = [
  'GRN_RECEIPT',
  'RMA_ISSUE',
  'ADJUSTMENT',
  'CONSUMPTION',
] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPE)[number];

export const INVENTORY_VALUATION_METHOD = ['WEIGHTED_AVERAGE', 'FIFO'] as const;
export type InventoryValuationMethod = (typeof INVENTORY_VALUATION_METHOD)[number];

// Finalized in Slice 1.
export const INVOICE_STATUS = [
  'RECEIVED',
  'OCR_PENDING',
  'OCR_DONE',
  'OCR_LOW_CONFIDENCE', // Slice 10a — below tenant OCR floor; manual review queue
  'OCR_FAILED', // Slice 10a — provider permanently failed; manual data-entry fallback
  'PENDING_VENDOR_MATCH', // Slice 10a — inbound email from an unrecognised sender
  'MATCH_EXCEPTION',
  'AWAITING_APPROVAL',
  'APPROVED',
  'SCHEDULED',
  'PAID',
  'HELD',
  'REJECTED',
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUS)[number];

// Slice 10a — integration providers + inbound-email + attachment doc types.
export const INTEGRATION_PROVIDER = [
  'OCR',
  'GSP',
  'EMAIL_INBOUND',
  'PENNY_DROP',
  'BANK',
  'GSTN',
  'PAN',
  'UDYAM',
  'MCA',
  'SANCTIONS',
  'ADVERSE_MEDIA',
  'CREDIT_BUREAU',
  'ISO_CERT',
  'CAPTCHA',
] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDER)[number];

export const INBOUND_EMAIL_STATUS = [
  'RECEIVED',
  'INVOICE_CREATED',
  'PENDING_VENDOR_MATCH',
  'DEAD_LETTER',
] as const;
export type InboundEmailStatus = (typeof INBOUND_EMAIL_STATUS)[number];

export const INVOICE_ATTACHMENT_TYPE = [
  'INVOICE_PDF',
  'EMAIL_BODY',
  'SUPPORTING',
] as const;
export type InvoiceAttachmentType = (typeof INVOICE_ATTACHMENT_TYPE)[number];

/** Live IRN validation outcome (Slice 10a). */
export const IRN_VALIDATION_STATUS = [
  'NOT_REQUIRED',
  'VALID',
  'INVALID',
  'PENDING_VERIFICATION',
] as const;
export type IrnValidationStatus = (typeof IRN_VALIDATION_STATUS)[number];

export const EXCEPTION_TYPE = [
  'RATE_VARIANCE',
  'QTY_VARIANCE',
  'TAX_VARIANCE',
  'UNAUTHORISED_LINE',
  'PO_MISSING',
  'GRN_MISSING',
  'DUPLICATE',
  'GSTIN_INACTIVE',
  'GSTR2B_MISMATCH',
  // Slice 15 — controls that were named in the enum's spirit but never checked.
  // Until these existed a document could disagree with its PO on unit of
  // measure, predate the order it bills against, bill a cancelled PO, or carry
  // a printed total that disagreed with its own line items, and the matcher
  // returned MATCHED.
  'UOM_MISMATCH',
  'DATE_SEQUENCE',
  'PO_NOT_OPEN',
  'AMOUNT_MISMATCH',
  'VENDOR_BLOCKED',
] as const;
export type ExceptionType = (typeof EXCEPTION_TYPE)[number];

export const EXCEPTION_RESOLUTION_ACTION = [
  'ACCEPT_VARIANCE',
  'REJECT_LINE',
  'DEBIT_NOTE',
  'QUERY_VENDOR',
] as const;
export type ExceptionResolutionAction = (typeof EXCEPTION_RESOLUTION_ACTION)[number];

export const MSME_AGING_BUCKET = ['SAFE', 'APPROACHING', 'BREACH'] as const;
export type MsmeAgingBucket = (typeof MSME_AGING_BUCKET)[number];

export const INVOICE_SOURCE = ['EMAIL', 'PORTAL', 'MANUAL', 'EDI'] as const;
export type InvoiceSource = (typeof INVOICE_SOURCE)[number];

export const GSTR2B_STATUS = [
  'PENDING',
  'MATCHED',
  'MISMATCH_AMOUNT',
  'MISMATCH_DATE',
  'NOT_FOUND',
] as const;
export type Gstr2bStatus = (typeof GSTR2B_STATUS)[number];

export const EXCEPTION_SEVERITY = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type ExceptionSeverity = (typeof EXCEPTION_SEVERITY)[number];

export const PAYMENT_RUN_STATUS = [
  'DRAFT',
  'COMPOSED',
  'PENDING_APPROVAL',
  'AWAITING_APPROVAL',
  'APPROVED',
  'SUBMITTED',
  'SUBMITTED_PENDING_BANK_CONFIRMATION', // Slice 10b
  'SUBMITTED_TO_BANK',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type PaymentRunStatus = (typeof PAYMENT_RUN_STATUS)[number];

// Slice 10b — per-item bank submission outcome.
export const PAYMENT_ITEM_BANK_STATUS = [
  'PENDING',
  'SUBMITTED',
  'CONFIRMED',
  'FAILED',
] as const;
export type PaymentItemBankStatus = (typeof PAYMENT_ITEM_BANK_STATUS)[number];

export const APPROVAL_DECISION = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CHANGES_REQUESTED',
  'DELEGATED',
] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISION)[number];

export const VENDOR_STATUS = [
  'DRAFT',
  'PENDING_VERIFICATION',
  'ACTIVE',
  'SUSPENDED',
  'BLOCKED',
] as const;
export type VendorStatus = (typeof VENDOR_STATUS)[number];

export const DOCUMENT_TYPE = [
  'REQUISITION',
  'PURCHASE_ORDER',
  'GRN',
  'INVOICE',
  'PAYMENT_RUN',
  'CONTRACT', // Slice 9 — contract execution routes through the Slice 2 engine
  'CONTRACT_AMENDMENT', // Slice 9 — mid-validity change, scaled to the change value
  'RFQ_AWARD', // Slice 6 — sourcing award routes through the Slice 2 engine
  'VENDOR_ONBOARDING', // Slice 7 — vendor onboarding routes through the Slice 2 engine
  'VENDOR_CHANGE', // Slice 7 — material post-activation change approval
] as const;
export type DocumentType = (typeof DOCUMENT_TYPE)[number];
