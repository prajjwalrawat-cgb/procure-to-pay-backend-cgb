import { describe, expect, it } from 'vitest';

import {
  entityTypeFromConstitution,
  entityTypeFromPan,
  isGstinChecksumValid,
  panFromGstin,
  panGstinMismatch,
  stateCodeFromGstin,
} from './gstin';

/* 27AAPFU0939F1ZV is the GSTN documentation's own worked example, so its check
 * digit is known-good rather than one we computed with the code under test. */
const REAL_GSTIN = '27AAPFU0939F1ZV';

describe('GSTIN derivations', () => {
  it('accepts a GSTIN whose check digit is correct', () => {
    expect(isGstinChecksumValid(REAL_GSTIN)).toBe(true);
  });

  it('rejects a single-character typo — the case OCR actually produces', () => {
    expect(isGstinChecksumValid('27AAPFU0939F1ZW')).toBe(false);
    expect(isGstinChecksumValid('27AAPFU0938F1ZV')).toBe(false);
  });

  it('pulls the PAN and state code out of the GSTIN', () => {
    expect(panFromGstin(REAL_GSTIN)).toBe('AAPFU0939F');
    expect(stateCodeFromGstin(REAL_GSTIN)).toBe('27');
  });

  it('returns null rather than a guess for a malformed GSTIN', () => {
    expect(panFromGstin('27AAPFU0939')).toBeNull();
    expect(stateCodeFromGstin('')).toBeNull();
  });
});

describe('PAN ↔ GSTIN consistency', () => {
  it('is silent when the two agree', () => {
    expect(panGstinMismatch('AAPFU0939F', REAL_GSTIN)).toBeNull();
  });

  it('names both values when they disagree', () => {
    const msg = panGstinMismatch('AFMFS3755D', REAL_GSTIN);
    expect(msg).toContain('AFMFS3755D');
    expect(msg).toContain('AAPFU0939F');
  });

  it('distinguishes "not checked" from "inconsistent"', () => {
    // Nothing to compare against — must not read as a mismatch.
    expect(panGstinMismatch('AAPFU0939F', null)).toBeNull();
    expect(panGstinMismatch(null, REAL_GSTIN)).toBeNull();
  });
});

describe('entity type suggestions', () => {
  it('reads the holder status out of the PAN', () => {
    expect(entityTypeFromPan('AAPFU0939F')).toBe('PARTNERSHIP'); // F
    expect(entityTypeFromPan('AAACU0939F')).toBe('PVT_LTD'); // C
    expect(entityTypeFromPan('AAPPU0939F')).toBe('PROPRIETORSHIP'); // P
  });

  it('gives up rather than guessing on statuses we do not model', () => {
    expect(entityTypeFromPan('AAPGU0939F')).toBeNull(); // G — government
  });

  it('prefers GSTN wording where it is available', () => {
    expect(entityTypeFromConstitution('Private Limited Company')).toBe('PVT_LTD');
    expect(entityTypeFromConstitution('Limited Liability Partnership')).toBe('LLP');
    expect(entityTypeFromConstitution('Proprietorship')).toBe('PROPRIETORSHIP');
    expect(entityTypeFromConstitution('')).toBeNull();
  });
});
