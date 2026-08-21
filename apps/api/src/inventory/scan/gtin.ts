/**
 * GTIN normalisation (Slice 13).
 *
 * The same physical article carries different-length codes depending on who
 * printed the label: GTIN-8 on a small pack, UPC-A (12) from a US supplier,
 * EAN-13 in India, GTIN-14 on the outer carton. They are the *same* number with
 * different amounts of leading-zero padding, which is why a naive string
 * comparison fails on stock that scans perfectly well.
 *
 * Pure functions, no Nest and no Prisma — the matching rules are the part worth
 * testing in isolation.
 */

/** The four GTIN lengths in circulation. */
const GTIN_LENGTHS = [8, 12, 13, 14] as const;

/** Digits only. Scanners occasionally emit spaces or hyphens around the value. */
export function digitsOnly(raw: string): string {
  return raw.replace(/\D/g, '');
}

/** True when the value is a plausible GTIN — all digits, 8 to 14 of them. */
export function looksLikeGtin(raw: string): boolean {
  const d = digitsOnly(raw);
  return d.length >= 8 && d.length <= 14 && d === raw.trim();
}

/**
 * Every equivalent representation of a scanned code, longest-form first.
 *
 * "0012345678905" and "12345678905" and "00000012345678905"-style padding all
 * collapse to the same significant digits, which are then re-padded to each
 * standard length. Returns an empty array for anything that is not numeric, so
 * a caller can skip the fuzzy pass entirely on an alphanumeric internal code.
 */
export function gtinVariants(raw: string): string[] {
  // Letters disqualify the value outright. An internal code like "HD-000123"
  // has digits in it, and reducing it to "123" would let it fuzzy-match a
  // completely unrelated product whose barcode happens to end in 123. Only
  // separators a scanner might insert — spaces and hyphens — are tolerated.
  const stripped = raw.trim().replace(/[\s-]/g, '');
  if (stripped.length === 0 || !/^\d+$/.test(stripped)) return [];

  const digits = stripped;

  // Strip leading zeros down to the significant digits, but never to nothing.
  const significant = digits.replace(/^0+/, '') || '0';
  if (significant.length > 14) return [];

  const out = new Set<string>();
  for (const len of GTIN_LENGTHS) {
    if (significant.length <= len) out.add(significant.padStart(len, '0'));
  }
  // The raw digits themselves, in case the label carries a non-standard length.
  out.add(digits);
  out.add(significant);

  // Longest first: a 14-digit carton code is the most specific match available.
  return [...out].sort((a, b) => b.length - a.length);
}

/**
 * GS1 mod-10 check digit. Not used to *reject* scans — plenty of real internal
 * barcodes are not GS1-compliant — but a valid check digit is good evidence
 * that a fuzzy match is the right one rather than a numeric coincidence.
 */
export function hasValidGtinCheckDigit(raw: string): boolean {
  const d = digitsOnly(raw);
  if (!GTIN_LENGTHS.includes(d.length as (typeof GTIN_LENGTHS)[number])) return false;

  const body = d.slice(0, -1);
  const check = Number(d.slice(-1));
  // Weights alternate 3,1,3,1… reading right-to-left from the digit before the
  // check digit — the direction matters, and it flips with the code's length.
  let sum = 0;
  for (
    let i = body.length - 1, weight = 3;
    i >= 0;
    i -= 1, weight = weight === 3 ? 1 : 3
  ) {
    sum += Number(body[i]) * weight;
  }
  return (10 - (sum % 10)) % 10 === check;
}
