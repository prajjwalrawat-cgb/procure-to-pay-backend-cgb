import { inflateSync } from 'node:zlib';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isGstinChecksumValid, type VendorDocumentType } from '@procureflow/shared';

import type { Env } from '../../config/env';
import { IntegrationUsageService } from '../../integrations/integration-usage.service';

/** DI token for the active KYC document-extraction provider (real vs sandbox). */
export const KYC_EXTRACTION_PROVIDER = Symbol('KYC_EXTRACTION_PROVIDER');

/**
 * Everything we try to read off a GST certificate / PAN card, before any
 * verification. Every field is nullable: a document we could not read is a
 * normal outcome that routes the vendor to manual entry, not an error.
 */
export interface KycRawExtraction {
  gstin: string | null;
  pan: string | null;
  /** Cancelled cheques / bank letters only. */
  ifsc: string | null;
  accountNumber: string | null;
  legalName: string | null;
  tradeName: string | null;
  /** GSTN's "constitution of business" wording, when the document carries it. */
  constitution: string | null;
  addressLine1: string | null;
  city: string | null;
  pincode: string | null;
  /** 0..1 over the fields this document type was expected to yield. */
  confidence: number;
  /** Which engine produced this — carried into the audit trail. */
  provider: string;
}

export interface KycExtractionInput {
  docType: VendorDocumentType;
  s3Key: string;
  /** The bytes as uploaded. The sandbox parser works on these directly. */
  buffer: Buffer;
  mimeType: string;
}

export interface IKycExtractionProvider {
  /** Never throws — a provider failure yields a zero-confidence extraction so
   *  onboarding continues down the manual path (ADR-032/035). */
  extract(input: KycExtractionInput): Promise<KycRawExtraction>;
}

function emptyExtraction(provider: string): KycRawExtraction {
  return {
    gstin: null,
    pan: null,
    ifsc: null,
    accountNumber: null,
    legalName: null,
    tradeName: null,
    constitution: null,
    addressLine1: null,
    city: null,
    pincode: null,
    confidence: 0,
    provider,
  };
}

const GSTIN_PATTERN = /[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}/g;
const PAN_PATTERN = /[A-Z]{5}[0-9]{4}[A-Z]/g;
const PINCODE_PATTERN = /\b[1-9][0-9]{5}\b/;
const IFSC_PATTERN = /\b[A-Z]{4}0[A-Z0-9]{6}\b/;
/** Account numbers run 9–18 digits in India: shorter is a branch or cheque
 *  number, longer is two fields the OCR ran together. */
const ACCOUNT_LABELLED =
  /(?:A\/?C(?:\s*NO\.?)?|ACCOUNT(?:\s*(?:NO\.?|NUMBER))?)\s*[:.-]?\s*([0-9][0-9\s-]{7,24}[0-9])/i;
const ACCOUNT_RUN = /\b[0-9]{9,18}\b/g;

/**
 * Text out of a PDF's content streams.
 *
 * GST registration certificates (REG-06) and most bank letters are *generated*
 * PDFs with a real text layer, so the characters are already in the file and no
 * OCR engine is needed to reach them — which is what makes the common case work
 * with zero extra infrastructure. Scans and photographs have no text layer; they
 * come back empty here and fall through to the OCR sidecar, or to manual entry.
 *
 * Deliberately small: it decompresses Flate streams and takes the operands of
 * the text-showing operators. It does not implement font encodings, so an exotic
 * encoding yields noise — which the field patterns below then reject, rather
 * than turning into a confident wrong answer.
 */
export function pdfTextLayer(buffer: Buffer): string {
  const chunks: string[] = [];
  const raw = buffer.toString('latin1');
  const streamRe = /stream\r?\n?([\s\S]*?)endstream/g;
  let match: RegExpExecArray | null;
  while ((match = streamRe.exec(raw)) !== null) {
    const body = Buffer.from(match[1] ?? '', 'latin1');
    let text: string;
    try {
      text = inflateSync(body).toString('latin1');
    } catch {
      // Not a Flate stream (or it is an image); the raw bytes may still be text.
      text = body.toString('latin1');
    }
    // ( … ) Tj   and   [ ( … ) … ] TJ
    const showRe = /\(((?:\\.|[^\\)])*)\)\s*(?:Tj|TJ|')/g;
    let show: RegExpExecArray | null;
    while ((show = showRe.exec(text)) !== null) {
      chunks.push(
        (show[1] ?? '')
          .replace(/\\[nrt]/g, ' ')
          .replace(/\\([()\\])/g, '$1')
          .replace(/\\[0-7]{1,3}/g, ' '),
      );
    }
  }
  return chunks.join(' ');
}

/** Plain text out of whatever we were handed, or '' when there is none to have. */
export function documentText(buffer: Buffer, mimeType: string): string {
  if (mimeType === 'application/pdf' || buffer.subarray(0, 4).toString() === '%PDF') {
    return pdfTextLayer(buffer);
  }
  if (mimeType.startsWith('text/')) return buffer.toString('utf8');
  // Images carry no text layer. The OCR sidecar handles those.
  return '';
}

/**
 * Labels that end a value.
 *
 * A certificate lays its fields out in a table, and a table read out of a PDF's
 * text layer arrives as one long run of "<label> <value> <label> <value>" with
 * no dependable line breaks. So the only way to know where the legal name stops
 * is to know what is allowed to follow it.
 */
const FIELD_LABELS = [
  'Legal Name',
  'Trade Name',
  'Additional trade names',
  'Constitution',
  'Address',
  'Principal Place',
  'Registration Number',
  'Date of',
  'Type of Registration',
  'Particulars',
  'Pincode',
  'PIN Code',
  'GSTIN',
  'Permanent Account Number',
  'Father',
  'Signature',
  'Designation',
  'Jurisdictional',
  'Period of Validity',
  // The sub-labels REG-06 breaks the address into. Without these, "Address of
  // Principal Place of Business" swallows the city, district, state and pincode
  // as one 200-character run.
  'Floor No',
  'Building No',
  'Name Of Premises',
  'Road/Street',
  'Locality',
  'City/Town',
  'District',
  'State:',
];

/** The address sub-fields, in the order REG-06 prints them. */
const ADDRESS_PARTS = [
  'Floor No.',
  'Building No./Flat No.',
  'Name Of Premises/Building',
  'Road/Street',
  'Locality/Sub Locality',
];

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Trim a captured value where the next field's label begins. */
function cutAtNextLabel(value: string, matchedLabel: string): string {
  let end = value.length;
  for (const label of FIELD_LABELS) {
    // The label just matched can legitimately reappear inside its own value
    // ("Legal Name" within "Legal Name of Business"); it never ends it.
    if (matchedLabel.toLowerCase().includes(label.toLowerCase())) continue;
    const at = value.toLowerCase().indexOf(label.toLowerCase());
    if (at > 0 && at < end) end = at;
  }
  return value.slice(0, end);
}

/** The value printed against a label, stopping where the next field starts. */
function labelled(text: string, labels: string[]): string | null {
  for (const label of labels) {
    const re = new RegExp(`${escapeRe(label)}\\s*[:\\-]?\\s*([^\\n]{2,200})`, 'i');
    const captured = re.exec(text)?.[1];
    if (!captured) continue;
    const value = cutAtNextLabel(captured, label).trim();
    if (value.length >= 2 && !/^[:\-\s]*$/.test(value)) return cleanupValue(value);
  }
  return null;
}

function cleanupValue(value: string): string {
  return (
    value
      .replace(/\s{2,}/g, ' ')
      .replace(/^[^A-Za-z0-9]+/, '')
      .replace(/[|_]+$/, '')
      // REG-06 numbers every row, so a value cut at the next label keeps that
      // row's number: "ARJUN YADAV 2." for a legal name followed by "2. Trade
      // Name". The number belongs to the form, not to the vendor.
      .replace(/\s+\d{1,2}\.?$/, '')
      .trim()
      .slice(0, 200)
  );
}

/**
 * The field patterns, applied to whatever text we obtained. Shared by both
 * providers so a certificate parsed locally and one parsed by the OCR sidecar
 * are read identically — only the source of the *text* differs.
 */
export function parseKycText(
  text: string,
  docType: VendorDocumentType,
): KycRawExtraction {
  const flat = text.replace(/\r/g, '\n');
  const upper = flat.toUpperCase();

  // Prefer a GSTIN whose own check digit agrees. On a certificate that also
  // quotes the issuing office's GSTIN, that is what picks out the right one.
  const gstins = upper.match(GSTIN_PATTERN) ?? [];
  const gstin = gstins.find((g) => isGstinChecksumValid(g)) ?? gstins[0] ?? null;

  // A PAN quoted anywhere on the page. The PAN embedded in the GSTIN is derived
  // separately, and that is the one that wins when the two disagree.
  const pan = (upper.match(PAN_PATTERN) ?? [])[0] ?? null;

  const legalName = labelled(flat, [
    'Legal Name of Business',
    'Legal Name',
    'Name of Business',
    'Name',
  ]);
  const tradeName = labelled(flat, ['Trade Name, if any', 'Trade Name']);
  const constitution = labelled(flat, [
    'Constitution of Business',
    'Constitution',
    'Type of Registration',
  ]);
  // REG-06 prints the address as five labelled sub-fields. Reassembling them —
  // rather than grabbing everything after "Address of Principal Place of
  // Business" — is what keeps the city, district, state and pincode out of the
  // street address, and puts the city in the field that asks for it.
  const parts = ADDRESS_PARTS.map((label) => labelled(flat, [label])).filter(
    (v): v is string => !!v,
  );
  const addressLine1 =
    parts.length > 0
      ? parts.join(', ').slice(0, 200)
      : labelled(flat, [
          'Address of Principal Place of Business',
          'Principal Place of Business',
          'Registered Address',
          'Address',
        ]);
  const city = labelled(flat, ['City/Town/Village', 'City/Town', 'City']);
  const pincode =
    labelled(flat, ['PIN Code', 'Pincode'])?.match(/[1-9][0-9]{5}/)?.[0] ??
    PINCODE_PATTERN.exec(flat)?.[0] ??
    null;
  const ifsc = IFSC_PATTERN.exec(upper)?.[0] ?? null;
  const accountNumber = findAccountNumber(upper);

  // Confidence is the share of the fields this document type is supposed to
  // carry that were actually found — not a model score, and honest about it.
  const expected =
    docType === 'PAN_CARD' ? [pan, legalName] : [gstin, legalName, addressLine1, pincode];
  const found = expected.filter(Boolean).length;

  return {
    gstin,
    pan,
    ifsc,
    accountNumber,
    legalName,
    tradeName,
    constitution,
    addressLine1,
    city,
    pincode,
    confidence: expected.length === 0 ? 0 : found / expected.length,
    provider: 'LOCAL_TEXT_LAYER',
  };
}

/**
 * The account number off a cheque.
 *
 * A cheque carries several long digit runs: the cheque number, the 9-digit MICR
 * code along the bottom, and the account number. Preference order reflects how
 * reliably each is identifiable — a run sitting behind an "A/c No" label is the
 * account number; failing that, the longest run, because the MICR line is
 * exactly 9 digits and account numbers are usually longer. It is offered as an
 * unverified suggestion either way, never as a confirmed value.
 */
function findAccountNumber(text: string): string | null {
  const labelled = ACCOUNT_LABELLED.exec(text)?.[1];
  if (labelled) {
    const digits = labelled.replace(/[^0-9]/g, '');
    if (digits.length >= 9 && digits.length <= 18) return digits;
  }
  const runs = text.match(ACCOUNT_RUN) ?? [];
  const longest = runs
    .filter((r) => r.length !== 9 || runs.every((o) => o.length === 9))
    .sort((a, b) => b.length - a.length)[0];
  return longest ?? null;
}

/**
 * SandboxKycExtractionProvider — the default path. Reads the PDF's own text
 * layer and applies the field patterns above: no third-party dependency, no
 * credentials, and it genuinely works on portal-issued GST certificates.
 * Scans and photos yield nothing and route the vendor to manual entry, which is
 * the documented fallback rather than a failure.
 */
@Injectable()
export class SandboxKycExtractionProvider implements IKycExtractionProvider {
  private readonly logger = new Logger(SandboxKycExtractionProvider.name);

  constructor(private readonly usage: IntegrationUsageService) {}

  async extract(input: KycExtractionInput): Promise<KycRawExtraction> {
    const started = Date.now();
    try {
      const result = parseKycText(
        documentText(input.buffer, input.mimeType),
        input.docType,
      );
      await this.usage.log({
        provider: 'OCR',
        operation: `kyc.extract.${input.docType.toLowerCase()}`,
        costMicros: 0,
        simulated: true,
        latencyMs: Date.now() - started,
      });
      return result;
    } catch (err) {
      this.logger.warn(`KYC text extraction failed for ${input.s3Key}: ${String(err)}`);
      return emptyExtraction('LOCAL_TEXT_LAYER');
    }
  }
}

/** Response shape of the OCR sidecar's `/extract-kyc` endpoint. */
interface KycApiResponse {
  gstin?: string | null;
  pan?: string | null;
  ifsc?: string | null;
  account_number?: string | null;
  legal_name?: string | null;
  trade_name?: string | null;
  constitution?: string | null;
  address?: string | null;
  city?: string | null;
  pincode?: string | null;
  confidence?: number | null;
  provider?: string | null;
}

/** Minimal shape of the `fetch` Response we consume — see RealOcrProvider for
 *  why this is spelled out rather than relying on the ambient DOM types. */
interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/**
 * Fallback ceiling, used when KYC_REQUEST_TIMEOUT_MS is unset. A scanned
 * certificate can be a large image; generous, but bounded, so a hung sidecar
 * cannot hold the vendor's upload request open indefinitely.
 *
 * Shorter than the invoice path on purpose. This runs inside the vendor's
 * upload request rather than a worker, so the ceiling is what a person will
 * sit through. The trade-off is real: with a slow self-hosted engine the call
 * times out and the local text-layer parser answers instead — degraded, but
 * immediate, and logged as an ERROR against the integration so the
 * degradation is visible rather than assumed.
 */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * RealKycExtractionProvider (mirrors RealOcrProvider, Slice 10a). Posts a
 * presigned URL to the OCR sidecar's `/extract-kyc`, which runs the configured
 * document-AI engine — that is the path that reads *scanned* certificates.
 *
 * On any failure it falls back to the local text-layer parser rather than
 * returning nothing: a sidecar that is down must not silently degrade a vendor
 * holding a perfectly readable digital certificate to full manual entry.
 */
@Injectable()
export class RealKycExtractionProvider implements IKycExtractionProvider {
  private readonly logger = new Logger(RealKycExtractionProvider.name);

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly usage: IntegrationUsageService,
    private readonly fallback: SandboxKycExtractionProvider,
    /** Injected rather than taking StorageService, so this stays a thin adapter. */
    private readonly presign: (s3Key: string) => Promise<string>,
  ) {}

  async extract(input: KycExtractionInput): Promise<KycRawExtraction> {
    const baseUrl = this.config.get('OCR_API_URL', { infer: true });
    const started = Date.now();
    try {
      const url = await this.presign(input.s3Key);
      const res = (await fetch(`${baseUrl}/extract-kyc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document_url: url, doc_type: input.docType }),
        signal: AbortSignal.timeout(
          this.config.get('KYC_REQUEST_TIMEOUT_MS', { infer: true }) ||
            DEFAULT_TIMEOUT_MS,
        ),
      })) as FetchResponse;
      if (!res.ok) throw new Error(`extract-kyc responded ${res.status}`);
      const body = (await res.json()) as KycApiResponse;
      await this.usage.log({
        provider: 'OCR',
        operation: `kyc.extract.${input.docType.toLowerCase()}`,
        costMicros: 1_000_000,
        latencyMs: Date.now() - started,
      });
      const parsed: KycRawExtraction = {
        gstin: body.gstin?.toUpperCase() ?? null,
        pan: body.pan?.toUpperCase() ?? null,
        ifsc: body.ifsc?.toUpperCase() ?? null,
        accountNumber: body.account_number ?? null,
        legalName: body.legal_name ?? null,
        tradeName: body.trade_name ?? null,
        constitution: body.constitution ?? null,
        addressLine1: body.address ?? null,
        city: body.city ?? null,
        pincode: body.pincode ?? null,
        confidence: Math.max(0, Math.min(1, body.confidence ?? 0)),
        provider: body.provider ?? 'OCR_API',
      };
      // The sidecar answered but found nothing (common when it runs without an
      // engine configured): the local text-layer parser may still do better.
      return parsed.confidence === 0 ? this.fallback.extract(input) : parsed;
    } catch (err) {
      this.logger.warn(
        `extract-kyc unavailable (${String(err)}) — falling back to the local text layer.`,
      );
      await this.usage.log({
        provider: 'OCR',
        operation: `kyc.extract.${input.docType.toLowerCase()}`,
        costMicros: 0,
        outcome: 'ERROR',
        latencyMs: Date.now() - started,
      });
      return this.fallback.extract(input);
    }
  }
}
