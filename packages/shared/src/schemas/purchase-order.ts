import { z } from 'zod';

import type { LiveApprovalStep } from './approvals';
import { CONTRACT_CLAUSE_TYPE } from '../constants/contract-status';
import { INCOTERMS, PO_TYPE } from '../constants/status';

const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'must be a decimal string');

/** Payment terms a buyer can put on an order. NET_* and MSME_45 run from the
 *  invoice date; the DELIVERY_* terms run from delivery, and ADVANCE is paid
 *  before it. */
export const PAYMENT_TERM_KINDS = [
  'ADVANCE',
  'NET_30',
  'NET_45',
  'NET_60',
  'MSME_45',
  'DELIVERY_7',
  'DELIVERY_15',
  'MILESTONE',
] as const;
export type PaymentTermKind = (typeof PAYMENT_TERM_KINDS)[number];

/** Wording printed on the PO when an order captured no label of its own. */
export const PAYMENT_TERM_LABELS: Record<PaymentTermKind, string> = {
  ADVANCE: 'Advance',
  NET_30: 'Net 30',
  NET_45: 'Net 45',
  NET_60: 'Net 60',
  MSME_45: 'MSME 45 (s.15 cap)',
  DELIVERY_7: '7 days from delivery',
  DELIVERY_15: '15 days from delivery',
  MILESTONE: 'Milestone',
};

export const PaymentTermsSchemaKind = z.enum(PAYMENT_TERM_KINDS);
export const PaymentTermsSchema = z.object({
  kind: PaymentTermsSchemaKind,
  days: z.number().int().min(0).max(180).nullish(),
  label: z.string().max(120).nullish(),
});
export type PaymentTerms = z.infer<typeof PaymentTermsSchema>;

export const DeliveryAddressSchema = z.object({
  label: z.string().max(120).nullish(),
  line1: z.string().max(200),
  line2: z.string().max(200).nullish(),
  city: z.string().max(80).nullish(),
  stateCode: z.string().max(2).nullish(),
  pincode: z.string().max(10).nullish(),
});
export type DeliveryAddress = z.infer<typeof DeliveryAddressSchema>;

// ── Inputs ─────────────────────────────────────────────────────────────────

export const PoFromPrLineInputSchema = z.object({
  prLineId: z.string().min(1),
  qtyOrdered: decimalString,
  unitPrice: decimalString.nullish(),
  taxRate: decimalString.nullish(),
  glAccount: z.string().max(40).nullish(),
  deliveryDateLine: z.string().datetime().nullish(),
  varianceJustification: z.string().max(1000).nullish(),
});
export type PoFromPrLineInput = z.infer<typeof PoFromPrLineInputSchema>;

export const PoSpotBuyLineInputSchema = z.object({
  itemId: z.string().nullish(),
  itemDesc: z.string().min(1).max(500),
  hsnCode: z.string().max(12).nullish(),
  uom: z.string().min(1).max(20),
  qtyOrdered: decimalString,
  unitPrice: decimalString,
  discountPct: decimalString.default('0'),
  taxRate: decimalString.default('0'),
  glAccount: z.string().max(40).nullish(),
});
export type PoSpotBuyLineInput = z.infer<typeof PoSpotBuyLineInputSchema>;

export const PoCreateFromPrInputSchema = z.object({
  kind: z.literal('FROM_PR'),
  /** GST registration the order bills to. Decides the GSTIN printed on the
   *  PO and the place of supply — under IGST Act s.10(1)(b) this, not the
   *  ship-to address, sets CGST+SGST vs IGST. Defaults to the requisition's
   *  branch, else the tenant's default registration. */
  billToPlantId: z.string().min(1).nullish(),
  requisitionId: z.string().min(1),
  vendorId: z.string().min(1),
  deliveryAddress: DeliveryAddressSchema.nullish(),
  deliveryTerms: z.enum(INCOTERMS).default('DDP'),
  paymentTerms: PaymentTermsSchema,
  expectedDeliveryDate: z.string().datetime(),
  lines: z.array(PoFromPrLineInputSchema).min(1),
});
export type PoCreateFromPrInput = z.infer<typeof PoCreateFromPrInputSchema>;

/** Call-off line: qty only — unit price is pulled from the rate card, never
 *  supplied by the caller (rate immutability, Slice 9 / ADR-029). */
export const PoFromContractLineInputSchema = z.object({
  contractRateCardId: z.string().min(1),
  qtyOrdered: decimalString,
});
export type PoFromContractLineInput = z.infer<typeof PoFromContractLineInputSchema>;

export const PoCreateFromContractInputSchema = z.object({
  kind: z.literal('FROM_CONTRACT'),
  /** GST registration the order bills to. Decides the GSTIN printed on the
   *  PO and the place of supply — under IGST Act s.10(1)(b) this, not the
   *  ship-to address, sets CGST+SGST vs IGST. Defaults to the requisition's
   *  branch, else the tenant's default registration. */
  billToPlantId: z.string().min(1).nullish(),
  contractId: z.string().min(1),
  deliveryAddress: DeliveryAddressSchema.nullish(),
  deliveryTerms: z.enum(INCOTERMS).default('DDP'),
  expectedDeliveryDate: z.string().datetime(),
  lines: z.array(PoFromContractLineInputSchema).min(1),
});
export type PoCreateFromContractInput = z.infer<typeof PoCreateFromContractInputSchema>;

export const PoCreateSpotBuyInputSchema = z.object({
  kind: z.literal('SPOT_BUY'),
  /** GST registration the order bills to. Decides the GSTIN printed on the
   *  PO and the place of supply — under IGST Act s.10(1)(b) this, not the
   *  ship-to address, sets CGST+SGST vs IGST. Defaults to the requisition's
   *  branch, else the tenant's default registration. */
  billToPlantId: z.string().min(1).nullish(),
  vendorId: z.string().min(1),
  costCenterId: z.string().min(1),
  deliveryAddress: DeliveryAddressSchema.nullish(),
  deliveryTerms: z.enum(INCOTERMS).default('DDP'),
  paymentTerms: PaymentTermsSchema,
  expectedDeliveryDate: z.string().datetime(),
  lines: z.array(PoSpotBuyLineInputSchema).min(1),
});
export type PoCreateSpotBuyInput = z.infer<typeof PoCreateSpotBuyInputSchema>;

/** Union create schema — from an approved PR, a spot buy (Slice 4), or a
 *  contract call-off (Slice 9). */
export const PoCreateInputSchema = z.discriminatedUnion('kind', [
  PoCreateFromPrInputSchema,
  PoCreateSpotBuyInputSchema,
  PoCreateFromContractInputSchema,
]);
export type PoCreateInput = z.infer<typeof PoCreateInputSchema>;

export const PoUpdateInputSchema = z.object({
  /** Move a draft to another GST registration. Recomputes the place of
   *  supply; refused once the order has left DRAFT. */
  billToPlantId: z.string().min(1).nullish(),
  deliveryAddress: DeliveryAddressSchema.nullish(),
  deliveryTerms: z.enum(INCOTERMS).nullish(),
  paymentTerms: PaymentTermsSchema.nullish(),
  expectedDeliveryDate: z.string().datetime().nullish(),
  lines: z
    .array(
      z.object({
        id: z.string().min(1),
        qtyOrdered: decimalString.nullish(),
        unitPrice: decimalString.nullish(),
        taxRate: decimalString.nullish(),
        glAccount: z.string().max(40).nullish(),
      }),
    )
    .nullish(),
});
export type PoUpdateInput = z.infer<typeof PoUpdateInputSchema>;

export const PoListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().nullish(),
  status: z.string().nullish(),
  vendorId: z.string().nullish(),
  costCenterId: z.string().nullish(),
  poType: z.enum(PO_TYPE).nullish(),
  fulfilmentBucket: z.enum(['open', 'partial', 'complete', 'cancelled']).nullish(),
  amountMin: decimalString.nullish(),
  amountMax: decimalString.nullish(),
  tab: z.enum(['open', 'partial', 'awaiting_grn', 'closed', 'cancelled']).default('open'),
});
export type PoListQuery = z.infer<typeof PoListQuerySchema>;

export const PoDecisionInputSchema = z.object({
  approvalId: z.string().min(1),
  decision: z.enum(['APPROVE', 'REJECT', 'REQUEST_CHANGES']),
  comment: z.string().max(2000).nullish(),
});
export type PoDecisionInput = z.infer<typeof PoDecisionInputSchema>;

export const PoCancelInputSchema = z.object({
  reason: z.string().min(1).max(500),
});
export type PoCancelInput = z.infer<typeof PoCancelInputSchema>;

export const PoHoldInputSchema = z.object({
  reason: z.string().min(1).max(500),
});
export type PoHoldInput = z.infer<typeof PoHoldInputSchema>;

export const PoCommentInputSchema = z.object({
  body: z.string().min(1).max(4000),
});
export type PoCommentInput = z.infer<typeof PoCommentInputSchema>;

export const VendorPoQueryInputSchema = z.object({
  body: z.string().min(1).max(2000),
  s3Keys: z.array(z.string()).default([]),
});
export type VendorPoQueryInput = z.infer<typeof VendorPoQueryInputSchema>;

// ── Attachments ────────────────────────────────────────────────────────────

/**
 * Supporting documents on a PO. QUOTE carries the weight here: a spot buy is
 * raised straight off an offline vendor quote with no PR behind it, so this is
 * the only place the evidence for the price can live.
 *
 * Buyer-side only — these are never listed on the vendor portal.
 */
export const PO_ATTACHMENT_TYPE = [
  'QUOTE',
  'PROFORMA_INVOICE',
  'EMAIL_APPROVAL',
  'SPECIFICATION',
  'DRAWING',
  'OTHER',
] as const;
export type PoAttachmentType = (typeof PO_ATTACHMENT_TYPE)[number];

/** Multipart side-fields that accompany the uploaded `file` part. */
export const PoAttachmentUploadMetaSchema = z.object({
  docType: z.enum(PO_ATTACHMENT_TYPE).default('OTHER'),
  note: z.string().max(500).nullish(),
});
export type PoAttachmentUploadMeta = z.infer<typeof PoAttachmentUploadMetaSchema>;

export interface PoAttachmentView {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  docType: PoAttachmentType;
  note: string | null;
  /**
   * The PO was already issued when this was uploaded, so neither the approver
   * nor the vendor saw it. Surfaced so a late document is never mistaken for
   * the evidence the order rested on.
   */
  addedAfterIssue: boolean;
  uploadedAt: string;
  uploadedBy: string;
  uploadedByName: string | null;
  url: string;
}

// ── Terms & conditions ─────────────────────────────────────────────────────

/**
 * One term printed on the PO PDF. Library clauses are *copied* in at selection
 * time rather than referenced, so re-issuing an old PO reproduces the wording
 * that was actually agreed; `libraryClauseId` is provenance only.
 */
export const PoTermInputSchema = z.object({
  clauseType: z.enum(CONTRACT_CLAUSE_TYPE),
  title: z.string().min(1).max(200),
  contentText: z.string().min(1).max(4000),
  /** Set when the row came from ClauseLibrary; false for a typed special condition. */
  isFromLibrary: z.boolean().default(false),
  libraryClauseId: z.string().nullish(),
});
export type PoTermInput = z.infer<typeof PoTermInputSchema>;

/** Replaces the PO's whole term set; array order becomes the printed order. */
export const PoTermsSetInputSchema = z.object({
  terms: z.array(PoTermInputSchema).max(50),
});
export type PoTermsSetInput = z.infer<typeof PoTermsSetInputSchema>;

export interface PoTermView {
  id: string;
  clauseType: string;
  title: string;
  contentText: string;
  isFromLibrary: boolean;
  libraryClauseId: string | null;
  orderNo: number;
}

// ── Read models ────────────────────────────────────────────────────────────

export interface PoLineView {
  id: string;
  lineNo: number;
  prLineId: string | null;
  itemId: string | null;
  itemDesc: string;
  hsnCode: string | null;
  uom: string;
  qtyOrdered: string;
  qtyReceived: string;
  /**
   * Billed by live invoices, summed from their lines. NOT the
   * `PurchaseOrderLine.qtyInvoiced` column, which is written by nothing and is
   * zero on every row.
   */
  qtyInvoiced: string;
  unitPrice: string;
  discountPct: string;
  taxRate: string;
  lineTotal: string;
  glAccount: string | null;
  fulfilmentPct: number;
}

/**
 * How far a purchase order has got along ONE axis. Receipt and billing move
 * independently — an order can be fully invoiced with nothing received, which
 * is precisely the case worth seeing — so they are reported separately rather
 * than collapsed into `status`.
 *
 * `status` itself stays the authorisation/lifecycle state (draft → issued →
 * acknowledged → closed). It cannot also carry billing: GRN posting already
 * owns that column for the receipt axis, setting PARTIALLY_RECEIVED/RECEIVED
 * and reverting to ISSUED when a receipt is reversed. A second writer would
 * clobber it.
 *
 * OVER is reachable on the billing axis only, and means more has been invoiced
 * than was ever ordered.
 */
export type PoProgress = 'NONE' | 'PARTIAL' | 'COMPLETE' | 'OVER';

/** The two independent axes, derived at read time from lines and invoices. */
export interface PoFulfilment {
  receipt: PoProgress;
  billing: PoProgress;
  /** 0–100, capped at 100 for display; `billing: 'OVER'` carries the overage. */
  receivedPct: number;
  billedPct: number;
}

export interface PoListItem {
  id: string;
  number: string;
  vendor: { id: string; name: string; isMsme: boolean };
  description: string;
  costCenter: { id: string; code: string; name: string } | null;
  status: string;
  poType: string;
  fulfilmentPct: number;
  /** Receipt and billing progress, independent of `status`. */
  fulfilment: PoFulfilment;
  expectedDeliveryDate: string | null;
  totalAmount: string;
  currency: string;
  acknowledged: boolean;
}

export interface PoListResponse {
  items: PoListItem[];
  nextCursor: string | null;
  totalEstimate: number;
  counts: {
    open: number;
    partial: number;
    awaiting_grn: number;
    closed: number;
    cancelled: number;
  };
}

export interface PoDetailResponse {
  id: string;
  number: string;
  status: string;
  /** Receipt and billing progress, independent of `status`. */
  fulfilment: PoFulfilment;
  poType: string;
  isAmendmentOf: string | null;
  vendor: {
    id: string;
    name: string;
    code: string;
    gstin: string | null;
    isMsme: boolean;
  };
  requisition: { id: string; number: string } | null;
  /** The GST registration this order bills to — drives the GSTIN printed on
   *  the PO and the place of supply. */
  billTo: { id: string; name: string; gstin: string | null; stateCode: string } | null;
  stages: { key: string; label: string; state: 'done' | 'active' | 'todo' }[];
  lines: PoLineView[];
  amounts: {
    subtotal: string;
    taxAmount: string;
    taxKind: string;
    total: string;
    currency: string;
  };
  deliveryAddress: DeliveryAddress | null;
  deliveryTerms: string | null;
  paymentTerms: PaymentTerms | null;
  expectedDeliveryDate: string | null;
  issuedAt: string | null;
  acknowledgedAt: string | null;
  pdfAvailable: boolean;
  budgetCommitment: { budgetId: string; amount: string } | null;
  grnLinks: { id: string; number: string; qcStatus: string }[];
  invoiceLinks: { id: string; number: string; status: string }[];
  /** The generated PO PDF, not user uploads — see `supportingDocuments`. */
  attachments: { id: string; url: string; mimeType: string }[];
  /** Buyer-uploaded evidence (above all the offline quote). Never sent to the vendor. */
  supportingDocuments: PoAttachmentView[];
  /** Terms printed on the PDF. Also returned to the vendor, who signs against them. */
  terms: PoTermView[];
  comments: {
    id: string;
    authorId: string;
    authorName: string;
    source: string;
    isQuery: boolean;
    body: string;
    createdAt: string;
  }[];
  activity: { id: string; action: string; actorId: string | null; at: string }[];
  liveApprovalChain: LiveApprovalStep[];
  myApprovalId: string | null;
  canDecide: boolean;
  canIssue: boolean;
  canCancel: boolean;
  canHold: boolean;
  fulfilmentPct: number;
}

// ── Vendor-portal read models ────────────────────────────────────────────────

export interface VendorPoListItem {
  id: string;
  number: string;
  description: string;
  orderedDate: string | null;
  expectedDeliveryDate: string | null;
  fulfilmentPct: number;
  totalAmount: string;
  currency: string;
  status: string;
  acknowledged: boolean;
}

export interface VendorPoListResponse {
  items: VendorPoListItem[];
  nextCursor: string | null;
  totalEstimate: number;
}

export interface VendorPoDetailResponse {
  id: string;
  number: string;
  status: string;
  orderedDate: string | null;
  expectedDeliveryDate: string | null;
  deliveryAddress: DeliveryAddress | null;
  deliveryTerms: string | null;
  paymentTerms: PaymentTerms | null;
  lines: {
    lineNo: number;
    itemDesc: string;
    hsnCode: string | null;
    uom: string;
    qtyOrdered: string;
    unitPrice: string;
    taxRate: string;
    lineTotal: string;
  }[];
  amounts: {
    subtotal: string;
    taxAmount: string;
    taxKind: string;
    total: string;
    currency: string;
  };
  acknowledgedAt: string | null;
  pdfAvailable: boolean;
  /**
   * The same terms printed on the PDF. The vendor acknowledges against these,
   * so they must be readable on screen and not only inside the attachment.
   * Buyer-side supporting documents are deliberately absent from this view.
   */
  terms: PoTermView[];
  queries: {
    id: string;
    body: string;
    source: string;
    createdAt: string;
  }[];
}
