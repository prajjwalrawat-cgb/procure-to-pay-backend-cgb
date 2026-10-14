import { z } from 'zod';

import type { LiveApprovalStep } from './approvals';
import type { InvoicePaymentInfo } from './payments';
import {
  EXCEPTION_RESOLUTION_ACTION,
  EXCEPTION_TYPE,
  INVOICE_STATUS,
} from '../constants/status';

/** Decimal string, e.g. "18900.00". Money never crosses the wire as a number. */
const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'must be a decimal string');

export const InvoiceLineInputSchema = z.object({
  lineNo: z.number().int().positive(),
  itemDesc: z.string().min(1).max(500),
  uom: z.string().min(1).max(20),
  qty: decimalString,
  unitPrice: decimalString,
  taxRate: decimalString.default('0'),
  poLineId: z.string().nullish(),
});
export type InvoiceLineInput = z.infer<typeof InvoiceLineInputSchema>;

/**
 * What the document on an invoice is. A PROFORMA (PI) is what some suppliers
 * send to collect an advance before supplying; the tax invoice follows and
 * replaces it on the same record.
 */
export const INVOICE_DOCUMENT_KIND = ['TAX_INVOICE', 'PROFORMA'] as const;
export type InvoiceDocumentKind = (typeof INVOICE_DOCUMENT_KIND)[number];

export const InvoiceCreateInputSchema = z.object({
  vendorId: z.string().min(1),
  poId: z.string().nullish(),
  vendorInvoiceRef: z.string().min(1).max(100),
  invoiceDate: z.string().datetime(),
  irn: z.string().max(100).nullish(),
  ewaybillNo: z.string().max(50).nullish(),
  lines: z.array(InvoiceLineInputSchema).min(1),
});
export type InvoiceCreateInput = z.infer<typeof InvoiceCreateInputSchema>;

export const VendorInvoiceSubmitInputSchema = z.object({
  poId: z.string().min(1),
  vendorInvoiceRef: z.string().min(1).max(100),
  invoiceDate: z.string().datetime(),
  s3Key: z.string().min(1),
  irn: z.string().max(100).nullish(),
  ewaybillNo: z.string().max(50).nullish(),
  lines: z.array(InvoiceLineInputSchema.extend({ reason: z.string().nullish() })).min(1),
  documentKind: z.enum(INVOICE_DOCUMENT_KIND).default('TAX_INVOICE'),
});
export type VendorInvoiceSubmitInput = z.infer<typeof VendorInvoiceSubmitInputSchema>;

/**
 * The tax invoice that replaces a proforma on the same record.
 *
 * Header and lines are asserted by whoever uploads it — seeded from the PI,
 * which the tax invoice usually repeats — exactly as on a portal submission.
 * OCR then reads the page and checks it against them (printed total, number,
 * date, supplier) rather than overwriting them.
 */
export const TaxInvoiceInputSchema = z.object({
  s3Key: z.string().min(1),
  vendorInvoiceRef: z.string().min(1).max(100),
  invoiceDate: z.string().datetime(),
  irn: z.string().max(100).nullish(),
  ewaybillNo: z.string().max(50).nullish(),
  lines: z.array(InvoiceLineInputSchema).min(1),
});
export type TaxInvoiceInput = z.infer<typeof TaxInvoiceInputSchema>;

export const DocumentKindInputSchema = z.object({
  kind: z.enum(INVOICE_DOCUMENT_KIND),
});
export type DocumentKindInput = z.infer<typeof DocumentKindInputSchema>;

/**
 * What `resolve-and-route` did. A tax invoice that replaced an already-approved
 * proforma keeps that approval unless it changed materially; `reasons` says
 * why it went back to the approver when it did.
 */
export interface ResolveAndRouteResult {
  outcome: 'ROUTED' | 'APPROVAL_CARRIED_OVER';
  reasons: string[];
}

export const InvoiceListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().nullish(),
  status: z
    .string()
    .nullish()
    .transform((v) => (v ? v.split(',') : undefined))
    .pipe(z.array(z.enum(INVOICE_STATUS)).optional()),
  vendorId: z.string().nullish(),
  exceptionType: z.enum(EXCEPTION_TYPE).nullish(),
  assignedToId: z.string().nullish(),
  msmeRisk: z.coerce.boolean().nullish(),
  tab: z
    .enum([
      'all',
      'exceptions',
      'approval',
      'approved',
      'scheduled',
      'paid',
      'msme',
      'proforma',
      'rejected',
    ])
    .default('all'),
});
export type InvoiceListQuery = z.infer<typeof InvoiceListQuerySchema>;

export const ExceptionResolutionInputSchema = z.object({
  action: z.enum(EXCEPTION_RESOLUTION_ACTION),
  notes: z.string().max(2000).nullish(),
});
export type ExceptionResolutionInput = z.infer<typeof ExceptionResolutionInputSchema>;

export const CommentInputSchema = z.object({
  body: z.string().min(1).max(4000),
});
export type CommentInput = z.infer<typeof CommentInputSchema>;

export const HoldInputSchema = z.object({
  reason: z.string().min(1).max(500),
});
export type HoldInput = z.infer<typeof HoldInputSchema>;

/** Buyer rejects an invoice before approval. The reason is shown to the vendor. */
export const RejectInvoiceInputSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});
export type RejectInvoiceInput = z.infer<typeof RejectInvoiceInputSchema>;

export const AssignInputSchema = z.object({
  userId: z.string().min(1),
});
export type AssignInput = z.infer<typeof AssignInputSchema>;

// ── Response read-models (typed, shared with the frontend) ─────────────────

export type InvoiceTab =
  | 'all'
  | 'exceptions'
  | 'approval'
  | 'approved'
  | 'scheduled'
  | 'paid'
  | 'msme'
  | 'proforma'
  | 'rejected';

export interface InvoiceTabCounts {
  all: number;
  exceptions: number;
  approval: number;
  approved: number;
  scheduled: number;
  paid: number;
  msme: number;
  /** Proformas still waiting for their tax invoice. */
  proforma: number;
  rejected: number;
}

export interface MsmeSummary {
  bucket: 'SAFE' | 'APPROACHING' | 'BREACH';
  dueDate: string;
  daysRemaining: number;
}

export interface InvoiceListItem {
  id: string;
  number: string;
  vendorInvoiceRef: string;
  vendor: { id: string; name: string; isMsme: boolean };
  poNumber: string | null;
  grnNumber: string | null;
  status: string;
  agingDays: number;
  grossAmount: string;
  currency: string;
  exceptionCount: number;
  msme: MsmeSummary | null;
  assignedTo: { id: string; name: string } | null;
  documentKind: InvoiceDocumentKind;
}

export interface InvoiceListResponse {
  items: InvoiceListItem[];
  nextCursor: string | null;
  totalEstimate: number;
}

export interface InvoiceExceptionView {
  id: string;
  type: string;
  severity: string;
  poLineId: string | null;
  invoiceLineId: string | null;
  expected: string | null;
  actual: string | null;
  variancePct: string | null;
  impactWithTax: string | null;
  message: string;
  resolved: boolean;
  resolutionAction: string | null;
  resolutionNotes: string | null;
  /**
   * Who overrode the exception, and when. An approver needs to see that a
   * HIGH exception was waved through and by whom — "0 open exceptions" reads
   * identically whether the match was clean or somebody accepted the risk.
   */
  resolvedByName: string | null;
  resolvedAt: string | null;
  /**
   * Raised on a proforma since replaced by its tax invoice. History only: not
   * open, not an override that still counts, and not re-applied to the tax
   * invoice, which is matched from a clean slate.
   */
  superseded: boolean;
}

export interface InvoiceLineView {
  id: string;
  lineNo: number;
  itemDesc: string;
  uom: string;
  qty: string;
  unitPrice: string;
  taxRate: string;
  lineTotal: string;
  poLineId: string | null;
  hasVariance: boolean;
}

export interface ApprovalChainStepView {
  stepNo: number;
  role: string;
  slaHours: number;
}

export interface InvoiceDetailResponse {
  id: string;
  number: string;
  vendorInvoiceRef: string;
  status: string;
  source: string;
  invoiceDate: string;
  receivedAt: string;
  documentKind: InvoiceDocumentKind;
  /**
   * Set once a tax invoice has replaced a proforma on this record: the PI's
   * reference, the total approved against it, and when the tax invoice came in.
   */
  proformaRef: string | null;
  proformaGrossAmount: string | null;
  taxInvoiceReceivedAt: string | null;
  /**
   * An approval was given on this record before its current document arrived —
   * resolve-and-route will keep it unless the tax invoice changed materially.
   */
  priorApproval: boolean;
  /** Why the balance cannot be paid yet (an unpaid-for proforma), or null. */
  paymentBlockedReason: string | null;
  /** Why a buyer rejected it before approval, or null. */
  rejectionReason: string | null;
  stages: { key: string; label: string; state: 'done' | 'active' | 'todo' }[];
  vendor: {
    id: string;
    name: string;
    code: string;
    gstin: string | null;
    isMsme: boolean;
    riskScore: string | null;
    onTimePct: string | null;
    qualityPct: string | null;
    fytdSpend: string;
  };
  po: { id: string; number: string; status: string } | null;
  grn: { id: string; number: string; qcStatus: string } | null;
  lines: InvoiceLineView[];
  poLines: {
    id: string;
    lineNo: number;
    itemDesc: string;
    uom: string;
    qtyOrdered: string;
    /** Accepted on posted goods receipts against this line. */
    qtyReceived: string;
    /**
     * Billed against this line by OTHER live invoices — this one excluded.
     *
     * Without it the match card shows "1000 ordered" beside "200 invoiced" and
     * reads as though 800 remain, when two earlier invoices may already have
     * taken it. The reviewer cannot see the other invoices from here, so the
     * card has to carry the number.
     */
    qtyInvoicedElsewhere: string;
    unitPrice: string;
    taxRate: string;
  }[];
  /**
   * The other live invoices raised against this invoice's purchase order.
   *
   * The match card can say how much has been claimed elsewhere, but not by
   * whom — and a reviewer who has just been told 100 units are already spoken
   * for immediately wants to know by which invoice, in what state, for how
   * much. Without this the only route is to open the PO and read its invoice
   * list, which is two navigations away from the decision being made.
   *
   * REJECTED excluded, so this lists exactly the claims that still count.
   */
  relatedInvoices: {
    id: string;
    number: string;
    vendorInvoiceRef: string;
    status: string;
    grossAmount: string;
    invoiceDate: string;
  }[];
  exceptions: InvoiceExceptionView[];
  suggestedResolution: string | null;
  matchSummary: { poSubtotal: string; invoiceSubtotal: string; varianceTotal: string };
  amounts: {
    subtotal: string;
    taxAmount: string;
    taxKind: string;
    tdsAmount: string;
    grossAmount: string;
    netPayable: string;
    currency: string;
  };
  msme: MsmeSummary | null;
  compliance: {
    irn: string | null;
    ewaybillNo: string | null;
    gstr2bStatus: string;
    gstinStatus: string;
  };
  attachments: {
    id: string;
    url: string;
    mimeType: string;
    /** INVOICE_PDF, PROFORMA_PDF (a replaced PI), EMAIL_BODY or SUPPORTING. */
    docType: string;
    uploadedAt: string;
  }[];
  comments: {
    id: string;
    authorId: string;
    authorName: string;
    body: string;
    createdAt: string;
  }[];
  activity: { id: string; action: string; actorId: string | null; at: string }[];
  pendingApprovalChain: ApprovalChainStepView[];
  /** Live, resolved approval chain (Slice 2): real approvers, decisions, SLA. */
  liveApprovalChain: LiveApprovalStep[];
  /** The current viewer's pending approval id for this doc, if it's their turn. */
  myApprovalId: string | null;
  canDecide: boolean;
  assignedTo: { id: string; name: string } | null;
  /** The most recent payment posted against the invoice (Slice 3). */
  payment: InvoicePaymentInfo | null;
  /** Every payment posted against the invoice, oldest first. */
  payments: InvoicePaymentInfo[];
  /** Settled so far and still owed, both before TDS (against grossAmount). */
  amountPaid: string;
  amountOutstanding: string;
  /**
   * A payment run that currently holds this invoice and has not been confirmed
   * by the bank. While one does, a payment cannot be recorded by hand — the run
   * is already committed to paying its amount.
   */
  activePaymentRun: { id: string; number: string } | null;
}

export interface VendorPoOption {
  id: string;
  number: string;
  currency: string;
  /**
   * Every line fully billed. Options carrying this are filtered out before the
   * portal sees them; the field stays on the type so a caller that wants to
   * show exhausted orders (a buyer-side view, say) can tell them apart rather
   * than inferring it from quantities.
   */
  fullyInvoiced: boolean;
  lines: {
    id: string;
    lineNo: number;
    itemDesc: string;
    hsnCode: string | null;
    uom: string;
    qtyOrdered: string;
    /** Accepted on posted goods receipts against this line. */
    qtyReceived: string;
    /**
     * Already billed by other live invoices — summed from their lines, the same
     * way the matcher does it, because `PurchaseOrderLine.qtyInvoiced` is read
     * in three places and written by nothing.
     */
    qtyInvoiced: string;
    /**
     * What the supplier can still bill without tripping QTY_VARIANCE: received
     * where anything has been received, else ordered, less what is already
     * billed. Clamped at zero.
     *
     * The submit form seeds the quantity from this rather than from
     * `qtyOrdered`. Seeding the full order on a part-billed PO hands the
     * supplier a number the matcher is guaranteed to reject — the form would be
     * walking them into an exception it had the data to prevent.
     */
    qtyBillable: string;
    unitPrice: string;
    /** Fraction, e.g. "0.05" for 5% — the rate the PO was raised at. */
    taxRate: string;
  }[];
  /**
   * Ordered value of the PO including GST, so the portal shows the supplier the
   * same figure the PO screen and the PO PDF do (tax-exclusive totals read as a
   * short-payment to a vendor comparing the two).
   */
  amounts: {
    subtotal: string;
    taxAmount: string;
    /** Human label, e.g. "IGST" / "CGST + SGST". */
    taxKind: string;
    total: string;
  };
}
