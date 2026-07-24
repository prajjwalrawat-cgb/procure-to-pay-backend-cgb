import { z } from 'zod';

import {
  GRN_ATTACHMENT_TYPE,
  GRN_PACKING_CONDITION,
  GRN_RECEIPT_TYPE,
  QC_SAMPLE_TYPE,
  REJECTION_REASON,
} from '../constants/status';

const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'must be a decimal string');

// ── Inputs ─────────────────────────────────────────────────────────────────

export const GrnLineReceiptInputSchema = z.object({
  poLineId: z.string().min(1),
  qtyReceived: decimalString,
  uomReceived: z.string().max(20).nullish(),
  batchNumber: z.string().max(60).nullish(),
  lotNumber: z.string().max(60).nullish(),
  serialNumbers: z.array(z.string().max(120)).default([]),
  manufacturingDate: z.string().datetime().nullish(),
  expiryDate: z.string().datetime().nullish(),
  storageLocation: z.string().max(120).nullish(),
  binCode: z.string().max(60).nullish(),
});
export type GrnLineReceiptInput = z.infer<typeof GrnLineReceiptInputSchema>;

export const GrnCreateInputSchema = z.object({
  poId: z.string().min(1),
  receiptType: z.enum(GRN_RECEIPT_TYPE).default('PARTIAL'),
  gateEntryRef: z.string().max(120).nullish(),
  vehicleNo: z.string().max(40).nullish(),
  driverName: z.string().max(120).nullish(),
  driverPhoneLast4: z
    .string()
    .regex(/^\d{4}$/, 'last 4 digits')
    .nullish(),
  transporter: z.string().max(160).nullish(),
  ewayBillNo: z.string().max(40).nullish(),
  ewayBillValidUntil: z.string().datetime().nullish(),
  unloadingLocation: z.string().max(120).nullish(),
  packingCondition: z.enum(GRN_PACKING_CONDITION).default('OK'),
  weighbridgeSlipNo: z.string().max(60).nullish(),
  grossWeightKg: decimalString.nullish(),
  tareWeightKg: decimalString.nullish(),
  deliveryNoteRef: z.string().max(120).nullish(),
  returnFreightBorneBy: z.enum(['VENDOR', 'BUYER']).default('VENDOR'),
  lines: z.array(GrnLineReceiptInputSchema).min(1),
  /** When true, advance past DRAFT immediately (→ PENDING_QC or auto-post). */
  submit: z.boolean().default(false),
});
export type GrnCreateInput = z.infer<typeof GrnCreateInputSchema>;

export const GrnUpdateInputSchema = GrnCreateInputSchema.partial().omit({ poId: true });
export type GrnUpdateInput = z.infer<typeof GrnUpdateInputSchema>;

export const GrnQcSampleInputSchema = z.object({
  grnLineId: z.string().min(1),
  sampleType: z.enum(QC_SAMPLE_TYPE).default('AQL'),
  sampleSize: z.number().int().min(1),
  samplePlanRef: z.string().max(120).nullish(),
  parametersMeasured: z.record(z.union([z.number(), z.boolean()])),
  certificateOfAnalysisS3: z.string().max(300).nullish(),
  defectsFound: z.array(z.string().max(200)).default([]),
});
export type GrnQcSampleInput = z.infer<typeof GrnQcSampleInputSchema>;

export const GrnCompleteQcLineSchema = z.object({
  grnLineId: z.string().min(1),
  qtyAccepted: decimalString,
  qtyRejected: decimalString,
  rejectionReason: z.enum(REJECTION_REASON).nullish(),
});
export const GrnCompleteQcInputSchema = z.object({
  lines: z.array(GrnCompleteQcLineSchema).min(1),
});
export type GrnCompleteQcInput = z.infer<typeof GrnCompleteQcInputSchema>;

export const GrnReverseInputSchema = z.object({
  reason: z.string().min(1).max(500),
});
export type GrnReverseInput = z.infer<typeof GrnReverseInputSchema>;

export const GrnHoldInputSchema = z.object({
  reason: z.string().min(1).max(500),
});
export type GrnHoldInput = z.infer<typeof GrnHoldInputSchema>;

export const GrnAttachmentInputSchema = z.object({
  s3Key: z.string().min(1).max(300),
  docType: z.enum(GRN_ATTACHMENT_TYPE),
});
export type GrnAttachmentInput = z.infer<typeof GrnAttachmentInputSchema>;

export const GrnListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().nullish(),
  poId: z.string().nullish(),
  vendorId: z.string().nullish(),
  status: z.string().nullish(),
  qcStatus: z.string().nullish(),
  receiptType: z.enum(GRN_RECEIPT_TYPE).nullish(),
  hasRejections: z.coerce.boolean().nullish(),
  tab: z
    .enum(['pending_receipt', 'awaiting_qc', 'posted_today', 'held', 'all'])
    .default('all'),
});
export type GrnListQuery = z.infer<typeof GrnListQuerySchema>;

// ── Read models ────────────────────────────────────────────────────────────

export interface GrnLineView {
  id: string;
  poLineId: string;
  itemDesc: string;
  uom: string;
  uomReceived: string | null;
  uomConversionFactor: string;
  qtyOrdered: string;
  qtyReceived: string;
  qtyAccepted: string;
  qtyRejected: string;
  qtyShort: string;
  rejectionReason: string | null;
  batchNumber: string | null;
  lotNumber: string | null;
  serialNumbers: string[];
  manufacturingDate: string | null;
  expiryDate: string | null;
  storageLocation: string | null;
  binCode: string | null;
  unitLandedCost: string;
  lineValue: string;
  varianceFlags: string[];
  requiresQc: boolean;
  requiresCoa: boolean;
  qcParameters: Record<
    string,
    { kind: string; min?: number; max?: number; unit?: string }
  >;
  samplePlan: {
    codeLetter: string;
    sampleSize: number;
    acceptNumber: number;
    rejectNumber: number;
    aqlLevel: string;
  } | null;
  qcSamples: GrnQcSampleView[];
  stockBefore: string | null;
  stockAfter: string | null;
}

export interface GrnQcSampleView {
  id: string;
  sampleType: string;
  sampleSize: number;
  samplePlanRef: string | null;
  inspectedBy: string;
  inspectedAt: string;
  result: string;
  defectsFound: string[];
  defectSeverity: string;
  parameters: {
    parameter: string;
    measured: number | boolean | null;
    result: string;
    message: string;
  }[];
}

export interface GrnAttachmentView {
  id: string;
  docType: string;
  s3Key: string;
  uploadedAt: string;
  uploadedBy: string;
}

export interface GrnListItem {
  id: string;
  number: string;
  po: { id: string; number: string };
  vendor: { id: string; name: string; isMsme: boolean };
  receiptType: string;
  status: string;
  qcStatus: string;
  receivedAt: string;
  lineCount: number;
  acceptedPct: number;
  totalValue: string;
  currency: string;
  hasRejections: boolean;
}

export interface GrnListResponse {
  items: GrnListItem[];
  nextCursor: string | null;
  totalEstimate: number;
  counts: {
    pending_receipt: number;
    awaiting_qc: number;
    posted_today: number;
    held: number;
    all: number;
  };
}

export interface GrnDetailResponse {
  id: string;
  number: string;
  status: string;
  qcStatus: string;
  receiptType: string;
  po: { id: string; number: string; fulfilmentPct: number };
  vendor: {
    id: string;
    name: string;
    code: string;
    gstin: string | null;
    isMsme: boolean;
  };
  gate: {
    gateEntryRef: string | null;
    vehicleNo: string | null;
    driverName: string | null;
    driverPhoneLast4: string | null;
    transporter: string | null;
    ewayBillNo: string | null;
    ewayBillValidUntil: string | null;
    unloadingLocation: string | null;
    packingCondition: string;
    weighbridgeSlipNo: string | null;
    grossWeightKg: string | null;
    tareWeightKg: string | null;
    netWeightKg: string | null;
  };
  receivedBy: string;
  receivedAt: string;
  postedAt: string | null;
  varianceFlags: string[];
  requiresPlantHeadSignoff: boolean;
  stages: { key: string; label: string; state: 'done' | 'active' | 'todo' }[];
  lines: GrnLineView[];
  attachments: GrnAttachmentView[];
  rma: { id: string; number: string; status: string } | null;
  invoiceLinks: { id: string; number: string; status: string }[];
  activity: { id: string; action: string; actorId: string | null; at: string }[];
  totals: { value: string; currency: string };
  canEdit: boolean;
  canStartQc: boolean;
  canCompleteQc: boolean;
  canPost: boolean;
  canReverse: boolean;
  canHold: boolean;
}

// ── Vendor-portal read model ─────────────────────────────────────────────────

export interface VendorGrnListItem {
  id: string;
  number: string;
  poNumber: string;
  receivedAt: string;
  status: string;
  qcStatus: string;
  lineCount: number;
  acceptedPct: number;
}

export interface VendorGrnListResponse {
  items: VendorGrnListItem[];
  nextCursor: string | null;
  totalEstimate: number;
}
