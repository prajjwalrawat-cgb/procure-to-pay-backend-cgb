import { describe, expect, it } from 'vitest';

import { runMatch } from './match-engine';
import type { MatchInput, MatchInvoiceLine, MatchPoLine, MatchTolerances } from './types';

const TOL: MatchTolerances = {
  priceVariancePct: '0.005',
  qtyVariancePct: '0.02',
  qtyVarianceAbs: '1',
  taxExact: true,
};

function po(lines: Partial<MatchPoLine>[], allowFreightLines = false): MatchInput['po'] {
  return {
    allowFreightLines,
    lines: lines.map((l, i) => ({
      id: l.id ?? `p${i + 1}`,
      lineNo: l.lineNo ?? i + 1,
      itemDesc: l.itemDesc ?? `Item ${i + 1}`,
      uom: l.uom ?? 'EA',
      qtyOrdered: l.qtyOrdered ?? '1',
      unitPrice: l.unitPrice ?? '100',
      taxRate: l.taxRate ?? '0.18',
    })),
  };
}

function inv(lines: Partial<MatchInvoiceLine>[]): MatchInput['invoice'] {
  return {
    lines: lines.map((l, i) => ({
      id: l.id ?? `i${i + 1}`,
      lineNo: l.lineNo ?? i + 1,
      itemDesc: l.itemDesc ?? `Item ${i + 1}`,
      uom: l.uom ?? 'EA',
      qty: l.qty ?? '1',
      unitPrice: l.unitPrice ?? '100',
      taxRate: l.taxRate ?? '0.18',
      poLineId: l.poLineId ?? null,
    })),
  };
}

function grn(lines: { poLineId: string; qtyAccepted: string }[]): MatchInput['grn'] {
  return { lines: lines.map((l) => ({ ...l, qtyRejected: '0' })) };
}

describe('runMatch — 3-way match engine', () => {
  it('INV-4471: rate variance on SNL 518 + unauthorised freight → +₹3,068 variance', () => {
    const input: MatchInput = {
      tolerances: TOL,
      po: po([
        { id: 'p1', itemDesc: 'SRB 22318', qtyOrdered: '8', unitPrice: '18900' },
        { id: 'p2', itemDesc: 'SNL 518', qtyOrdered: '2', unitPrice: '10800' },
        { id: 'p3', itemDesc: 'Grease 15kg', qtyOrdered: '1', unitPrice: '8400' },
      ]),
      grn: grn([
        { poLineId: 'p1', qtyAccepted: '8' },
        { poLineId: 'p2', qtyAccepted: '2' },
        { poLineId: 'p3', qtyAccepted: '1' },
      ]),
      invoice: inv([
        { id: 'i1', poLineId: 'p1', itemDesc: 'SRB 22318', qty: '8', unitPrice: '18900' },
        { id: 'i2', poLineId: 'p2', itemDesc: 'SNL 518', qty: '2', unitPrice: '11200' },
        {
          id: 'i3',
          poLineId: 'p3',
          itemDesc: 'Grease 15kg',
          qty: '1',
          unitPrice: '8400',
        },
        { id: 'i4', poLineId: null, itemDesc: 'Freight', qty: '1', unitPrice: '1800' },
      ]),
    };

    const result = runMatch(input);
    expect(result.matched).toBe(false);
    const types = result.exceptions.map((e) => e.type).sort();
    expect(types).toEqual(['RATE_VARIANCE', 'UNAUTHORISED_LINE']);
    expect(result.varianceTotal).toBe('3068.0000');

    const rate = result.exceptions.find((e) => e.type === 'RATE_VARIANCE');
    expect(rate?.variancePct).toBe('0.0370'); // +3.70%
    expect(rate?.impactWithTax).toBe('944.0000');
    const freight = result.exceptions.find((e) => e.type === 'UNAUTHORISED_LINE');
    expect(freight?.impactWithTax).toBe('2124.0000');
  });

  it('all-clean match → no exceptions', () => {
    const result = runMatch({
      tolerances: TOL,
      po: po([{ id: 'p1', qtyOrdered: '10', unitPrice: '100' }]),
      grn: grn([{ poLineId: 'p1', qtyAccepted: '10' }]),
      invoice: inv([{ poLineId: 'p1', qty: '10', unitPrice: '100' }]),
    });
    expect(result.matched).toBe(true);
    expect(result.exceptions).toHaveLength(0);
    expect(result.varianceTotal).toBe('0.0000');
  });

  it('quantity over tolerance → QTY_VARIANCE', () => {
    const result = runMatch({
      tolerances: TOL,
      po: po([{ id: 'p1', qtyOrdered: '100', unitPrice: '50' }]),
      grn: grn([{ poLineId: 'p1', qtyAccepted: '100' }]),
      invoice: inv([{ poLineId: 'p1', qty: '110', unitPrice: '50' }]),
    });
    expect(result.exceptions.map((e) => e.type)).toEqual(['QTY_VARIANCE']);
  });

  it('quantity under, within 1-unit tolerance → clean', () => {
    const result = runMatch({
      tolerances: TOL,
      po: po([{ id: 'p1', qtyOrdered: '10', unitPrice: '50' }]),
      grn: grn([{ poLineId: 'p1', qtyAccepted: '10' }]),
      invoice: inv([{ poLineId: 'p1', qty: '9', unitPrice: '50' }]),
    });
    expect(result.matched).toBe(true);
  });

  it('quantity variance measured against GRN accepted qty, not PO ordered qty (Slice 5→1 seam)', () => {
    const result = runMatch({
      tolerances: TOL,
      po: po([{ id: 'p1', qtyOrdered: '10', unitPrice: '50' }]),
      grn: grn([{ poLineId: 'p1', qtyAccepted: '5' }]), // only 5 accepted at receipt
      invoice: inv([{ poLineId: 'p1', qty: '10', unitPrice: '50' }]), // billed for all 10
    });
    // Against ordered qty (10) the line would be clean; against accepted qty (5)
    // the 5-unit gap exceeds max(2%, 1 unit) → the seam must use accepted qty.
    expect(result.exceptions.map((e) => e.type)).toContain('QTY_VARIANCE');
  });

  it('tax rate mismatch → TAX_VARIANCE', () => {
    const result = runMatch({
      tolerances: TOL,
      po: po([{ id: 'p1', qtyOrdered: '5', unitPrice: '100', taxRate: '0.18' }]),
      grn: grn([{ poLineId: 'p1', qtyAccepted: '5' }]),
      invoice: inv([{ poLineId: 'p1', qty: '5', unitPrice: '100', taxRate: '0.12' }]),
    });
    expect(result.exceptions.map((e) => e.type)).toEqual(['TAX_VARIANCE']);
  });

  it('rate within ±0.5% tolerance → clean', () => {
    const result = runMatch({
      tolerances: TOL,
      po: po([{ id: 'p1', qtyOrdered: '5', unitPrice: '1000' }]),
      grn: grn([{ poLineId: 'p1', qtyAccepted: '5' }]),
      invoice: inv([{ poLineId: 'p1', qty: '5', unitPrice: '1004' }]), // +0.4%
    });
    expect(result.matched).toBe(true);
  });

  it('missing PO → PO_MISSING (critical, short-circuits)', () => {
    const result = runMatch({
      tolerances: TOL,
      po: null,
      grn: null,
      invoice: inv([{ qty: '1', unitPrice: '100' }]),
    });
    expect(result.exceptions.map((e) => e.type)).toEqual(['PO_MISSING']);
    expect(result.exceptions[0]?.severity).toBe('CRITICAL');
  });

  it('missing GRN → GRN_MISSING but still matches priced lines', () => {
    const result = runMatch({
      tolerances: TOL,
      po: po([{ id: 'p1', qtyOrdered: '2', unitPrice: '100' }]),
      grn: null,
      invoice: inv([{ poLineId: 'p1', qty: '2', unitPrice: '100' }]),
    });
    expect(result.exceptions.map((e) => e.type)).toContain('GRN_MISSING');
  });

  it('duplicate invoice ref → DUPLICATE (short-circuits)', () => {
    const result = runMatch({
      tolerances: TOL,
      isDuplicate: true,
      po: po([{ id: 'p1', qtyOrdered: '1', unitPrice: '100' }]),
      grn: grn([{ poLineId: 'p1', qtyAccepted: '1' }]),
      invoice: inv([{ poLineId: 'p1', qty: '1', unitPrice: '100' }]),
    });
    expect(result.exceptions.map((e) => e.type)).toEqual(['DUPLICATE']);
  });

  it('freight line allowed when PO metadata permits → clean', () => {
    const result = runMatch({
      tolerances: TOL,
      po: po([{ id: 'p1', qtyOrdered: '1', unitPrice: '100' }], /* allowFreight */ true),
      grn: grn([{ poLineId: 'p1', qtyAccepted: '1' }]),
      invoice: inv([
        { poLineId: 'p1', qty: '1', unitPrice: '100' },
        { poLineId: null, itemDesc: 'Freight', qty: '1', unitPrice: '500' },
      ]),
    });
    expect(result.matched).toBe(true);
  });

  it('matches by normalized item description when no explicit PO link', () => {
    const result = runMatch({
      tolerances: TOL,
      po: po([{ id: 'p1', itemDesc: 'SNL  518 ', qtyOrdered: '2', unitPrice: '10800' }]),
      grn: grn([{ poLineId: 'p1', qtyAccepted: '2' }]),
      invoice: inv([
        { poLineId: null, itemDesc: ' snl 518', qty: '2', unitPrice: '11200' },
      ]),
    });
    expect(result.exceptions.map((e) => e.type)).toEqual(['RATE_VARIANCE']);
  });
});
