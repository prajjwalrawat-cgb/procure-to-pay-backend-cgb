/**
 * Provenance of an auto-filled onboarding field.
 *
 * The rule the wizard is built on: OCR text alone is never proof. A value is
 * only "trusted" (green, locked) once an authority outside the uploaded image
 * agrees with it — the GSTN/PAN registry, or a derivation from a value that
 * itself carries a checksum. Everything else is offered to the vendor as a
 * suggestion they must eyeball (amber, editable), and anything we could not read
 * at all is left blank for them to type (no badge) — the old manual flow, kept
 * as the fallback path rather than the default one.
 */

import type { VendorDocumentType } from '../constants/vendor-status';

export const VENDOR_FIELD_SOURCE = [
  /** Registry lookup against the GSTIN — legal name, constitution, address. */
  'GSTN_API',
  /** PAN validation service — holder name and PAN type. */
  'PAN_API',
  /** IFSC directory — the bank (and branch, where the directory has it). */
  'IFSC_API',
  /** Computed from a checksum-carrying value (PAN and state code out of a GSTIN). */
  'DERIVED',
  /** Read off the document only. Plausible, unproven. */
  'OCR',
  /** Typed by the vendor. */
  'MANUAL',
] as const;
export type VendorFieldSource = (typeof VENDOR_FIELD_SOURCE)[number];

/** Sources whose value is corroborated outside the uploaded document. */
export const VERIFIED_FIELD_SOURCES: VendorFieldSource[] = [
  'GSTN_API',
  'PAN_API',
  'IFSC_API',
  'DERIVED',
];

export function isVerifiedSource(source: VendorFieldSource | null | undefined): boolean {
  return !!source && VERIFIED_FIELD_SOURCES.includes(source);
}

/** What the vendor is told about where a value came from. */
export function fieldSourceLabel(source: VendorFieldSource): string {
  switch (source) {
    case 'GSTN_API':
      return 'Verified via GSTN';
    case 'PAN_API':
      return 'Verified via PAN registry';
    case 'IFSC_API':
      return 'Resolved from your IFSC';
    case 'DERIVED':
      return 'Derived from your GSTIN';
    case 'OCR':
      return 'From document, unverified';
    case 'MANUAL':
      return 'Entered by you';
  }
}

/** One auto-filled value plus everything needed to judge and audit it. */
export interface ExtractedField {
  value: string;
  source: VendorFieldSource;
  /** True only for sources corroborated outside the document (see above). */
  verified: boolean;
  /** 0..1. Below LOW_CONFIDENCE_THRESHOLD the value is dropped, not shown. */
  confidence: number;
}

/** Below this, an OCR read is treated as a failed read rather than a suggestion. */
export const LOW_CONFIDENCE_THRESHOLD = 0.55;

/** The wizard-field name → its extracted value, for the fields we can auto-fill. */
export type ExtractedFieldMap = Record<string, ExtractedField>;

/**
 * The wizard fields a GST certificate is the source for. When a certificate for
 * a different registration arrives, these are what it replaces wholesale — every
 * one of them described the earlier entity.
 */
export const GST_IDENTITY_FIELDS = [
  'gstin',
  'businessPan',
  'stateCode',
  'legalEntityName',
  'legalEntityType',
  'tradeName',
  'addressLine1',
  'city',
  'pincode',
] as const;

export interface DocumentExtractionResult {
  docType: VendorDocumentType;
  fields: ExtractedFieldMap;
  /** Blocking problems — e.g. the PAN card and GST certificate disagree. */
  errors: string[];
  /** Non-blocking; shown to the vendor and carried into the buyer's review. */
  warnings: string[];
  /** True when nothing usable came back and the vendor must type the fields. */
  manualFallback: boolean;
  /**
   * Whether the file proved to be the document it was filed as: a GST
   * certificate whose GSTIN the registry confirmed, a PAN card whose PAN checks
   * out against it, a cheque whose IFSC the directory knows. This — and only
   * this — is what may mark a document auto-verified. A file that merely
   * uploaded successfully has been checked by nobody.
   */
  confirmsDocument: boolean;
  /**
   * Set on a GST certificate whose GSTIN or PAN differs from what is on file.
   * The certificate is the source of the vendor's identity, so it replaces the
   * earlier one — values, saved steps, earlier documents — instead of being
   * refused for disagreeing with it.
   */
  supersedesIdentity?: boolean;
}

/**
 * Document names as a vendor would say them. `GST_CERT` is a database value;
 * "GST registration certificate" is what is printed on the thing they are being
 * asked to find, and the two should not be confused in a message aimed at them.
 */
const DOCUMENT_LABELS: Partial<Record<VendorDocumentType, string>> = {
  GST_CERT: 'GST registration certificate',
  PAN_CARD: 'PAN card',
  CANCELLED_CHEQUE: 'cancelled cheque',
  AUDITED_FINANCIALS: 'audited financials',
  MSME_UDYAM: 'Udyam (MSME) certificate',
  INCORPORATION_CERT: 'certificate of incorporation',
  AUTHORIZED_SIGNATORY_LETTER: 'authorised signatory letter',
  ADDRESS_PROOF: 'address proof',
  FACTORY_LICENSE: 'factory licence',
  POLLUTION_NOC: 'pollution control NOC',
  INSURANCE_POLICY: 'insurance policy',
  CREDIT_REPORT: 'credit report',
  CODE_OF_CONDUCT: 'signed code of conduct',
  CATALOGUE: 'product catalogue',
  RC_BOOK: 'vehicle RC book',
  DRIVING_LICENSE: 'driving licence',
  SDS: 'safety data sheet',
  REACH_DECL: 'REACH declaration',
};

export function vendorDocumentLabel(docType: VendorDocumentType | string): string {
  return (
    DOCUMENT_LABELS[docType as VendorDocumentType] ??
    // ISO_9001, BIS_CERT, FSSAI… — already read as names once the underscores go.
    String(docType).replace(/_/g, ' ')
  );
}
