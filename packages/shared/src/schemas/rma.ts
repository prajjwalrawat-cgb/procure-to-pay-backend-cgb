import { z } from 'zod';

import { RMA_REASON_CODE } from '../constants/status';

const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'must be a decimal string');

// ── Inputs ─────────────────────────────────────────────────────────────────

export const RmaUpdateInputSchema = z.object({
  reasonCode: z.enum(RMA_REASON_CODE).nullish(),
  reasonNotes: z.string().max(2000).nullish(),
  returnFreightBorneBy: z.enum(['VENDOR', 'BUYER']).nullish(),
});
export type RmaUpdateInput = z.infer<typeof RmaUpdateInputSchema>;

export const RmaPickupInputSchema = z.object({
  vehicleOutNo: z.string().min(1).max(40),
  gatePassOutNo: z.string().min(1).max(60),
});
export type RmaPickupInput = z.infer<typeof RmaPickupInputSchema>;

export const RmaCreditNoteInputSchema = z.object({
  creditNoteRef: z.string().min(1).max(80),
  creditNoteAmount: decimalString,
  s3Key: z.string().max(300).nullish(),
});
export type RmaCreditNoteInput = z.infer<typeof RmaCreditNoteInputSchema>;

export const RmaSchedulePickupInputSchema = z.object({
  pickupAt: z.string().datetime(),
});
export type RmaSchedulePickupInput = z.infer<typeof RmaSchedulePickupInputSchema>;

export const RmaListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().nullish(),
  status: z.string().nullish(),
  vendorId: z.string().nullish(),
  tab: z
    .enum(['draft', 'issued', 'awaiting_pickup', 'awaiting_credit_note', 'closed', 'all'])
    .default('all'),
});
export type RmaListQuery = z.infer<typeof RmaListQuerySchema>;

// ── Read models ────────────────────────────────────────────────────────────

export interface RmaLineView {
  id: string;
  grnLineId: string;
  itemDesc: string;
  uom: string;
  qtyReturned: string;
  unitPrice: string;
  lineTotal: string;
  returnReasonDetail: string | null;
}

export interface RmaListItem {
  id: string;
  number: string;
  vendor: { id: string; name: string };
  grn: { id: string; number: string };
  reasonCode: string;
  status: string;
  totalReturnValue: string;
  currency: string;
  createdAt: string;
}

export interface RmaListResponse {
  items: RmaListItem[];
  nextCursor: string | null;
  totalEstimate: number;
  counts: {
    draft: number;
    issued: number;
    awaiting_pickup: number;
    awaiting_credit_note: number;
    closed: number;
    all: number;
  };
}

export interface RmaDetailResponse {
  id: string;
  number: string;
  status: string;
  reasonCode: string;
  reasonNotes: string | null;
  returnFreightBorneBy: string;
  vendor: { id: string; name: string; code: string; gstin: string | null };
  grn: { id: string; number: string };
  po: { id: string; number: string };
  lines: RmaLineView[];
  totalReturnValue: string;
  currency: string;
  issuedAt: string | null;
  pickupScheduledAt: string | null;
  pickedUpAt: string | null;
  vehicleOutNo: string | null;
  gatePassOutNo: string | null;
  creditNoteRef: string | null;
  creditNoteAmount: string | null;
  pdfAvailable: boolean;
  activity: { id: string; action: string; actorId: string | null; at: string }[];
  canEdit: boolean;
  canIssue: boolean;
  canRecordPickup: boolean;
  canRecordCreditNote: boolean;
  canClose: boolean;
}

// ── Vendor-portal read model ─────────────────────────────────────────────────

export interface VendorRmaListItem {
  id: string;
  number: string;
  status: string;
  reasonCode: string;
  totalReturnValue: string;
  currency: string;
  issuedAt: string | null;
  pickupScheduledAt: string | null;
  pdfAvailable: boolean;
}

export interface VendorRmaListResponse {
  items: VendorRmaListItem[];
  nextCursor: string | null;
  totalEstimate: number;
}
