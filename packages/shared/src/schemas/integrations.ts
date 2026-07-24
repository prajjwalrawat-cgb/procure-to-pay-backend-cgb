import { z } from 'zod';

import {
  GSTR2B_STATUS,
  INBOUND_EMAIL_STATUS,
  INTEGRATION_PROVIDER,
  IRN_VALIDATION_STATUS,
} from '../constants/status';

const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'must be a decimal string');

// ── Email intake (webhook contract — SendGrid/Mailgun Inbound Parse shape) ────

export const EmailAttachmentSchema = z.object({
  filename: z.string().min(1).max(300),
  mimeType: z.string().min(1).max(120),
  /** base64-encoded bytes (the provider posts multipart; we accept normalised JSON). */
  contentBase64: z.string().min(1),
});
export type EmailAttachment = z.infer<typeof EmailAttachmentSchema>;

export const EmailInboundPayloadSchema = z.object({
  from: z.string().email(),
  to: z.string().max(200).nullish(),
  subject: z.string().max(500).nullish(),
  text: z.string().max(100000).nullish(),
  providerMessageId: z.string().max(200).nullish(),
  attachments: z.array(EmailAttachmentSchema).default([]),
});
export type EmailInboundPayload = z.infer<typeof EmailInboundPayloadSchema>;

export const ResolveVendorMatchSchema = z.object({
  vendorId: z.string().min(1),
});
export type ResolveVendorMatch = z.infer<typeof ResolveVendorMatchSchema>;

// ── Manual review (low-confidence / OCR-failed data entry) ────────────────────

export const ManualEntryLineSchema = z.object({
  itemDesc: z.string().min(1).max(500),
  uom: z.string().min(1).max(20),
  qty: decimalString,
  unitPrice: decimalString,
  taxRate: decimalString.default('0'),
});
export type ManualEntryLine = z.infer<typeof ManualEntryLineSchema>;

export const CompleteManualEntrySchema = z.object({
  vendorInvoiceRef: z.string().max(120).nullish(),
  invoiceDate: z.string().datetime().nullish(),
  lines: z.array(ManualEntryLineSchema).min(1),
});
export type CompleteManualEntry = z.infer<typeof CompleteManualEntrySchema>;

// ── Integration credentials (write-only; ciphertext never returned) ───────────

export const SetCredentialSchema = z.object({
  provider: z.enum(INTEGRATION_PROVIDER),
  label: z.string().max(120).nullish(),
  /** Arbitrary secret material (api keys, gsp client id/secret) — encrypted at rest. */
  payload: z.record(z.string(), z.string()).refine((o) => Object.keys(o).length > 0, {
    message: 'payload must not be empty',
  }),
});
export type SetCredential = z.infer<typeof SetCredentialSchema>;

export const UsageQuerySchema = z.object({
  provider: z.enum(INTEGRATION_PROVIDER).nullish(),
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .nullish(),
});
export type UsageQuery = z.infer<typeof UsageQuerySchema>;

export const InboundEmailQuerySchema = z.object({
  status: z.enum(INBOUND_EMAIL_STATUS).nullish(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().nullish(),
});
export type InboundEmailQuery = z.infer<typeof InboundEmailQuerySchema>;

// ── Read models ───────────────────────────────────────────────────────────────

export interface InboundEmailItem {
  id: string;
  fromEmail: string;
  fromDomain: string;
  subject: string | null;
  status: (typeof INBOUND_EMAIL_STATUS)[number];
  matchedVendorId: string | null;
  invoiceId: string | null;
  attachmentName: string | null;
  deadLetterReason: string | null;
  createdAt: string;
}

export interface InboundEmailListResponse {
  items: InboundEmailItem[];
  nextCursor: string | null;
  counts: { pending_vendor_match: number; dead_letter: number };
}

export interface EmailIngestResult {
  inboundEmailId: string;
  status: (typeof INBOUND_EMAIL_STATUS)[number];
  invoiceId: string | null;
  reason: string | null;
}

export interface IntegrationUsageRow {
  provider: (typeof INTEGRATION_PROVIDER)[number];
  operation: string;
  calls: number;
  errors: number;
  simulatedCalls: number;
  /** total cost in INR (string, 4dp) */
  costInr: string;
}

export interface IntegrationUsageResponse {
  month: string;
  rows: IntegrationUsageRow[];
  totalInr: string;
}

export interface CredentialStatusItem {
  provider: (typeof INTEGRATION_PROVIDER)[number];
  label: string | null;
  isActive: boolean;
  configured: boolean;
  lastRotatedAt: string | null;
}

export interface Gstr2bReconResult {
  invoicesScanned: number;
  matched: number;
  mismatchAmount: number;
  mismatchDate: number;
  notFound: number;
  ranAt: string;
  simulated: boolean;
}

export interface IrnValidationResult {
  invoiceId: string;
  status: (typeof IRN_VALIDATION_STATUS)[number];
  required: boolean;
  irn: string | null;
  detail: string;
  simulated: boolean;
}

export type Gstr2bStatusValue = (typeof GSTR2B_STATUS)[number];
