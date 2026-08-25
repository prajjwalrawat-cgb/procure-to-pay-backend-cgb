import { describe, expect, it } from 'vitest';

import { runMatch } from './match-engine';
import {
  INVOICEABLE_PO_STATUS,
  type MatchInput,
  type MatchInvoiceLine,
  type MatchPoLine,
  type MatchTolerances,
} from './types';

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
      qtyAlreadyInvoiced: l.qtyAlreadyInvoiced,
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
      qtyInPoUom: l.qtyInPoUom,
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

  // ── Cumulative billing (three-way match, not two-way) ───────────────────
  // Each invoice used to be scored against the full received/ordered quantity,
  // so a vendor could bill the same receipt repeatedly and every invoice passed
  // on its own. These cover the netting-off.

  it('partial billing against a larger PO → clean', () => {
    const result = runMatch({
      tolerances: TOL,
      po: po([{ id: 'p1', qtyOrdered: '1000', unitPrice: '450' }]),
      grn: grn([{ poLineId: 'p1', qtyAccepted: '200' }]),
      invoice: inv([{ poLineId: 'p1', qty: '200', unitPrice: '450' }]),
    });
    expect(result.exceptions.map((e) => e.type)).not.toContain('QTY_VARIANCE');
  });

  it('second invoice billing the same receipt again → QTY_VARIANCE', () => {
    const result = runMatch({
      tolerances: TOL,
      po: po([
        { id: 'p1', qtyOrdered: '1000', unitPrice: '450', qtyAlreadyInvoiced: '200' },
      ]),
      grn: grn([{ poLineId: 'p1', qtyAccepted: '200' }]),
      invoice: inv([{ poLineId: 'p1', qty: '200', unitPrice: '450' }]),
    });
    expect(result.exceptions.map((e) => e.type)).toContain('QTY_VARIANCE');
  });

  it('a further delivery opens up its own quantity → clean', () => {
    const result = runMatch({
      tolerances: TOL,
      po: po([
        { id: 'p1', qtyOrdered: '1000', unitPrice: '450', qtyAlreadyInvoiced: '200' },
      ]),
      // 400 received in total now; 200 already billed leaves 200 billable.
      grn: grn([{ poLineId: 'p1', qtyAccepted: '400' }]),
      invoice: inv([{ poLineId: 'p1', qty: '200', unitPrice: '450' }]),
    });
    expect(result.exceptions.map((e) => e.type)).not.toContain('QTY_VARIANCE');
  });

  it('cumulative billing beyond the ordered qty with no GRN → QTY_VARIANCE', () => {
    const result = runMatch({
      tolerances: TOL,
      po: po([
        { id: 'p1', qtyOrdered: '1000', unitPrice: '450', qtyAlreadyInvoiced: '1000' },
      ]),
      grn: null,
      invoice: inv([{ poLineId: 'p1', qty: '200', unitPrice: '450' }]),
    });
    expect(result.exceptions.map((e) => e.type)).toContain('QTY_VARIANCE');
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

  // ── controls added in Slice 15 ───────────────────────────────────────────
  // Each of these passed the matcher clean before the corresponding check
  // existed; the first assertion in every block is the one that used to fail.

  describe('unit of measure', () => {
    it('flags KG billed against TONNE when no conversion is defined', () => {
      const result = runMatch({
        tolerances: TOL,
        po: po([{ id: 'p1', uom: 'TONNE', qtyOrdered: '200', unitPrice: '100' }]),
        grn: grn([{ poLineId: 'p1', qtyAccepted: '200' }]),
        invoice: inv([{ poLineId: 'p1', uom: 'KG', qty: '200', unitPrice: '100' }]),
      });
      // Quantity and rate agree exactly — UOM is the only thing that catches it.
      expect(result.exceptions.map((e) => e.type)).toEqual(['UOM_MISMATCH']);
      expect(result.exceptions[0]).toMatchObject({
        severity: 'HIGH',
        expected: 'TONNE',
        actual: 'KG',
      });
    });

    it('does not raise rate or quantity findings on an unreconcilable line', () => {
      // Comparing 200 KG against 0.2 TONNE would report a wild quantity
      // variance that says nothing useful. One finding, naming the real cause.
      const result = runMatch({
        tolerances: TOL,
        po: po([{ id: 'p1', uom: 'TONNE', qtyOrdered: '0.2', unitPrice: '100000' }]),
        grn: grn([{ poLineId: 'p1', qtyAccepted: '0.2' }]),
        invoice: inv([{ poLineId: 'p1', uom: 'KG', qty: '200', unitPrice: '100' }]),
      });
      expect(result.exceptions.map((e) => e.type)).toEqual(['UOM_MISMATCH']);
    });

    it('converts instead of flagging when the caller supplies a conversion', () => {
      // 200 KG @ ₹100/KG billed against 0.2 TONNE @ ₹100,000/TONNE. Same goods,
      // same money — GRN already accepts receipts booked this way, so an
      // invoice must not be rejected for it.
      const result = runMatch({
        tolerances: TOL,
        po: po([{ id: 'p1', uom: 'TONNE', qtyOrdered: '0.2', unitPrice: '100000' }]),
        grn: grn([{ poLineId: 'p1', qtyAccepted: '0.2' }]),
        invoice: inv([
          {
            poLineId: 'p1',
            uom: 'KG',
            qty: '200',
            unitPrice: '100',
            qtyInPoUom: '0.2',
          },
        ]),
      });
      expect(result.exceptions).toEqual([]);
    });

    it('still catches a rate variance through a conversion', () => {
      // 200 KG @ ₹110/KG = ₹110,000/TONNE against a PO at ₹100,000/TONNE.
      const result = runMatch({
        tolerances: TOL,
        po: po([{ id: 'p1', uom: 'TONNE', qtyOrdered: '0.2', unitPrice: '100000' }]),
        grn: grn([{ poLineId: 'p1', qtyAccepted: '0.2' }]),
        invoice: inv([
          {
            poLineId: 'p1',
            uom: 'KG',
            qty: '200',
            unitPrice: '110',
            qtyInPoUom: '0.2',
          },
        ]),
      });
      expect(result.exceptions.map((e) => e.type)).toEqual(['RATE_VARIANCE']);
      expect(result.exceptions[0].details).toContain('per TONNE');
    });

    it('still catches an over-billed quantity through a conversion', () => {
      // 15 TONNE billed against 10 received. Sized above `qtyVarianceAbs`
      // deliberately: that tolerance is a flat 1 unit regardless of the unit,
      // so on a 0.2 TONNE order it allows five times the order through. Real
      // gap, but a tenant policy call rather than something to change here.
      const result = runMatch({
        tolerances: TOL,
        po: po([{ id: 'p1', uom: 'TONNE', qtyOrdered: '10', unitPrice: '100000' }]),
        grn: grn([{ poLineId: 'p1', qtyAccepted: '10' }]),
        invoice: inv([
          {
            poLineId: 'p1',
            uom: 'KG',
            qty: '15000',
            unitPrice: '100',
            qtyInPoUom: '15',
          },
        ]),
      });
      expect(result.exceptions.map((e) => e.type)).toEqual(['QTY_VARIANCE']);
    });

    it('accepts spellings of the same unit', () => {
      for (const [poUom, invUom] of [
        ['EA', 'Nos.'],
        ['NOS', 'PCS'],
        ['KG', 'Kgs'],
        ['MT', 'Tonnes'],
        ['LTR', 'Litre'],
      ]) {
        const result = runMatch({
          tolerances: TOL,
          po: po([{ id: 'p1', uom: poUom, qtyOrdered: '1', unitPrice: '100' }]),
          grn: grn([{ poLineId: 'p1', qtyAccepted: '1' }]),
          invoice: inv([{ poLineId: 'p1', uom: invUom, qty: '1', unitPrice: '100' }]),
        });
        expect(result.exceptions, `${poUom} vs ${invUom}`).toEqual([]);
      }
    });

    it('reports an unrecognised unit pairing rather than assuming equivalence', () => {
      const result = runMatch({
        tolerances: TOL,
        po: po([{ id: 'p1', uom: 'DRUM', qtyOrdered: '1', unitPrice: '100' }]),
        grn: grn([{ poLineId: 'p1', qtyAccepted: '1' }]),
        invoice: inv([{ poLineId: 'p1', uom: 'CARBOY', qty: '1', unitPrice: '100' }]),
      });
      expect(result.exceptions.map((e) => e.type)).toEqual(['UOM_MISMATCH']);
    });
  });

  describe('purchase order status', () => {
    it('flags an invoice against a CANCELLED order as CRITICAL', () => {
      const result = runMatch({
        tolerances: TOL,
        po: { ...po([{ id: 'p1' }])!, status: 'CANCELLED' },
        grn: grn([{ poLineId: 'p1', qtyAccepted: '1' }]),
        invoice: inv([{ poLineId: 'p1' }]),
      });
      expect(result.exceptions.map((e) => e.type)).toEqual(['PO_NOT_OPEN']);
      expect(result.exceptions[0].severity).toBe('CRITICAL');
    });

    it('flags a not-yet-issued order as HIGH, not CRITICAL', () => {
      const result = runMatch({
        tolerances: TOL,
        po: { ...po([{ id: 'p1' }])!, status: 'DRAFT' },
        grn: grn([{ poLineId: 'p1', qtyAccepted: '1' }]),
        invoice: inv([{ poLineId: 'p1' }]),
      });
      expect(result.exceptions[0]).toMatchObject({
        type: 'PO_NOT_OPEN',
        severity: 'HIGH',
      });
    });

    it('passes every status an order may legitimately be invoiced against', () => {
      for (const status of INVOICEABLE_PO_STATUS) {
        const result = runMatch({
          tolerances: TOL,
          po: { ...po([{ id: 'p1' }])!, status },
          grn: grn([{ poLineId: 'p1', qtyAccepted: '1' }]),
          invoice: inv([{ poLineId: 'p1' }]),
        });
        expect(result.exceptions, status).toEqual([]);
      }
    });

    it('skips the check when the caller did not supply a status', () => {
      const result = runMatch({
        tolerances: TOL,
        po: po([{ id: 'p1' }]),
        grn: grn([{ poLineId: 'p1', qtyAccepted: '1' }]),
        invoice: inv([{ poLineId: 'p1' }]),
      });
      expect(result.matched).toBe(true);
    });
  });

  describe('date sequence', () => {
    const dated = (
      invoiceDate: string,
      extra: Partial<MatchInput['invoice']> = {},
    ): MatchInput['invoice'] => ({ ...inv([{ poLineId: 'p1' }]), invoiceDate, ...extra });

    it('flags an invoice dated before the purchase order was issued', () => {
      const result = runMatch({
        tolerances: TOL,
        po: { ...po([{ id: 'p1' }])!, issuedAt: '2026-03-10T00:00:00.000Z' },
        grn: grn([{ poLineId: 'p1', qtyAccepted: '1' }]),
        invoice: dated('2026-03-01T00:00:00.000Z'),
      });
      expect(result.exceptions.map((e) => e.type)).toEqual(['DATE_SEQUENCE']);
      expect(result.exceptions[0].severity).toBe('HIGH');
      expect(result.exceptions[0].details).toContain('01/03/2026');
    });

    it('flags an invoice dated before the first goods receipt', () => {
      const result = runMatch({
        tolerances: TOL,
        po: { ...po([{ id: 'p1' }])!, issuedAt: '2026-03-01T00:00:00.000Z' },
        grn: {
          ...grn([{ poLineId: 'p1', qtyAccepted: '1' }])!,
          firstReceivedAt: '2026-03-20T00:00:00.000Z',
        },
        invoice: dated('2026-03-05T00:00:00.000Z'),
      });
      expect(result.exceptions.map((e) => e.type)).toEqual(['DATE_SEQUENCE']);
      expect(result.exceptions[0].severity).toBe('MEDIUM');
    });

    it('raises only the PO finding when an invoice predates both', () => {
      // Two document-level exceptions of one type would collide in the caller's
      // dedupe key and the second would overwrite the first.
      const result = runMatch({
        tolerances: TOL,
        po: { ...po([{ id: 'p1' }])!, issuedAt: '2026-03-10T00:00:00.000Z' },
        grn: {
          ...grn([{ poLineId: 'p1', qtyAccepted: '1' }])!,
          firstReceivedAt: '2026-03-20T00:00:00.000Z',
        },
        invoice: dated('2026-03-01T00:00:00.000Z'),
      });
      expect(result.exceptions).toHaveLength(1);
      expect(result.exceptions[0].severity).toBe('HIGH');
    });

    it('tolerates a same-day clock artefact', () => {
      const result = runMatch({
        tolerances: TOL,
        po: { ...po([{ id: 'p1' }])!, issuedAt: '2026-03-10T18:00:00.000Z' },
        grn: grn([{ poLineId: 'p1', qtyAccepted: '1' }]),
        invoice: dated('2026-03-10T09:00:00.000Z'),
      });
      expect(result.exceptions).toEqual([]);
    });

    it('does not flag an invoice that follows a later partial delivery', () => {
      const result = runMatch({
        tolerances: TOL,
        po: { ...po([{ id: 'p1' }])!, issuedAt: '2026-03-01T00:00:00.000Z' },
        grn: {
          ...grn([{ poLineId: 'p1', qtyAccepted: '1' }])!,
          firstReceivedAt: '2026-03-05T00:00:00.000Z',
        },
        invoice: dated('2026-03-08T00:00:00.000Z'),
      });
      expect(result.exceptions).toEqual([]);
    });
  });

  describe('printed total vs line items', () => {
    const withTotal = (declaredTotal: string | null): MatchInput['invoice'] => ({
      ...inv([{ poLineId: 'p1', qty: '1', unitPrice: '1000', taxRate: '0.18' }]),
      declaredTotal,
    });
    const base = {
      tolerances: TOL,
      po: po([{ id: 'p1', qtyOrdered: '1', unitPrice: '1000' }]),
      grn: grn([{ poLineId: 'p1', qtyAccepted: '1' }]),
    };

    it('flags a document whose printed total exceeds its own lines', () => {
      // As if OCR dropped a line: the foot of the document says more than the
      // lines we read. Every other check passes, because every other number is
      // derived from those same lines.
      const result = runMatch({ ...base, invoice: withTotal('2360.00') });
      expect(result.exceptions.map((e) => e.type)).toEqual(['AMOUNT_MISMATCH']);
      expect(result.exceptions[0]).toMatchObject({
        severity: 'HIGH',
        expected: '2360.0000',
        actual: '1180.0000',
        impactWithTax: '1180.0000',
      });
    });

    it('accepts rounding of a rupee or less', () => {
      const result = runMatch({ ...base, invoice: withTotal('1180.65') });
      expect(result.exceptions).toEqual([]);
    });

    it('flags a shortfall as well as an overstatement', () => {
      const result = runMatch({ ...base, invoice: withTotal('900.00') });
      expect(result.exceptions.map((e) => e.type)).toEqual(['AMOUNT_MISMATCH']);
      expect(result.exceptions[0].impactWithTax).toBe('-280.0000');
    });

    it('skips the check when no total was captured, rather than passing it', () => {
      // The distinction that matters: "the document agrees" vs "we never read
      // what the document says". Both produce no exception here, so the UI is
      // what has to tell them apart.
      const result = runMatch({ ...base, invoice: withTotal(null) });
      expect(result.exceptions).toEqual([]);
    });
  });

  describe('vendor standing', () => {
    it('flags an invoice from a blacklisted vendor as CRITICAL', () => {
      const result = runMatch({
        tolerances: TOL,
        vendor: { lifecycleStatus: 'BLACKLISTED' },
        po: po([{ id: 'p1' }]),
        grn: grn([{ poLineId: 'p1', qtyAccepted: '1' }]),
        invoice: inv([{ poLineId: 'p1' }]),
      });
      expect(result.exceptions.map((e) => e.type)).toEqual(['VENDOR_BLOCKED']);
      expect(result.exceptions[0].severity).toBe('CRITICAL');
    });

    it('survives the PO_MISSING short-circuit', () => {
      // The early return would otherwise swallow it, and an invoice with no PO
      // from a suspended vendor is exactly when both facts matter.
      const result = runMatch({
        tolerances: TOL,
        vendor: { lifecycleStatus: 'SUSPENDED' },
        po: null,
        grn: null,
        invoice: inv([{ poLineId: null }]),
      });
      expect(result.exceptions.map((e) => e.type)).toEqual([
        'VENDOR_BLOCKED',
        'PO_MISSING',
      ]);
    });

    it('passes an active vendor', () => {
      const result = runMatch({
        tolerances: TOL,
        vendor: { lifecycleStatus: 'ACTIVE' },
        po: po([{ id: 'p1' }]),
        grn: grn([{ poLineId: 'p1', qtyAccepted: '1' }]),
        invoice: inv([{ poLineId: 'p1' }]),
      });
      expect(result.exceptions).toEqual([]);
    });
  });

  describe('document header vs record', () => {
    const base = {
      tolerances: TOL,
      po: po([{ id: 'p1' }]),
      grn: grn([{ poLineId: 'p1', qtyAccepted: '1' }]),
    };
    const header = (extra: Partial<MatchInput['invoice']>): MatchInput['invoice'] => ({
      ...inv([{ poLineId: 'p1' }]),
      invoiceDate: '2026-03-10T00:00:00.000Z',
      vendorInvoiceRef: 'PES/2026/4471',
      ...extra,
    });

    it('flags a printed date that disagrees with the record', () => {
      const result = runMatch({
        ...base,
        invoice: header({ declaredInvoiceDate: '2026-02-14T00:00:00.000Z' }),
      });
      expect(result.exceptions.map((e) => e.type)).toEqual(['DOCUMENT_MISMATCH']);
      expect(result.exceptions[0].details).toContain('dated 14/02/2026');
      expect(result.exceptions[0].details).toContain('10/03/2026');
    });

    it('flags a printed invoice number that disagrees with the record', () => {
      const result = runMatch({
        ...base,
        invoice: header({ declaredVendorRef: 'PES/2026/9999' }),
      });
      expect(result.exceptions.map((e) => e.type)).toEqual(['DOCUMENT_MISMATCH']);
      expect(result.exceptions[0].details).toContain('PES/2026/9999');
    });

    it('reports both disagreements as one exception', () => {
      // Two of the same type at document level would collide in the caller's
      // dedupe key and the second would be lost.
      const result = runMatch({
        ...base,
        invoice: header({
          declaredInvoiceDate: '2026-02-14T00:00:00.000Z',
          declaredVendorRef: 'PES/2026/9999',
        }),
      });
      expect(result.exceptions).toHaveLength(1);
      expect(result.exceptions[0].details).toContain('14/02/2026');
      expect(result.exceptions[0].details).toContain('PES/2026/9999');
    });

    it('ignores punctuation and case in the reference', () => {
      const result = runMatch({
        ...base,
        invoice: header({ declaredVendorRef: 'pes-2026-4471' }),
      });
      expect(result.exceptions).toEqual([]);
    });

    it('ignores time of day on the date', () => {
      const result = runMatch({
        ...base,
        invoice: header({ declaredInvoiceDate: '2026-03-10T18:45:00.000Z' }),
      });
      expect(result.exceptions).toEqual([]);
    });

    it('skips the check when OCR read nothing', () => {
      // Not the same as agreement. Nothing was compared, and the absence of an
      // exception here is the reason the UI has to say so.
      const result = runMatch({ ...base, invoice: header({}) });
      expect(result.exceptions).toEqual([]);
    });

    it('does not double-report through the date-sequence check', () => {
      // DATE_SEQUENCE reads the record's date, not the printed one, so a
      // back-dated document raises the header finding alone.
      const result = runMatch({
        tolerances: TOL,
        po: { ...po([{ id: 'p1' }])!, issuedAt: '2026-03-01T00:00:00.000Z' },
        grn: grn([{ poLineId: 'p1', qtyAccepted: '1' }]),
        invoice: header({ declaredInvoiceDate: '2026-02-14T00:00:00.000Z' }),
      });
      expect(result.exceptions.map((e) => e.type)).toEqual(['DOCUMENT_MISMATCH']);
    });
  });

  it('a clean invoice still matches with every new check wired in', () => {
    const result = runMatch({
      tolerances: TOL,
      vendor: { lifecycleStatus: 'ACTIVE' },
      po: {
        ...po([{ id: 'p1', uom: 'MT', qtyOrdered: '10', unitPrice: '5000' }])!,
        status: 'PARTIALLY_RECEIVED',
        issuedAt: '2026-03-01T00:00:00.000Z',
      },
      grn: {
        ...grn([{ poLineId: 'p1', qtyAccepted: '10' }])!,
        firstReceivedAt: '2026-03-05T00:00:00.000Z',
      },
      invoice: {
        ...inv([{ poLineId: 'p1', uom: 'Tonnes', qty: '10', unitPrice: '5000' }]),
        invoiceDate: '2026-03-06T00:00:00.000Z',
        vendorInvoiceRef: 'PES/2026/4471',
        declaredInvoiceDate: '2026-03-06T09:30:00.000Z',
        declaredVendorRef: 'pes-2026-4471',
        declaredTotal: '59000.00',
      },
    });
    expect(result.exceptions).toEqual([]);
    expect(result.matched).toBe(true);
  });
});
