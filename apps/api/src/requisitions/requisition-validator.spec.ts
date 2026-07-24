import { describe, expect, it } from 'vitest';

import { RequisitionValidator, type ValidatorLineInput } from './requisition-validator';

const validator = new RequisitionValidator();

const INTRA = { plantStateCode: '17', vendorGstin: '17AAACS1234M1Z9' };
const INTER = { plantStateCode: '17', vendorGstin: '24AABCP1234K1Z5' };

function line(overrides: Partial<ValidatorLineInput> = {}): ValidatorLineInput {
  return {
    lineNo: 1,
    itemId: 'item_1',
    itemDesc: 'Grinding balls',
    hsnCode: '7325',
    uom: 'tonne',
    qty: '8',
    unitPrice: '128500',
    taxRate: '0.18',
    ...overrides,
  };
}

describe('RequisitionValidator', () => {
  it('computes CGST+SGST intra-state line + doc totals', () => {
    const r = validator.validate([line()], INTRA);
    expect(r.taxKind).toBe('CGST_SGST');
    expect(r.subtotal).toBe('1028000.0000');
    expect(r.taxAmount).toBe('185040.0000');
    expect(r.total).toBe('1213040.0000');
    expect(r.lines[0]?.lineTotal).toBe('1213040.0000');
    expect(validator.isSubmittable(r)).toBe(true);
  });

  it('computes IGST inter-state', () => {
    const r = validator.validate([line()], INTER);
    expect(r.taxKind).toBe('IGST');
    expect(r.taxAmount).toBe('185040.0000');
    expect(r.lines[0]?.isReverseCharge).toBe(false);
  });

  it('flags reverse charge for a URD vendor', () => {
    const r = validator.validate([line()], { plantStateCode: '17', isUrd: true });
    expect(r.isReverseCharge).toBe(true);
    expect(r.lines[0]?.isReverseCharge).toBe(true);
  });

  it('handles mixed-rate lines (18% + 5% gypsum)', () => {
    const r = validator.validate(
      [
        line({ lineNo: 1, qty: '10', unitPrice: '1000', taxRate: '0.18' }),
        line({ lineNo: 2, qty: '100', unitPrice: '200', taxRate: '0.05', itemId: 'g' }),
      ],
      INTRA,
    );
    // 10000×18% = 1800 ; 20000×5% = 1000
    expect(r.taxAmount).toBe('2800.0000');
    expect(r.subtotal).toBe('30000.0000');
  });

  it('applies a line discount before tax', () => {
    const r = validator.validate(
      [line({ qty: '10', unitPrice: '100', discountPct: '0.10', taxRate: '0.18' })],
      INTRA,
    );
    expect(r.subtotal).toBe('900.0000');
    expect(r.taxAmount).toBe('162.0000');
  });

  it('tax-exclusive line: total = subtotal + tax', () => {
    const r = validator.validate(
      [line({ qty: '1', unitPrice: '1000', taxRate: '0.18' })],
      INTRA,
    );
    expect(r.lines[0]?.lineTotal).toBe('1180.0000');
  });

  it('raises NON_POSITIVE_QTY for a zero-qty line', () => {
    const r = validator.validate([line({ qty: '0' })], INTRA);
    expect(r.issues.some((i) => i.code === 'NON_POSITIVE_QTY')).toBe(true);
    expect(validator.isSubmittable(r)).toBe(false);
  });

  it('raises NON_POSITIVE_QTY for a negative qty', () => {
    const r = validator.validate([line({ qty: '-2' })], INTRA);
    expect(r.issues.some((i) => i.code === 'NON_POSITIVE_QTY')).toBe(true);
  });

  it('raises NEGATIVE_PRICE for a negative unit price', () => {
    const r = validator.validate([line({ unitPrice: '-5' })], INTRA);
    expect(r.issues.some((i) => i.code === 'NEGATIVE_PRICE')).toBe(true);
  });

  it('requires a reason code for a non-catalogued line', () => {
    const r = validator.validate([line({ itemId: null, reasonCode: null })], INTRA);
    expect(r.issues.some((i) => i.code === 'MISSING_REASON_CODE')).toBe(true);
  });

  it('accepts a non-catalogued line with a reason code', () => {
    const r = validator.validate(
      [line({ itemId: null, reasonCode: 'EMERGENCY', expectedGstRate: null })],
      INTRA,
    );
    expect(r.issues.some((i) => i.code === 'MISSING_REASON_CODE')).toBe(false);
  });

  it('warns (not blocks) on HSN/GST mismatch vs the item master', () => {
    const r = validator.validate(
      [line({ taxRate: '0.12', expectedGstRate: '0.18' })],
      INTRA,
    );
    expect(r.issues.some((i) => i.code === 'HSN_GST_MISMATCH')).toBe(true);
    // A rate mismatch is a warning — the PR is still submittable.
    expect(validator.isSubmittable(r)).toBe(true);
  });

  it('does not warn when tax rate matches the item master', () => {
    const r = validator.validate(
      [line({ taxRate: '0.18', expectedGstRate: '0.18' })],
      INTRA,
    );
    expect(r.issues.some((i) => i.code === 'HSN_GST_MISMATCH')).toBe(false);
  });

  it('raises NO_LINES for an empty requisition', () => {
    const r = validator.validate([], INTRA);
    expect(r.issues.some((i) => i.code === 'NO_LINES')).toBe(true);
    expect(validator.isSubmittable(r)).toBe(false);
  });

  it('yields TBD tax when no vendor and no estimate flag', () => {
    const r = validator.validate([line({ itemId: 'i' })], { plantStateCode: '17' });
    expect(r.taxKind).toBe('TBD');
    expect(r.taxAmount).toBe('0.0000');
  });

  it('produces an intra-state estimate at PR stage (no vendor)', () => {
    const r = validator.validate([line({ itemId: 'i' })], {
      plantStateCode: '17',
      estimateWhenUnknown: true,
    });
    expect(r.taxKind).toBe('CGST_SGST');
    expect(r.taxAmount).toBe('185040.0000');
  });

  it('carries the import-duty stub flag through unchanged', () => {
    const r = validator.validate([line({ isImportDuty: true })], INTRA);
    expect(r.lines[0]?.isImportDuty).toBe(true);
  });

  it('aggregates a multi-line document total correctly', () => {
    const r = validator.validate(
      [
        line({ lineNo: 1, qty: '8', unitPrice: '128500', taxRate: '0.18' }),
        line({ lineNo: 2, qty: '4', unitPrice: '121000', taxRate: '0.18', itemId: 'b' }),
        line({ lineNo: 3, qty: '2', unitPrice: '15000', taxRate: '0.18', itemId: 'c' }),
      ],
      INTRA,
    );
    // (1028000 + 484000 + 30000) = 1542000 subtotal
    expect(r.subtotal).toBe('1542000.0000');
    expect(r.total).toBe('1819560.0000'); // matches PR-1141 ≈ ₹18.2L
  });
});
