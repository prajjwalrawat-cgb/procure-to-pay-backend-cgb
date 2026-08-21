import { describe, expect, it } from 'vitest';

import { gtinVariants, hasValidGtinCheckDigit, looksLikeGtin } from './gtin';

describe('gtinVariants', () => {
  it('pads a UPC-A to every longer GTIN length', () => {
    const variants = gtinVariants('012345678905');
    expect(variants).toContain('00012345678905'); // GTIN-14
    expect(variants).toContain('0012345678905'); // EAN-13
    expect(variants).toContain('012345678905'); // UPC-A as scanned
  });

  it('collapses leading-zero padding so the same article matches either way', () => {
    const padded = gtinVariants('00012345678905');
    const bare = gtinVariants('12345678905');
    // Both must offer the 13-digit form, which is how the label was stored.
    expect(padded).toContain('0012345678905');
    expect(bare).toContain('0012345678905');
  });

  it('returns longest form first — a carton code is the most specific match', () => {
    const [first] = gtinVariants('12345678');
    expect(first).toHaveLength(14);
  });

  it('ignores separators a scanner may emit', () => {
    expect(gtinVariants('0 12345-678905')).toContain('012345678905');
  });

  it('gives nothing for an internal code, so it can never fuzzy-match a barcode', () => {
    // "HD-000123" contains digits. Reducing it to "123" and padding would let it
    // collide with an unrelated product whose barcode ends in 123.
    expect(gtinVariants('HD-000123')).toEqual([]);
    expect(gtinVariants('ABC-XYZ')).toEqual([]);
  });

  it('refuses anything longer than a GTIN-14', () => {
    expect(gtinVariants('123456789012345')).toEqual([]);
  });
});

describe('looksLikeGtin', () => {
  it('accepts 8 to 14 clean digits', () => {
    expect(looksLikeGtin('12345678')).toBe(true);
    expect(looksLikeGtin('00012345678905')).toBe(true);
  });

  it('rejects short, long and non-numeric values', () => {
    expect(looksLikeGtin('1234567')).toBe(false);
    expect(looksLikeGtin('123456789012345')).toBe(false);
    expect(looksLikeGtin('HD-000123')).toBe(false);
  });
});

describe('hasValidGtinCheckDigit', () => {
  it('accepts a real EAN-13', () => {
    // 5901234123457 is the canonical GS1 example.
    expect(hasValidGtinCheckDigit('5901234123457')).toBe(true);
  });

  it('accepts a real UPC-A', () => {
    expect(hasValidGtinCheckDigit('036000291452')).toBe(true);
  });

  it('rejects a transposed digit', () => {
    expect(hasValidGtinCheckDigit('5901234123458')).toBe(false);
  });

  it('rejects a non-standard length outright', () => {
    expect(hasValidGtinCheckDigit('12345')).toBe(false);
  });
});
