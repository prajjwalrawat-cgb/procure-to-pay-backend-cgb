import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  LOW_CONFIDENCE_THRESHOLD,
  entityTypeFromConstitution,
  entityTypeFromPan,
  isGstinChecksumValid,
  isGstinFormatValid,
  isPanFormatValid,
  panFromGstin,
  panGstinMismatch,
  stateCodeFromGstin,
  type DocumentExtractionResult,
  type ExtractedField,
  type ExtractedFieldMap,
  type VendorDocumentType,
  type VendorFieldSource,
} from '@procureflow/shared';

import {
  IFSC_PROVIDER,
  isIfscFormatValid,
  type IIfscProvider,
} from './verification/ifsc.provider';
import {
  SCREENING_PROVIDER,
  type IScreeningProvider,
} from './verification/screening.provider';
import {
  KYC_EXTRACTION_PROVIDER,
  type IKycExtractionProvider,
  type KycExtractionInput,
  type KycRawExtraction,
} from './verification/kyc-extraction.provider';

/** What the vendor already has on file, so a second document can be checked
 *  against the first rather than silently overwriting it. */
export interface KycContext {
  gstin: string | null;
  pan: string | null;
}

function field(
  value: string,
  source: VendorFieldSource,
  verified: boolean,
  confidence: number,
): ExtractedField {
  return { value, source, verified, confidence };
}

/**
 * VendorKycService — turns an uploaded GST certificate / PAN card into
 * *attributed* form values.
 *
 * The rule this service exists to enforce: *OCR text alone is not proof*. Every
 * value it hands back carries where it came from and whether anything outside
 * the uploaded image agrees with it, and only the latter kind is allowed to lock
 * a field. Concretely, three tiers come out of here:
 *
 *  - **Verified** — the GSTIN confirmed by the registry lookup, and the PAN and
 *    state code *derived* from it. A GSTIN carries its own mod-36 check digit,
 *    so a PAN read out of characters 3–12 of a checksum-valid GSTIN is not a
 *    guess; it is arithmetic. This is what ends the retyped-PAN class of error.
 *  - **Unverified** — the legal name, address and pincode as printed. Plausible,
 *    unproven, editable, and badged as such. When the registry lookup returns
 *    its own copy of the name (a real KYC provider does; the sandbox does not),
 *    that copy is used instead and *is* verified.
 *  - **Nothing** — a scan we could not read. The vendor types it, exactly as
 *    before. The manual path stays whole; it just stops being the default.
 *
 * Anything genuinely contradictory (a PAN card that disagrees with the GST
 * certificate) is returned as an error for the caller to block on, never
 * silently reconciled.
 */
@Injectable()
export class VendorKycService {
  private readonly logger = new Logger(VendorKycService.name);

  constructor(
    @Inject(KYC_EXTRACTION_PROVIDER)
    private readonly extraction: IKycExtractionProvider,
    @Inject(SCREENING_PROVIDER)
    private readonly screening: IScreeningProvider,
    @Inject(IFSC_PROVIDER)
    private readonly ifsc: IIfscProvider,
  ) {}

  /** Document types that carry fields worth auto-filling. Everything else is
   *  stored and reviewed by a human, with no extraction attempted. */
  static isExtractable(docType: VendorDocumentType): boolean {
    return (
      docType === 'GST_CERT' || docType === 'PAN_CARD' || docType === 'CANCELLED_CHEQUE'
    );
  }

  async extractDocument(
    input: KycExtractionInput,
    context: KycContext,
  ): Promise<DocumentExtractionResult> {
    const raw = await this.extraction.extract(input);
    const result: DocumentExtractionResult = {
      docType: input.docType,
      fields: {},
      errors: [],
      warnings: [],
      manualFallback: false,
      confirmsDocument: false,
      supersedesIdentity: false,
    };

    if (input.docType === 'GST_CERT') {
      await this.fromGstCertificate(raw, context, result);
    } else if (input.docType === 'PAN_CARD') {
      await this.fromPanCard(raw, context, result);
    } else if (input.docType === 'CANCELLED_CHEQUE') {
      await this.fromCancelledCheque(raw, result);
    }

    result.manualFallback = Object.keys(result.fields).length === 0;
    // What the buyer's "auto verified" badge is allowed to rest on: a value
    // from this document that something outside it confirmed. Reading text off
    // a page proves only that the page had text on it.
    result.confirmsDocument =
      result.errors.length === 0 &&
      (input.docType === 'GST_CERT'
        ? result.fields.gstin?.verified === true
        : input.docType === 'PAN_CARD'
          ? result.fields.businessPan?.verified === true
          : input.docType === 'CANCELLED_CHEQUE'
            ? result.fields.ifsc?.verified === true
            : false);
    if (result.manualFallback && result.errors.length === 0) {
      result.warnings.push(
        'We could not read this document — it is stored, but please fill the ' +
          'fields in yourself. Scans and photos read best as a clear, straight PDF.',
      );
    }
    return result;
  }

  // ── GST certificate ────────────────────────────────────────────────────────

  private async fromGstCertificate(
    raw: KycRawExtraction,
    context: KycContext,
    out: DocumentExtractionResult,
  ): Promise<void> {
    const gstin = (raw.gstin ?? '').toUpperCase();
    if (!isGstinFormatValid(gstin)) {
      // Nothing usable: no GSTIN means none of the derivations below hold, and
      // a name lifted off an unidentified document is not worth pre-filling.
      return;
    }

    const checksumOk = isGstinChecksumValid(gstin);
    if (!checksumOk) {
      out.warnings.push(
        `The GSTIN read from this certificate (${gstin}) fails its own check digit — ` +
          'it was probably misread. Please confirm it character by character.',
      );
    }

    const lookup = await this.lookupGstin(gstin);
    if (lookup.status === 'FLAGGED') {
      // Not a hard stop: composition-scheme and freshly-issued registrations
      // legitimately come back like this, and blocking here would strand them.
      out.warnings.push(
        `GSTN reports this registration as ${String(
          lookup.findings.registrationStatus ?? 'not active',
        )}. Onboarding can continue; your buyer will review it before approval.`,
      );
    }
    if (lookup.status === 'ERROR') {
      out.warnings.push(
        'The GSTN verification service did not answer, so these values are ' +
          'unverified for now. We will re-check them before your buyer reviews.',
      );
    }

    const gstinVerified = checksumOk && lookup.status === 'CLEAR';
    out.fields.gstin = field(
      gstin,
      gstinVerified ? 'GSTN_API' : 'OCR',
      gstinVerified,
      gstinVerified ? 1 : raw.confidence,
    );

    // Structural derivations. These hold because of the check digit, not because
    // of anything the OCR engine believed — so they are verified even when the
    // registry lookup itself was unavailable.
    if (checksumOk) {
      const derivedPan = panFromGstin(gstin);
      const stateCode = stateCodeFromGstin(gstin);
      if (derivedPan) out.fields.businessPan = field(derivedPan, 'DERIVED', true, 1);
      if (stateCode) out.fields.stateCode = field(stateCode, 'DERIVED', true, 1);

      // The PAN printed on the certificate must agree with the one inside the
      // GSTIN. Disagreement means one of the two belongs to another entity.
      const printedMismatch = panGstinMismatch(raw.pan, gstin);
      if (printedMismatch) out.warnings.push(printedMismatch);

      // A certificate for a different registration than the one on file
      // *replaces* it rather than being refused for disagreeing with it. The
      // certificate is where the identity comes from; the saved GSTIN and PAN
      // are only an earlier certificate's reading. Refusing used to strand a
      // vendor whose first upload was the wrong certificate: the stale PAN was
      // the yardstick, so every correct certificate "disagreed" and was thrown
      // away, while the PAN field stayed locked to the other entity.
      const onFileGstin = (context.gstin ?? '').trim().toUpperCase();
      const onFilePan = (context.pan ?? panFromGstin(onFileGstin) ?? '')
        .trim()
        .toUpperCase();
      const replaced =
        onFileGstin && onFileGstin !== gstin
          ? `GSTIN ${onFileGstin}`
          : onFilePan && onFilePan !== derivedPan
            ? `PAN ${onFilePan}`
            : null;
      if (replaced) {
        out.supersedesIdentity = true;
        const panChanged = !!onFilePan && !!derivedPan && onFilePan !== derivedPan;
        out.warnings.push(
          `This certificate is for GSTIN ${gstin}. It replaces the ${replaced} saved ` +
            'earlier, and your PAN and business details now come from it — check them, ' +
            'then save steps 1 and 2 again.' +
            (panChanged
              ? ` Your PAN changes from ${onFilePan} to ${derivedPan}, so please also ` +
                `upload the PAN card for ${derivedPan}.`
              : ''),
        );
      }
    }

    // Legal name: the registry's copy if we have one, otherwise the certificate's
    // own text — offered, not asserted.
    const registryName = lookup.legalName;
    if (registryName) {
      out.fields.legalEntityName = field(registryName, 'GSTN_API', true, 1);
    } else if (raw.legalName && raw.confidence >= LOW_CONFIDENCE_THRESHOLD) {
      out.fields.legalEntityName = field(raw.legalName, 'OCR', false, raw.confidence);
    }

    // The trade name is what the business is known as — and on a proprietorship
    // certificate it is the only name a buyer would recognise, since the legal
    // name is the proprietor themselves.
    if (raw.tradeName && raw.confidence >= LOW_CONFIDENCE_THRESHOLD) {
      out.fields.tradeName = field(raw.tradeName, 'OCR', false, raw.confidence);
    }

    // Constitution of business → our legal-entity enum. Registry wording is
    // authoritative; the PAN's 4th character is only a narrowing hint (it cannot
    // tell an LLP from a partnership firm), so that stays editable.
    const registryType = entityTypeFromConstitution(lookup.constitution);
    const documentType = entityTypeFromConstitution(raw.constitution);
    const panType = entityTypeFromPan(out.fields.businessPan?.value ?? raw.pan);
    if (registryType) {
      out.fields.legalEntityType = field(registryType, 'GSTN_API', true, 1);
    } else if (documentType) {
      out.fields.legalEntityType = field(documentType, 'OCR', false, raw.confidence);
    } else if (panType) {
      out.fields.legalEntityType = field(panType, 'DERIVED', false, 0.6);
    }

    if (raw.addressLine1 && raw.confidence >= LOW_CONFIDENCE_THRESHOLD) {
      out.fields.addressLine1 = field(raw.addressLine1, 'OCR', false, raw.confidence);
    }
    if (raw.city) out.fields.city = field(raw.city, 'OCR', false, raw.confidence);
    if (raw.pincode)
      out.fields.pincode = field(raw.pincode, 'OCR', false, raw.confidence);
  }

  // ── PAN card ───────────────────────────────────────────────────────────────

  private async fromPanCard(
    raw: KycRawExtraction,
    context: KycContext,
    out: DocumentExtractionResult,
  ): Promise<void> {
    const pan = (raw.pan ?? '').toUpperCase();
    if (!isPanFormatValid(pan)) return;

    // Against whichever GSTIN we know about — the one just extracted from the
    // certificate, or the one already saved. A mismatch is the check the whole
    // flow exists for, so it blocks rather than warns.
    const mismatch = panGstinMismatch(pan, context.gstin);
    if (mismatch) {
      out.errors.push(mismatch);
      return;
    }

    const lookup = await this.screening
      .screen('PAN_STATUS', {
        gstin: null,
        pan,
        udyamNumber: null,
        legalEntityName: null,
        beneficialOwnerNames: [],
      })
      .catch((err: unknown) => {
        this.logger.warn(`PAN lookup failed: ${String(err)}`);
        return null;
      });

    const verified = lookup?.status === 'CLEAR';
    if (lookup?.status === 'FLAGGED') {
      out.warnings.push(
        'The PAN registry did not confirm this PAN. Please check the card and, ' +
          'if it is correct, continue — your buyer will review it.',
      );
    }
    out.fields.businessPan = field(
      pan,
      verified ? 'PAN_API' : 'OCR',
      verified,
      verified ? 1 : raw.confidence,
    );

    const holderName =
      typeof lookup?.findings.name === 'string' ? lookup.findings.name : null;
    if (holderName) {
      out.fields.legalEntityName = field(holderName, 'PAN_API', true, 1);
    } else if (raw.legalName && raw.confidence >= LOW_CONFIDENCE_THRESHOLD) {
      out.fields.legalEntityName = field(raw.legalName, 'OCR', false, raw.confidence);
    }

    const panType = entityTypeFromPan(pan);
    if (panType) out.fields.legalEntityType = field(panType, 'DERIVED', false, 0.6);
  }

  // ── cancelled cheque ───────────────────────────────────────────────────────

  /**
   * A cancelled cheque yields two things of very different quality, and the
   * difference is the point:
   *
   *  - the **IFSC**, which is structured, checkable against the directory, and
   *    resolves the bank name — so the vendor never types "HDFC Bank Ltd" again;
   *  - the **account number**, which is a bare run of digits on a page that also
   *    carries a cheque number and a MICR line. Nothing about it can be verified
   *    from the image, so it is filled in as a suggestion the vendor confirms,
   *    and the penny drop is what actually settles whether it is their account.
   */
  private async fromCancelledCheque(
    raw: KycRawExtraction,
    out: DocumentExtractionResult,
  ): Promise<void> {
    const ifsc = (raw.ifsc ?? '').toUpperCase();
    if (isIfscFormatValid(ifsc)) {
      const directory = await this.ifsc.lookup(ifsc).catch(() => null);
      if (directory) {
        out.fields.ifsc = field(ifsc, 'IFSC_API', true, 1);
        out.fields.bankName = field(directory.bank, 'IFSC_API', true, 1);
      } else {
        out.fields.ifsc = field(ifsc, 'OCR', false, raw.confidence);
        out.warnings.push(
          `We could not find IFSC ${ifsc} in the bank directory. Please check it ` +
            'against your cheque and enter your bank name.',
        );
      }
    }

    if (raw.accountNumber) {
      out.fields.accountNumber = field(raw.accountNumber, 'OCR', false, raw.confidence);
      out.warnings.push(
        'Check the account number we read from your cheque before saving — a cheque ' +
          'also carries a cheque number and a MICR code, which look similar.',
      );
    }
  }

  // ── registry lookup ────────────────────────────────────────────────────────

  /**
   * GSTN lookup for a GSTIN we have not saved yet.
   *
   * Note what is deliberately *not* sent: the legal name. The screening contract
   * accepts one, and passing the name we just OCR'd would mean any provider that
   * echoes its input hands it straight back — and we would then badge our own
   * guess as "verified via GSTN". Sending null means a name in the response can
   * only have come from the provider.
   */
  private async lookupGstin(gstin: string): Promise<{
    status: 'CLEAR' | 'FLAGGED' | 'ERROR';
    findings: Record<string, unknown>;
    legalName: string | null;
    constitution: string | null;
  }> {
    const result = await this.screening
      .screen('GSTIN_STATUS', {
        gstin,
        pan: panFromGstin(gstin),
        udyamNumber: null,
        legalEntityName: null,
        beneficialOwnerNames: [],
      })
      .catch((err: unknown) => {
        this.logger.warn(`GSTIN lookup failed: ${String(err)}`);
        return null;
      });
    if (!result) {
      return { status: 'ERROR', findings: {}, legalName: null, constitution: null };
    }
    const source = { ...result.raw, ...result.findings } as Record<string, unknown>;
    const str = (key: string): string | null =>
      typeof source[key] === 'string' && (source[key] as string).trim().length > 1
        ? (source[key] as string).trim()
        : null;
    return {
      status: result.status,
      findings: result.findings,
      legalName: str('legalName') ?? str('tradeName'),
      constitution: str('constitutionOfBusiness') ?? str('taxpayerType'),
    };
  }

  /**
   * Merge a new extraction into what the wizard already holds. Provenance only
   * ever moves *up*: a value the registry confirmed is never replaced by one
   * read off a later document, so uploading a blurry PAN card after a clean GST
   * certificate cannot downgrade the fields the certificate already proved.
   */
  static merge(
    existing: ExtractedFieldMap,
    incoming: ExtractedFieldMap,
  ): ExtractedFieldMap {
    const merged: ExtractedFieldMap = { ...existing };
    for (const [key, next] of Object.entries(incoming)) {
      const current = merged[key];
      if (!current) {
        merged[key] = next;
        continue;
      }
      if (current.verified && !next.verified) continue;
      if (!current.verified && next.verified) {
        merged[key] = next;
        continue;
      }
      if (next.confidence >= current.confidence) merged[key] = next;
    }
    return merged;
  }
}
