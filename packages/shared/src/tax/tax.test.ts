import { describe, expect, it } from 'vitest';

import { computeDocTax, computeLineTax, determineTaxKind } from './tax';

// Plant: Meghalaya (17). Intra-state vendor also 17; inter-state vendor 24.
const INTRA = { plantStateCode: '17', vendorGstin: '17AAACS1234M1Z9' };
const INTER = { plantStateCode: '17', vendorGstin: '24AABCP1234K1Z5' };

describe('determineTaxKind', () => {
  it('intra-state → CGST_SGST', () => {
    expect(determineTaxKind(INTRA)).toBe('CGST_SGST');
  });
  it('inter-state → IGST', () => {
    expect(determineTaxKind(INTER)).toBe('IGST');
  });
  it('no vendor and no estimate → TBD', () => {
    expect(determineTaxKind({ plantStateCode: '17' })).toBe('TBD');
  });
  it('no vendor with estimate → intra estimate', () => {
    expect(determineTaxKind({ plantStateCode: '17', estimateWhenUnknown: true })).toBe(
      'CGST_SGST',
    );
  });
  it('URD → reverse-charge intra', () => {
    expect(determineTaxKind({ plantStateCode: '17', isUrd: true })).toBe('CGST_SGST');
  });
});

describe('computeLineTax', () => {
  it('splits 18% intra-state into equal CGST + SGST', () => {
    const r = computeLineTax({ qty: '8', unitPrice: '18900', taxRate: '0.18' }, INTRA);
    expect(r.lineSubtotal).toBe('151200.0000');
    expect(r.cgst).toBe('13608.0000');
    expect(r.sgst).toBe('13608.0000');
    expect(r.igst).toBe('0.0000');
    expect(r.taxAmount).toBe('27216.0000');
    expect(r.lineTotal).toBe('178416.0000');
    expect(r.taxKind).toBe('CGST_SGST');
  });

  it('applies IGST for inter-state', () => {
    const r = computeLineTax({ qty: '4', unitPrice: '10800', taxRate: '0.18' }, INTER);
    expect(r.lineSubtotal).toBe('43200.0000');
    expect(r.igst).toBe('7776.0000');
    expect(r.cgst).toBe('0.0000');
    expect(r.taxAmount).toBe('7776.0000');
    expect(r.taxKind).toBe('IGST');
  });

  it('honours a line discount before tax', () => {
    const r = computeLineTax(
      { qty: '10', unitPrice: '100', discountPct: '0.10', taxRate: '0.18' },
      INTRA,
    );
    expect(r.lineSubtotal).toBe('900.0000'); // 1000 − 10%
    expect(r.taxAmount).toBe('162.0000'); // 900 × 18%
  });

  it('flags reverse charge for a URD vendor', () => {
    const r = computeLineTax(
      { qty: '1', unitPrice: '1000', taxRate: '0.18' },
      { plantStateCode: '17', isUrd: true },
    );
    expect(r.isReverseCharge).toBe(true);
    expect(r.taxKind).toBe('CGST_SGST');
  });

  it('gypsum at 5% intra-state', () => {
    const r = computeLineTax({ qty: '100', unitPrice: '200', taxRate: '0.05' }, INTRA);
    expect(r.taxAmount).toBe('1000.0000'); // 20000 × 5%
    expect(r.cgst).toBe('500.0000');
  });

  it('28% chemical inter-state', () => {
    const r = computeLineTax({ qty: '2', unitPrice: '5000', taxRate: '0.28' }, INTER);
    expect(r.igst).toBe('2800.0000');
  });

  it('yields TBD (no tax) when no vendor and no estimate', () => {
    const r = computeLineTax(
      { qty: '5', unitPrice: '100', taxRate: '0.18' },
      { plantStateCode: '17' },
    );
    expect(r.taxKind).toBe('TBD');
    expect(r.taxAmount).toBe('0.0000');
    expect(r.lineTotal).toBe('500.0000');
  });
});

describe('computeDocTax', () => {
  it('aggregates mixed-rate lines intra-state', () => {
    const r = computeDocTax(
      [
        { qty: '8', unitPrice: '18900', taxRate: '0.18' },
        { qty: '100', unitPrice: '200', taxRate: '0.05' },
      ],
      INTRA,
    );
    expect(r.subtotal).toBe('171200.0000'); // 151200 + 20000
    expect(r.taxAmount).toBe('28216.0000'); // 27216 + 1000
    expect(r.total).toBe('199416.0000');
    expect(r.taxKind).toBe('CGST_SGST');
  });
});
