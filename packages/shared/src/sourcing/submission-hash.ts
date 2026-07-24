/**
 * Sealed-quote submission hash (Slice 6, ADR-017). On submit, the server
 * computes a deterministic hash over the full quote payload + attachment
 * manifest. Stored server-side; the vendor gets it back as proof-of-submission.
 * The buyer cannot see quote content until the formal open ceremony — the hash
 * is what makes tampering between submit and open detectable.
 *
 * Deterministic: keys are sorted so the same logical quote always hashes the
 * same, independent of property order.
 */

import { sha256Hex } from '../bank-formats/sha256';

export interface QuoteSealLineInput {
  rfqLineId: string;
  qtyQuoted: string;
  unitPriceNative: string;
  discountPct: string;
  taxRate: string;
  lineTotalNative: string;
  deliveryLeadDays: number;
  specCompliance: string;
  deviationNotes?: string | null;
}

export interface QuoteSealInput {
  rfqId: string;
  invitationId: string;
  vendorId: string;
  quoteNo: string;
  envelopeType: string;
  currency: string;
  incoterm: string;
  validityDays: number;
  paymentTermsOffered: string;
  revisionNo: number;
  lines: QuoteSealLineInput[];
  /** [{ fileHash }] of every attachment, order-independent. */
  attachmentHashes: string[];
}

function canonical(input: QuoteSealInput): string {
  const lines = [...input.lines]
    .map((l) => ({
      rfqLineId: l.rfqLineId,
      qtyQuoted: l.qtyQuoted,
      unitPriceNative: l.unitPriceNative,
      discountPct: l.discountPct,
      taxRate: l.taxRate,
      lineTotalNative: l.lineTotalNative,
      deliveryLeadDays: l.deliveryLeadDays,
      specCompliance: l.specCompliance,
      deviationNotes: l.deviationNotes ?? '',
    }))
    .sort((a, b) => a.rfqLineId.localeCompare(b.rfqLineId));
  const attachments = [...input.attachmentHashes].sort();
  return JSON.stringify({
    rfqId: input.rfqId,
    invitationId: input.invitationId,
    vendorId: input.vendorId,
    quoteNo: input.quoteNo,
    envelopeType: input.envelopeType,
    currency: input.currency,
    incoterm: input.incoterm,
    validityDays: input.validityDays,
    paymentTermsOffered: input.paymentTermsOffered,
    revisionNo: input.revisionNo,
    lines,
    attachments,
  });
}

/** Full 64-char sealing hash. */
export function computeSubmissionHash(input: QuoteSealInput): string {
  return sha256Hex(canonical(input));
}

/** Short proof-of-submission form shown to the vendor, e.g. "8f3a…c2e1". */
export function shortHash(hash: string): string {
  if (hash.length <= 8) return hash;
  return `${hash.slice(0, 4)}…${hash.slice(-4)}`;
}

/** Deterministic per-invitation watermark seed for leak-tracked PDF exports. */
export function watermarkSeed(rfqId: string, invitationId: string): string {
  return sha256Hex(`${rfqId}:${invitationId}`).slice(0, 16);
}
