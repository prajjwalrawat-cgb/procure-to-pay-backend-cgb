import { describe, expect, it } from 'vitest';

import { classifyGstr2b } from './gstr2b-logic';

describe('classifyGstr2b (§9 four outcomes)', () => {
  const day = '2026-06-10';

  it('MATCHED when GSTIN+ref present with same amount + date', () => {
    expect(
      classifyGstr2b({
        invoiceGross: '118000.00',
        invoiceDay: day,
        entry: { invoiceValue: '118000.00', docDate: day },
      }),
    ).toBe('MATCHED');
  });

  it('tolerates sub-₹1 rounding as MATCHED', () => {
    expect(
      classifyGstr2b({
        invoiceGross: '118000.00',
        invoiceDay: day,
        entry: { invoiceValue: '118000.90', docDate: day },
      }),
    ).toBe('MATCHED');
  });

  it('MISMATCH_AMOUNT beyond the rounding tolerance', () => {
    expect(
      classifyGstr2b({
        invoiceGross: '118000.00',
        invoiceDay: day,
        entry: { invoiceValue: '118012.34', docDate: day },
      }),
    ).toBe('MISMATCH_AMOUNT');
  });

  it('MISMATCH_DATE when amount matches but the doc date differs', () => {
    expect(
      classifyGstr2b({
        invoiceGross: '118000.00',
        invoiceDay: day,
        entry: { invoiceValue: '118000.00', docDate: '2026-06-13' },
      }),
    ).toBe('MISMATCH_DATE');
  });

  it('NOT_FOUND when the invoice is absent from GSTR-2B', () => {
    expect(
      classifyGstr2b({ invoiceGross: '118000.00', invoiceDay: day, entry: undefined }),
    ).toBe('NOT_FOUND');
  });

  it('amount mismatch takes precedence over a date mismatch', () => {
    expect(
      classifyGstr2b({
        invoiceGross: '100000.00',
        invoiceDay: day,
        entry: { invoiceValue: '90000.00', docDate: '2026-01-01' },
      }),
    ).toBe('MISMATCH_AMOUNT');
  });
});
