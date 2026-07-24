import { describe, expect, it } from 'vitest';

import { convertQty, hasConversion, UomConversionError } from './uom';

const CONV = [
  { fromUom: 'tonne', toUom: 'kg', factor: '1000' },
  { fromUom: 'bag', toUom: 'kg', factor: '50' },
];

describe('convertQty', () => {
  it('is the identity for same unit', () => {
    expect(convertQty(3, 'kg', 'kg', CONV)).toBe('3.000000');
  });

  it('converts tonne → kg via a direct edge', () => {
    expect(convertQty(2, 'tonne', 'kg', CONV)).toBe('2000.000000');
  });

  it('converts kg → tonne via the inverse edge', () => {
    expect(convertQty(2000, 'kg', 'tonne', CONV)).toBe('2.000000');
  });

  it('converts bag → kg', () => {
    expect(convertQty(10, 'bag', 'kg', CONV)).toBe('500.000000');
  });

  it('converts tonne → bag through the shared kg intermediate', () => {
    // 1 tonne = 1000 kg = 20 bags
    expect(convertQty(1, 'tonne', 'bag', CONV)).toBe('20.000000');
  });

  it('is case-insensitive on unit names', () => {
    expect(convertQty(1, 'Tonne', 'KG', CONV)).toBe('1000.000000');
  });

  it('throws UomConversionError for a disconnected pair', () => {
    expect(() => convertQty(1, 'tonne', 'litre', CONV)).toThrow(UomConversionError);
  });
});

describe('hasConversion', () => {
  it('is true when a path exists', () => {
    expect(hasConversion('tonne', 'bag', CONV)).toBe(true);
  });
  it('is false when no path exists', () => {
    expect(hasConversion('tonne', 'litre', CONV)).toBe(false);
  });
});
