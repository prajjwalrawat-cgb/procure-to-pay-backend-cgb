import Decimal from 'decimal.js';

import type {
  MatchException,
  MatchGrnLine,
  MatchInput,
  MatchInvoiceLine,
  MatchPoLine,
  MatchResult,
} from './types';

/**
 * Pure 3-way match engine (Master Context §9). Given a PO, GRN, and invoice plus
 * tenant tolerances, returns the list of exceptions and the headline variance.
 * No I/O, no Prisma — deterministic and fully unit-testable.
 *
 * Line matching is by explicit PO-line link when present, otherwise by
 * normalized item-description equality (per Slice 1: normalized-string match;
 * fuzzy/Levenshtein deferred until a test demands it).
 */
export function runMatch(input: MatchInput): MatchResult {
  const { po, grn, invoice, tolerances } = input;
  const exceptions: MatchException[] = [];

  const invoiceSubtotal = sumLines(invoice.lines);

  // Hard blockers short-circuit the line-by-line comparison.
  if (input.isDuplicate) {
    exceptions.push({
      type: 'DUPLICATE',
      severity: 'CRITICAL',
      impactWithTax: withTaxSubtotal(invoice.lines),
      details: 'An invoice with the same vendor reference already exists.',
    });
    return finalize(exceptions, '0', invoiceSubtotal);
  }

  if (!po) {
    exceptions.push({
      type: 'PO_MISSING',
      severity: 'CRITICAL',
      impactWithTax: withTaxSubtotal(invoice.lines),
      details: 'Invoice has no linked purchase order to match against.',
    });
    return finalize(exceptions, '0', invoiceSubtotal);
  }

  const poById = new Map(po.lines.map((l) => [l.id, l]));
  const poByDesc = new Map(po.lines.map((l) => [normalize(l.itemDesc), l]));
  const grnByPoLine = new Map((grn?.lines ?? []).map((l) => [l.poLineId, l]));
  const poSubtotal = sumPoLines(po.lines);

  if (!grn) {
    exceptions.push({
      type: 'GRN_MISSING',
      severity: 'HIGH',
      impactWithTax: '0.0000',
      details: 'No goods receipt note found; quantities cannot be verified.',
    });
  }

  for (const line of invoice.lines) {
    const poLine = resolvePoLine(line, poById, poByDesc);

    // Line not on the PO → unauthorised, unless freight lines are allowed.
    if (!poLine) {
      if (po.allowFreightLines) continue;
      exceptions.push({
        type: 'UNAUTHORISED_LINE',
        severity: 'HIGH',
        invoiceLineId: line.id,
        expected: '0.0000',
        actual: lineTotal(line),
        impactWithTax: withTax(lineTotal(line), line.taxRate),
        details: `Line "${line.itemDesc}" is not on the purchase order.`,
      });
      continue;
    }

    checkRate(line, poLine, tolerances.priceVariancePct, exceptions);
    checkQty(line, poLine, grnByPoLine.get(poLine.id), tolerances, exceptions);
    checkTax(line, poLine, tolerances.taxExact, exceptions);
  }

  const variance = exceptions
    .reduce((acc, e) => acc.plus(new Decimal(e.impactWithTax)), new Decimal(0))
    .toFixed(4);

  return finalize(exceptions, poSubtotal, invoiceSubtotal, variance);
}

// ── individual checks ────────────────────────────────────────────────────

function checkRate(
  line: MatchInvoiceLine,
  poLine: MatchPoLine,
  pricePct: string,
  out: MatchException[],
): void {
  const invUnit = new Decimal(line.unitPrice);
  const poUnit = new Decimal(poLine.unitPrice);
  if (poUnit.isZero()) return;
  const variancePct = invUnit.minus(poUnit).dividedBy(poUnit);
  if (variancePct.abs().greaterThan(pricePct)) {
    const expected = poUnit.times(line.qty);
    const actual = invUnit.times(line.qty);
    out.push({
      type: 'RATE_VARIANCE',
      severity: 'HIGH',
      poLineId: poLine.id,
      invoiceLineId: line.id,
      expected: expected.toFixed(4),
      actual: actual.toFixed(4),
      variancePct: variancePct.toFixed(4),
      impactWithTax: actual.minus(expected).times(taxFactor(line.taxRate)).toFixed(4),
      details: `Unit price ₹${invUnit.toFixed(2)} exceeds PO price ₹${poUnit.toFixed(2)} by ${variancePct.times(100).toFixed(2)}%.`,
    });
  }
}

function checkQty(
  line: MatchInvoiceLine,
  poLine: MatchPoLine,
  grnLine: MatchGrnLine | undefined,
  t: MatchInput['tolerances'],
  out: MatchException[],
): void {
  const invQty = new Decimal(line.qty);
  // Basis = accepted quantity on the GRN if received, else the PO quantity.
  const basis = grnLine
    ? new Decimal(grnLine.qtyAccepted)
    : new Decimal(poLine.qtyOrdered);
  const diff = invQty.minus(basis).abs();
  const tolerance = Decimal.max(
    basis.times(t.qtyVariancePct),
    new Decimal(t.qtyVarianceAbs),
  );
  if (diff.greaterThan(tolerance)) {
    const invUnit = new Decimal(line.unitPrice);
    const expected = basis.times(invUnit);
    const actual = invQty.times(invUnit);
    out.push({
      type: 'QTY_VARIANCE',
      severity: 'MEDIUM',
      poLineId: poLine.id,
      invoiceLineId: line.id,
      expected: expected.toFixed(4),
      actual: actual.toFixed(4),
      variancePct: basis.isZero()
        ? undefined
        : invQty.minus(basis).dividedBy(basis).toFixed(4),
      impactWithTax: actual.minus(expected).times(taxFactor(line.taxRate)).toFixed(4),
      details: `Invoiced qty ${invQty.toFixed(2)} differs from received/ordered qty ${basis.toFixed(2)}.`,
    });
  }
}

function checkTax(
  line: MatchInvoiceLine,
  poLine: MatchPoLine,
  taxExact: boolean,
  out: MatchException[],
): void {
  if (!taxExact) return;
  const invTax = new Decimal(line.taxRate);
  const poTax = new Decimal(poLine.taxRate);
  if (!invTax.equals(poTax)) {
    const base = new Decimal(line.qty).times(line.unitPrice);
    out.push({
      type: 'TAX_VARIANCE',
      severity: 'HIGH',
      poLineId: poLine.id,
      invoiceLineId: line.id,
      expected: poTax.toFixed(4),
      actual: invTax.toFixed(4),
      impactWithTax: base.times(invTax.minus(poTax)).toFixed(4),
      details: `Tax rate ${invTax.times(100).toFixed(2)}% differs from PO tax ${poTax.times(100).toFixed(2)}%.`,
    });
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function resolvePoLine(
  line: MatchInvoiceLine,
  byId: Map<string, MatchPoLine>,
  byDesc: Map<string, MatchPoLine>,
): MatchPoLine | undefined {
  if (line.poLineId) return byId.get(line.poLineId);
  return byDesc.get(normalize(line.itemDesc));
}

function normalize(desc: string): string {
  return desc.trim().toLowerCase().replace(/\s+/g, ' ');
}

function taxFactor(taxRate: string): Decimal {
  return new Decimal(1).plus(taxRate);
}

function lineTotal(line: MatchInvoiceLine): string {
  return new Decimal(line.qty).times(line.unitPrice).toFixed(4);
}

function withTax(amount: string, taxRate: string): string {
  return new Decimal(amount).times(taxFactor(taxRate)).toFixed(4);
}

function withTaxSubtotal(lines: MatchInvoiceLine[]): string {
  return lines
    .reduce(
      (acc, l) =>
        acc.plus(new Decimal(l.qty).times(l.unitPrice).times(taxFactor(l.taxRate))),
      new Decimal(0),
    )
    .toFixed(4);
}

function sumLines(lines: MatchInvoiceLine[]): string {
  return lines
    .reduce((acc, l) => acc.plus(new Decimal(l.qty).times(l.unitPrice)), new Decimal(0))
    .toFixed(4);
}

function sumPoLines(lines: MatchPoLine[]): string {
  return lines
    .reduce(
      (acc, l) => acc.plus(new Decimal(l.qtyOrdered).times(l.unitPrice)),
      new Decimal(0),
    )
    .toFixed(4);
}

function finalize(
  exceptions: MatchException[],
  poSubtotal: string,
  invoiceSubtotal: string,
  varianceTotal = '0.0000',
): MatchResult {
  return {
    matched: exceptions.length === 0,
    exceptions,
    varianceTotal,
    poSubtotal,
    invoiceSubtotal,
  };
}
