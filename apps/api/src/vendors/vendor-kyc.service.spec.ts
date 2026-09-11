import { deflateSync } from 'node:zlib';

import { describe, expect, it, vi } from 'vitest';

import { CircuitBreaker } from '../common/integrations/circuit-breaker';
import { IntegrationUsageService } from '../integrations/integration-usage.service';
import { VendorKycService } from './vendor-kyc.service';
import {
  SandboxKycExtractionProvider,
  parseKycText,
  pdfTextLayer,
} from './verification/kyc-extraction.provider';
import { SandboxIfscProvider } from './verification/ifsc.provider';
import type { IScreeningProvider } from './verification/screening.provider';

/* The GSTN documentation's own worked example, so the check digit is known-good
 * independently of the code under test. PAN = characters 3–12, state = 27. */
const GSTIN = '27AAPFU0939F1ZV';
const PAN = 'AAPFU0939F';

/** A minimal single-stream PDF carrying the given lines as real text — the
 *  shape a portal-issued certificate has (generated, not scanned). */
function textPdf(lines: string[]): Buffer {
  const content = lines.map((l) => `BT (${l}) Tj ET`).join('\n');
  const stream = deflateSync(Buffer.from(content, 'latin1'));
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Length 1 >>\nstream\n', 'latin1'),
    stream,
    Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1'),
  ]);
}

const GST_CERT_LINES = [
  'Form GST REG-06 Registration Certificate',
  `Registration Number: ${GSTIN}`,
  'Legal Name of Business Umang Fabricators',
  'Trade Name, if any Umang Fab',
  'Constitution of Business Partnership',
  'Address of Principal Place of Business 14 Industrial Estate, Andheri East',
  'Pincode 400069',
];

/** Screening provider stub. Answers like the sandbox one does: it confirms the
 *  registration but has no registry copy of the name to hand back. */
function screeningStub(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    screen: vi.fn(async (type: string) => ({
      status: (overrides[`${type}.status`] as 'CLEAR' | 'FLAGGED') ?? 'CLEAR',
      findings: (overrides[`${type}.findings`] as Record<string, unknown>) ?? {},
      raw: (overrides[`${type}.raw`] as Record<string, unknown>) ?? {},
    })),
  } as unknown as IScreeningProvider;
}

function build(screening: IScreeningProvider = screeningStub()) {
  const usage = { log: vi.fn() } as unknown as IntegrationUsageService;
  return new VendorKycService(
    new SandboxKycExtractionProvider(usage),
    screening,
    new SandboxIfscProvider(new CircuitBreaker(), usage),
  );
}

describe('reading a generated certificate', () => {
  it('recovers the text layer of a Flate-compressed PDF', () => {
    const text = pdfTextLayer(textPdf(GST_CERT_LINES));
    expect(text).toContain(GSTIN);
    expect(text).toContain('Umang Fabricators');
  });

  it('picks the GSTIN whose check digit agrees over one that does not', () => {
    const parsed = parseKycText(
      `Issuing office 07AAPFU0939F1ZZ Registration Number ${GSTIN}`,
      'GST_CERT',
    );
    expect(parsed.gstin).toBe(GSTIN);
  });
});

describe('VendorKycService — GST certificate', () => {
  it('verifies the GSTIN and derives PAN + state code from it', async () => {
    const result = await build().extractDocument(
      {
        docType: 'GST_CERT',
        s3Key: 'k',
        buffer: textPdf(GST_CERT_LINES),
        mimeType: 'application/pdf',
      },
      { gstin: null, pan: null },
    );

    expect(result.fields.gstin).toMatchObject({ value: GSTIN, verified: true });
    // Derived, not read: this is what ends the mistyped-PAN class of error.
    expect(result.fields.businessPan).toMatchObject({
      value: PAN,
      source: 'DERIVED',
      verified: true,
    });
    expect(result.fields.stateCode).toMatchObject({ value: '27', verified: true });
    expect(result.errors).toEqual([]);
  });

  it('offers the printed legal name but never marks it verified', async () => {
    const result = await build().extractDocument(
      {
        docType: 'GST_CERT',
        s3Key: 'k',
        buffer: textPdf(GST_CERT_LINES),
        mimeType: 'application/pdf',
      },
      { gstin: null, pan: null },
    );
    // No registry copy came back, so the certificate's own text is a suggestion.
    expect(result.fields.legalEntityName).toMatchObject({
      value: 'Umang Fabricators',
      source: 'OCR',
      verified: false,
    });
  });

  it('does not send the OCR-read name to the registry — a name in the response can only be the registry’s', async () => {
    const screening = screeningStub();
    await build(screening).extractDocument(
      {
        docType: 'GST_CERT',
        s3Key: 'k',
        buffer: textPdf(GST_CERT_LINES),
        mimeType: 'application/pdf',
      },
      { gstin: null, pan: null },
    );
    const [, input] = (screening.screen as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0]!;
    expect((input as { legalEntityName: unknown }).legalEntityName).toBeNull();
  });

  it('takes the registry copy of the name and constitution when there is one', async () => {
    const screening = screeningStub({
      'GSTIN_STATUS.raw': {
        legalName: 'UMANG FABRICATORS LLP',
        constitutionOfBusiness: 'Limited Liability Partnership',
      },
    });
    const result = await build(screening).extractDocument(
      {
        docType: 'GST_CERT',
        s3Key: 'k',
        buffer: textPdf(GST_CERT_LINES),
        mimeType: 'application/pdf',
      },
      { gstin: null, pan: null },
    );
    expect(result.fields.legalEntityName).toMatchObject({
      value: 'UMANG FABRICATORS LLP',
      source: 'GSTN_API',
      verified: true,
    });
    expect(result.fields.legalEntityType).toMatchObject({ value: 'LLP', verified: true });
  });

  it('warns rather than blocks when GSTN reports the registration inactive', async () => {
    const screening = screeningStub({
      'GSTIN_STATUS.status': 'FLAGGED',
      'GSTIN_STATUS.findings': { registrationStatus: 'CANCELLED' },
    });
    const result = await build(screening).extractDocument(
      {
        docType: 'GST_CERT',
        s3Key: 'k',
        buffer: textPdf(GST_CERT_LINES),
        mimeType: 'application/pdf',
      },
      { gstin: null, pan: null },
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings.join(' ')).toContain('CANCELLED');
    // Unconfirmed, so it stays editable — but the PAN derivation still holds.
    expect(result.fields.gstin?.verified).toBe(false);
    expect(result.fields.businessPan?.verified).toBe(true);
  });

  it('falls back to manual entry for a scan it cannot read, without erroring', async () => {
    const result = await build().extractDocument(
      {
        docType: 'GST_CERT',
        s3Key: 'k',
        buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
        mimeType: 'image/jpeg',
      },
      { gstin: null, pan: null },
    );
    expect(result.manualFallback).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });
});

describe('VendorKycService — PAN card cross-check', () => {
  const panPdf = textPdf(['INCOME TAX DEPARTMENT', `Permanent Account Number ${PAN}`]);

  it('accepts a PAN card that agrees with the GSTIN on file', async () => {
    const result = await build().extractDocument(
      { docType: 'PAN_CARD', s3Key: 'k', buffer: panPdf, mimeType: 'application/pdf' },
      { gstin: GSTIN, pan: null },
    );
    expect(result.errors).toEqual([]);
    expect(result.fields.businessPan).toMatchObject({ value: PAN, verified: true });
  });

  it('blocks a PAN card belonging to a different entity', async () => {
    const other = textPdf(['Permanent Account Number AFMFS3755D']);
    const result = await build().extractDocument(
      { docType: 'PAN_CARD', s3Key: 'k', buffer: other, mimeType: 'application/pdf' },
      { gstin: GSTIN, pan: null },
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('AFMFS3755D');
    expect(result.fields.businessPan).toBeUndefined();
  });
});

/**
 * A vendor whose first upload was the wrong certificate — in the case that
 * prompted this, their buyer's own — has to be able to correct it. The saved
 * identity used to be the yardstick, so the correct certificate "disagreed"
 * with it, was refused, and the PAN field stayed locked to the other entity.
 */
describe('VendorKycService — a certificate for another registration', () => {
  const gstCert = {
    docType: 'GST_CERT' as const,
    s3Key: 'k',
    buffer: textPdf(GST_CERT_LINES),
    mimeType: 'application/pdf',
  };

  it('replaces the GSTIN and PAN on file rather than refusing the certificate', async () => {
    const result = await build().extractDocument(gstCert, {
      gstin: '07AFMFS3755D1ZK',
      pan: 'AFMFS3755D',
    });
    expect(result.errors).toEqual([]);
    expect(result.supersedesIdentity).toBe(true);
    expect(result.fields.businessPan).toMatchObject({ value: PAN, verified: true });
    expect(result.confirmsDocument).toBe(true);
    // The vendor is told what changed, and that the PAN card has to follow.
    const told = result.warnings.join(' ');
    expect(told).toContain('07AFMFS3755D1ZK');
    expect(told).toContain(`upload the PAN card for ${PAN}`);
  });

  it('also replaces a PAN saved before any certificate was uploaded', async () => {
    const result = await build().extractDocument(gstCert, {
      gstin: null,
      pan: 'AFMFS3755D',
    });
    expect(result.errors).toEqual([]);
    expect(result.supersedesIdentity).toBe(true);
  });

  it('is an ordinary re-upload when the registration is the same', async () => {
    const result = await build().extractDocument(gstCert, { gstin: GSTIN, pan: PAN });
    expect(result.supersedesIdentity).toBeFalsy();
    expect(result.warnings).toEqual([]);
  });
});

describe('merging extractions', () => {
  const verified = {
    value: 'A',
    source: 'GSTN_API' as const,
    verified: true,
    confidence: 1,
  };
  const guessed = {
    value: 'B',
    source: 'OCR' as const,
    verified: false,
    confidence: 0.9,
  };

  it('never lets an unverified read replace a verified one', () => {
    expect(
      VendorKycService.merge({ legalEntityName: verified }, { legalEntityName: guessed }),
    ).toEqual({ legalEntityName: verified });
  });

  it('upgrades an unverified value when verification arrives', () => {
    expect(
      VendorKycService.merge({ legalEntityName: guessed }, { legalEntityName: verified }),
    ).toEqual({ legalEntityName: verified });
  });
});

describe('VendorKycService — cancelled cheque', () => {
  const cheque = (lines: string[]) => ({
    docType: 'CANCELLED_CHEQUE' as const,
    s3Key: 'k',
    buffer: textPdf(lines),
    mimeType: 'application/pdf',
  });

  it('resolves the bank from the IFSC rather than asking the vendor for it', async () => {
    const result = await build().extractDocument(
      cheque(['HDFC BANK LTD', 'A/c No 50100123456789', 'IFSC HDFC0001234']),
      { gstin: null, pan: null },
    );
    expect(result.fields.ifsc).toMatchObject({
      value: 'HDFC0001234',
      source: 'IFSC_API',
      verified: true,
    });
    expect(result.fields.bankName).toMatchObject({
      value: 'HDFC Bank',
      verified: true,
    });
  });

  it('offers the account number but never claims it is confirmed', async () => {
    const result = await build().extractDocument(
      cheque(['A/c No 50100123456789', 'IFSC HDFC0001234']),
      { gstin: null, pan: null },
    );
    expect(result.fields.accountNumber).toMatchObject({
      value: '50100123456789',
      source: 'OCR',
      verified: false,
    });
    // The vendor is told why it needs checking rather than left to assume.
    expect(result.warnings.join(' ')).toContain('MICR');
  });

  it('prefers the labelled account number over the MICR line', async () => {
    const result = await build().extractDocument(
      cheque(['000123', 'A/c No 50100123456789', '110240001', 'IFSC HDFC0001234']),
      { gstin: null, pan: null },
    );
    expect(result.fields.accountNumber?.value).toBe('50100123456789');
  });

  it('asks the vendor to check an IFSC the directory does not know', async () => {
    const result = await build().extractDocument(
      cheque(['A/c No 50100123456789', 'IFSC ZZZZ0001234']),
      { gstin: null, pan: null },
    );
    expect(result.fields.ifsc).toMatchObject({ verified: false });
    expect(result.fields.bankName).toBeUndefined();
    expect(result.warnings.join(' ')).toContain('ZZZZ0001234');
  });
});

/**
 * The flag the buyer's "auto verified" badge rests on. It used to be a list of
 * document *types* — anything filed as a PAN card went green on arrival — so a
 * blank page and a real card were indistinguishable on the review screen.
 */
describe('does the document prove what it claims to be', () => {
  const gstCert = {
    docType: 'GST_CERT' as const,
    s3Key: 'k',
    buffer: textPdf(GST_CERT_LINES),
    mimeType: 'application/pdf',
  };

  it('confirms a certificate whose GSTIN the registry accepted', async () => {
    const result = await build().extractDocument(gstCert, { gstin: null, pan: null });
    expect(result.confirmsDocument).toBe(true);
  });

  it('does not confirm one the registry reported inactive', async () => {
    const screening = screeningStub({
      'GSTIN_STATUS.status': 'FLAGGED',
      'GSTIN_STATUS.findings': { registrationStatus: 'CANCELLED' },
    });
    const result = await build(screening).extractDocument(gstCert, {
      gstin: null,
      pan: null,
    });
    expect(result.confirmsDocument).toBe(false);
  });

  it('does not confirm a file with no GSTIN on it at all', async () => {
    const notACertificate = {
      ...gstCert,
      buffer: textPdf(['INVOICE', 'Thank you for your business']),
    };
    const result = await build().extractDocument(notACertificate, {
      gstin: null,
      pan: null,
    });
    expect(result.confirmsDocument).toBe(false);
    expect(result.manualFallback).toBe(true);
  });

  it('does not confirm a scan it could not read', async () => {
    const result = await build().extractDocument(
      { ...gstCert, buffer: Buffer.from([0xff, 0xd8, 0xff]), mimeType: 'image/jpeg' },
      { gstin: null, pan: null },
    );
    expect(result.confirmsDocument).toBe(false);
  });

  it('confirms a cheque whose IFSC the directory knows, and not one it does not', async () => {
    const cheque = (ifsc: string) => ({
      docType: 'CANCELLED_CHEQUE' as const,
      s3Key: 'k',
      buffer: textPdf([`A/c No 50100123456789`, `IFSC ${ifsc}`]),
      mimeType: 'application/pdf',
    });
    const known = await build().extractDocument(cheque('HDFC0001234'), {
      gstin: null,
      pan: null,
    });
    const unknown = await build().extractDocument(cheque('ZZZZ0001234'), {
      gstin: null,
      pan: null,
    });
    expect(known.confirmsDocument).toBe(true);
    expect(unknown.confirmsDocument).toBe(false);
  });

  it('never confirms a document type nothing checks', async () => {
    const result = await build().extractDocument(
      { ...gstCert, docType: 'AUDITED_FINANCIALS' },
      { gstin: null, pan: null },
    );
    expect(result.confirmsDocument).toBe(false);
  });
});
