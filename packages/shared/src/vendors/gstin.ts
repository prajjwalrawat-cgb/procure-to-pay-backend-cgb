/**
 * GSTIN / PAN structural rules — the checks that need no third-party call.
 *
 * A GSTIN is not an opaque string: it is `<2-digit state code><10-char PAN><entity
 * number><Z><checksum>`. That means three of the fields the onboarding wizard used
 * to ask a vendor to type — PAN, state code, and (loosely) entity type — are
 * *derivable* from the certificate, and a typo in any of them is detectable
 * locally. Doing it here rather than at a KYC vendor keeps the cheap, always-
 * available half of verification working even when the provider is down.
 *
 * Anything that needs the registry's own copy of the truth (legal name,
 * constitution of business, registration status) is NOT here — that comes from
 * the GSTN lookup in the API layer.
 */

import type { LegalEntityType } from '../constants/vendor-status';

export const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/;
export const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/** Base-36 alphabet the GSTIN checksum is computed over. */
const CHECKSUM_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function isGstinFormatValid(gstin: string): boolean {
  return GSTIN_REGEX.test(gstin.trim().toUpperCase());
}

export function isPanFormatValid(pan: string): boolean {
  return PAN_REGEX.test(pan.trim().toUpperCase());
}

/**
 * The GSTIN's own check digit (mod-36 weighted sum over the first 14 characters).
 * Catches a mistyped or hallucinated-by-OCR GSTIN before any API call — roughly
 * 97% of single-character errors fail here.
 */
export function isGstinChecksumValid(gstin: string): boolean {
  const g = gstin.trim().toUpperCase();
  if (!GSTIN_REGEX.test(g)) return false;
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const digit = CHECKSUM_ALPHABET.indexOf(g[i]!);
    if (digit < 0) return false;
    const product = digit * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  const expected = CHECKSUM_ALPHABET[(36 - (sum % 36)) % 36];
  return expected === g[14];
}

/** Characters 3–12 of a GSTIN are the holder's PAN, by construction. */
export function panFromGstin(gstin: string | null | undefined): string | null {
  const g = (gstin ?? '').trim().toUpperCase();
  if (!GSTIN_REGEX.test(g)) return null;
  const pan = g.slice(2, 12);
  return PAN_REGEX.test(pan) ? pan : null;
}

/** Characters 1–2 are the GST state code — the value that drives CGST+SGST vs IGST. */
export function stateCodeFromGstin(gstin: string | null | undefined): string | null {
  const g = (gstin ?? '').trim().toUpperCase();
  return GSTIN_REGEX.test(g) ? g.slice(0, 2) : null;
}

/**
 * PAN ↔ GSTIN agreement. Returns null when there is nothing to compare (either
 * side missing or malformed) so callers can distinguish "not checked" from
 * "checked and inconsistent" — the two must not be conflated: only the latter
 * blocks submission.
 */
export function panGstinMismatch(
  pan: string | null | undefined,
  gstin: string | null | undefined,
): string | null {
  const p = (pan ?? '').trim().toUpperCase();
  const embedded = panFromGstin(gstin);
  if (!embedded || !PAN_REGEX.test(p)) return null;
  if (embedded === p) return null;
  return (
    `PAN ${p} does not match the GSTIN — characters 3–12 of ${(gstin ?? '').trim().toUpperCase()} ` +
    `are ${embedded}. One of the two documents belongs to a different entity.`
  );
}

/**
 * The 4th character of a PAN encodes the holder's status. It narrows the
 * constitution of business but never pins it down (F covers both a partnership
 * firm and an LLP; C covers private and public companies), so the result is a
 * *suggestion* — surfaced as an unverified, editable value. The authoritative
 * answer is GSTN's "constitution of business" field.
 */
export function entityTypeFromPan(
  pan: string | null | undefined,
): LegalEntityType | null {
  const p = (pan ?? '').trim().toUpperCase();
  if (!PAN_REGEX.test(p)) return null;
  switch (p[3]) {
    case 'C':
      return 'PVT_LTD';
    case 'P':
      return 'PROPRIETORSHIP';
    case 'F':
      return 'PARTNERSHIP';
    case 'H':
      return 'HUF';
    case 'T':
      return 'TRUST';
    case 'A':
    case 'B':
      return 'SOCIETY';
    default:
      // G (government), J (artificial juridical), L (local authority), K, E —
      // no honest mapping onto our list; leave it for the vendor to pick.
      return null;
  }
}

/** GSTN's free-text "constitution of business" → our enum. Registry wording is
 *  stable but not identical across states, so match on substrings. */
export function entityTypeFromConstitution(
  constitution: string | null | undefined,
): LegalEntityType | null {
  const c = (constitution ?? '').trim().toUpperCase();
  if (!c) return null;
  if (c.includes('PROPRIETOR')) return 'PROPRIETORSHIP';
  if (c.includes('LIMITED LIABILITY') || c.includes('LLP')) return 'LLP';
  if (c.includes('PUBLIC')) return 'PUBLIC_LTD';
  if (c.includes('PRIVATE') || c.includes('COMPANY')) return 'PVT_LTD';
  if (c.includes('PARTNERSHIP') || c.includes('FIRM')) return 'PARTNERSHIP';
  if (c.includes('HINDU UNDIVIDED') || c.includes('HUF')) return 'HUF';
  if (c.includes('TRUST')) return 'TRUST';
  if (c.includes('SOCIET') || c.includes('ASSOCIATION') || c.includes('CLUB'))
    return 'SOCIETY';
  if (c.includes('INDIVIDUAL')) return 'INDIVIDUAL';
  return null;
}
