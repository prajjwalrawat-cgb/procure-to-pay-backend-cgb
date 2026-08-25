import Decimal from 'decimal.js';

import {
  INVOICEABLE_PO_STATUS,
  type MatchException,
  type MatchGrnLine,
  type MatchInput,
  type MatchInvoiceLine,
  type MatchPoLine,
  type MatchResult,
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
  const { po, grn, invoice, vendor, tolerances } = input;
  const exceptions: MatchException[] = [];

  const invoiceSubtotal = sumLines(invoice.lines);

  // Runs before the short-circuits below: a blocked vendor is worth reporting
  // even on an invoice that also has no PO, and the early returns would
  // otherwise swallow it.
  checkVendor(vendor, exceptions);

  // Hard blockers short-circuit the line-by-line comparison.
  if (input.isDuplicate) {
    exceptions.push({
      type: 'DUPLICATE',
      severity: 'CRITICAL',
      impactWithTax: withTaxSubtotal(invoice.lines),
      details:
        'Another invoice from this vendor carries the same reference — either ' +
        'on the record or as printed on the document itself.',
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

  checkPoStatus(po.status, exceptions);
  checkDates(
    invoice.invoiceDate,
    po.issuedAt,
    grn?.firstReceivedAt,
    tolerances,
    exceptions,
  );
  checkDeclaredTotal(invoice.declaredTotal, invoice.lines, tolerances, exceptions);
  checkDocumentHeader(invoice, exceptions);

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

    // Units first: everything below compares quantities and per-unit rates, and
    // neither means anything until both documents are talking about the same
    // unit. Where the item has a conversion the caller has already applied it;
    // where it has not, the line is reported and left uncompared rather than
    // measured against a number in different units.
    const compare = reconcileUom(line, poLine);
    if (!compare) {
      exceptions.push({
        type: 'UOM_MISMATCH',
        severity: 'HIGH',
        poLineId: poLine.id,
        invoiceLineId: line.id,
        expected: poLine.uom,
        actual: line.uom,
        impactWithTax: '0.0000',
        details:
          `Line "${line.itemDesc}" is billed in ${line.uom} but was ordered in ` +
          `${poLine.uom}, and no conversion is defined for this item. Quantity ` +
          'and rate could not be checked.',
      });
      continue;
    }

    checkRate(line, poLine, compare, tolerances.priceVariancePct, exceptions);
    checkQty(line, poLine, compare, grnByPoLine.get(poLine.id), tolerances, exceptions);
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
  compare: UomCompare,
  pricePct: string,
  out: MatchException[],
): void {
  const invUnit = compare.unitPrice;
  const poUnit = new Decimal(poLine.unitPrice);
  if (poUnit.isZero()) return;
  const variancePct = invUnit.minus(poUnit).dividedBy(poUnit);
  if (variancePct.abs().greaterThan(pricePct)) {
    const expected = poUnit.times(compare.qty);
    const actual = invUnit.times(compare.qty);
    out.push({
      type: 'RATE_VARIANCE',
      severity: 'HIGH',
      poLineId: poLine.id,
      invoiceLineId: line.id,
      expected: expected.toFixed(4),
      actual: actual.toFixed(4),
      variancePct: variancePct.toFixed(4),
      impactWithTax: actual.minus(expected).times(taxFactor(line.taxRate)).toFixed(4),
      details:
        `Unit price ₹${invUnit.toFixed(2)}${compare.converted ? ` per ${poLine.uom}` : ''}` +
        ` exceeds PO price ₹${poUnit.toFixed(2)} by ${variancePct.times(100).toFixed(2)}%.`,
    });
  }
}

function checkQty(
  line: MatchInvoiceLine,
  poLine: MatchPoLine,
  compare: UomCompare,
  grnLine: MatchGrnLine | undefined,
  t: MatchInput['tolerances'],
  out: MatchException[],
): void {
  const invQty = compare.qty;
  // Basis = accepted quantity on the GRN if received, else the PO quantity —
  // MINUS whatever other live invoices have already billed against this line.
  //
  // The subtraction is what makes this a real three-way match. Scoring each
  // invoice against the full received/ordered quantity treats every invoice as
  // if it were the first: 200 billed against 200 received passes, and so does
  // the next 200, and the next. Netting off prior billing means a line can be
  // invoiced up to what was actually received and no further, which is the
  // control that stops both over-billing and the same receipt being billed
  // twice. Legitimate partial billing is unaffected — each delivery opens up
  // exactly its own quantity.
  //
  // Clamped at zero: a line already fully billed has no remaining basis, so any
  // further invoice is the full quantity over.
  const received = grnLine
    ? new Decimal(grnLine.qtyAccepted)
    : new Decimal(poLine.qtyOrdered);
  const alreadyInvoiced = new Decimal(poLine.qtyAlreadyInvoiced ?? '0');
  const basis = Decimal.max(received.minus(alreadyInvoiced), new Decimal(0));

  /*
   * One-sided: only billing MORE than remains is a finding.
   *
   * The comparison used to be symmetric, which made sense when the basis was
   * the whole received quantity — billing a different amount than was received
   * was worth a look either way. It stopped making sense the moment the basis
   * became what is still UNBILLED, because then billing less than the remainder
   * is just a partial invoice, and a supplier is entitled to send several. Under
   * the symmetric test the first invoice on any part-billed order flagged: 200
   * against 1000 remaining reads as an 800 variance, which is not a variance at
   * all, it is 800 still to come.
   *
   * Under-billing is also not a risk worth an exception. The buyer is charged
   * less than they could have been; the balance stays available on the line and
   * shows up in the billed/remaining figures on the invoice and the PO.
   */
  const over = invQty.minus(basis);
  const tolerance = Decimal.max(
    basis.times(t.qtyVariancePct),
    new Decimal(t.qtyVarianceAbs),
  );
  if (over.greaterThan(tolerance)) {
    const invUnit = compare.unitPrice;
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
      details: alreadyInvoiced.isZero()
        ? `Invoiced qty ${invQty.toFixed(2)} differs from received/ordered qty ${basis.toFixed(2)}.`
        : `Invoiced qty ${invQty.toFixed(2)} exceeds the ${basis.toFixed(2)} still unbilled on this line ` +
          `(${received.toFixed(2)} received/ordered, ${alreadyInvoiced.toFixed(2)} already invoiced).`,
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

function checkVendor(vendor: MatchInput['vendor'], out: MatchException[]): void {
  const status = vendor?.lifecycleStatus;
  if (!status) return;
  if (status !== 'SUSPENDED' && status !== 'BLACKLISTED' && status !== 'ARCHIVED') {
    return;
  }
  out.push({
    type: 'VENDOR_BLOCKED',
    severity: 'CRITICAL',
    impactWithTax: '0.0000',
    details:
      `This vendor is ${humanStatus(status)}; new invoices should not be paid ` +
      'without reinstating them first.',
  });
}

function checkPoStatus(status: string | null | undefined, out: MatchException[]): void {
  // Absent on callers that predate this check — skip rather than guess. Never
  // treat "we were not told" as "the order is open".
  if (!status) return;
  if ((INVOICEABLE_PO_STATUS as readonly string[]).includes(status)) return;

  // CANCELLED is the only one that can never become legitimate: the order was
  // withdrawn, so nothing is owed under it. The rest are recoverable states — a
  // draft gets issued, a hold gets released — so they are HIGH, not CRITICAL.
  const cancelled = status === 'CANCELLED';
  out.push({
    type: 'PO_NOT_OPEN',
    severity: cancelled ? 'CRITICAL' : 'HIGH',
    impactWithTax: '0.0000',
    details: cancelled
      ? 'The purchase order was cancelled; it cannot be invoiced against.'
      : `The purchase order is ${humanStatus(status)} and is not open for ` +
        'invoicing. An invoice against it was not expected yet.',
  });
}

/**
 * Date sequence: goods are ordered, then received, then billed. An invoice that
 * predates its own PO is either back-dated or attached to the wrong order; one
 * that predates the first receipt on the PO bills for goods that had not
 * arrived.
 *
 * At most ONE exception is raised, the more severe first. Two document-level
 * exceptions of the same type would collide in the caller's dedupe key
 * (`type:invoiceLineId:poLineId`, both null here) and the second would silently
 * overwrite the first — and predating the PO all but implies predating the
 * receipt anyway, so the PO finding is the one worth surfacing.
 */
function checkDates(
  invoiceDate: string | null | undefined,
  poIssuedAt: string | null | undefined,
  firstReceivedAt: string | null | undefined,
  t: MatchInput['tolerances'],
  out: MatchException[],
): void {
  const inv = parseDate(invoiceDate);
  if (!inv) return;
  const graceMs = Number(t.dateGraceDays ?? '1') * 86_400_000;

  const issued = parseDate(poIssuedAt);
  if (issued && inv.getTime() < issued.getTime() - graceMs) {
    out.push({
      type: 'DATE_SEQUENCE',
      severity: 'HIGH',
      impactWithTax: '0.0000',
      details:
        `Invoice is dated ${fmtDate(inv)}, before the purchase order was issued ` +
        `on ${fmtDate(issued)}.`,
    });
    return;
  }

  const received = parseDate(firstReceivedAt);
  if (received && inv.getTime() < received.getTime() - graceMs) {
    out.push({
      type: 'DATE_SEQUENCE',
      severity: 'MEDIUM',
      impactWithTax: '0.0000',
      details:
        `Invoice is dated ${fmtDate(inv)}, before the first goods receipt on ` +
        `this order (${fmtDate(received)}) — it bills for goods that had not ` +
        'been received.',
    });
  }
}

/**
 * The total PRINTED on the document against the sum of its own line items.
 *
 * This is the only check that can catch OCR losing or misreading a line. Every
 * other number on the invoice record is *derived* from the lines — the stored
 * gross is the line sum by construction — so it agrees with a bad extraction as
 * happily as a good one. The vendor's own printed total is the independent
 * witness, and comparing the two is what makes an extraction verifiable rather
 * than merely plausible.
 *
 * Skipped when the provider returned no total. That is a real limitation, not a
 * pass: an invoice whose printed total was never captured has not been checked,
 * and the UI says so rather than showing a clean result.
 */
function checkDeclaredTotal(
  declaredTotal: string | null | undefined,
  lines: MatchInvoiceLine[],
  t: MatchInput['tolerances'],
  out: MatchException[],
): void {
  if (declaredTotal == null || declaredTotal === '') return;
  const declared = new Decimal(declaredTotal);
  if (!declared.isFinite() || declared.lessThanOrEqualTo(0)) return;

  const computed = new Decimal(withTaxSubtotal(lines));
  const diff = declared.minus(computed);
  // Vendors round per line, per tax head, or at the foot, so a genuine document
  // is routinely off by paise.
  const tolerance = new Decimal(t.amountRoundingAbs ?? '1');
  if (diff.abs().lessThanOrEqualTo(tolerance)) return;

  out.push({
    type: 'AMOUNT_MISMATCH',
    severity: 'HIGH',
    expected: declared.toFixed(4),
    actual: computed.toFixed(4),
    // Real, unexplained money: the gap between what the document claims and what
    // its own lines account for. Nothing else in the result measures it.
    impactWithTax: diff.toFixed(4),
    details:
      `The total printed on the document, ₹${declared.toFixed(2)}, does not match ` +
      `the ₹${computed.toFixed(2)} its line items add up to (difference ` +
      `₹${diff.toFixed(2)}). A line may have been misread or missed.`,
  });
}

/**
 * Quantity and per-unit price restated in the PO line's unit, or null when the
 * units differ and nothing can bridge them.
 */
interface UomCompare {
  qty: Decimal;
  unitPrice: Decimal;
  /** True when a conversion was applied. */
  converted: boolean;
}

/**
 * Puts an invoice line and its PO line into the same unit.
 *
 * 200 KG billed against a line ordered in TONNE agrees on quantity and on rate
 * and is wrong by a factor of a thousand — but billing in a different unit is
 * also perfectly ordinary here, and GRN already accepts receipts that way,
 * converting through the item's `ItemUomConversion` edges. So a bare mismatch
 * is not the finding; a mismatch *nothing can reconcile* is.
 *
 * Three outcomes:
 *   • same unit (through `canonicalUom`, which folds spellings) → compare as-is
 *   • different unit, caller supplied `qtyInPoUom` → convert both the quantity
 *     and the rate into PO units, so ₹100/KG against ₹100,000/TONNE agrees
 *   • different unit, no conversion → null, and the caller raises UOM_MISMATCH
 */
function reconcileUom(line: MatchInvoiceLine, poLine: MatchPoLine): UomCompare | null {
  const qty = new Decimal(line.qty);
  const unitPrice = new Decimal(line.unitPrice);

  const invUom = canonicalUom(line.uom);
  const poUom = canonicalUom(poLine.uom);
  if (!invUom || !poUom || invUom === poUom) {
    return { qty, unitPrice, converted: false };
  }

  if (line.qtyInPoUom == null || line.qtyInPoUom === '') return null;
  const inPoUom = new Decimal(line.qtyInPoUom);
  if (!inPoUom.isFinite() || inPoUom.lessThanOrEqualTo(0)) return null;

  // Rate follows the quantity: the line total is invariant, so the price per
  // PO unit is that total divided by the converted quantity.
  return {
    qty: inPoUom,
    unitPrice: qty.times(unitPrice).dividedBy(inPoUom),
    converted: true,
  };
}

/**
 * What the document says about itself against what this record says about it.
 *
 * The record's invoice date and vendor reference are not always claims about the
 * document: an emailed invoice arrives with the date of receipt and the message
 * subject standing in until it is read. Where a person did type them, a document
 * that disagrees is a real finding — a mis-keyed invoice number defeats duplicate
 * detection, and a mis-keyed date moves an MSME due date and the interest that
 * hangs off it.
 *
 * One exception covering both fields, not one each: two document-level exceptions
 * of the same type collide in the caller's dedupe key (`type:invoiceLineId:
 * poLineId`, both null here) and the second silently overwrites the first.
 */
function checkDocumentHeader(
  invoice: MatchInput['invoice'],
  out: MatchException[],
): void {
  const parts: string[] = [];

  const recordDate = parseDate(invoice.invoiceDate);
  const printedDate = parseDate(invoice.declaredInvoiceDate);
  if (recordDate && printedDate && !sameUtcDay(recordDate, printedDate)) {
    parts.push(
      `it is dated ${fmtDate(printedDate)}, but this record says ` +
        `${fmtDate(recordDate)}`,
    );
  }

  const recordRef = canonicalRef(invoice.vendorInvoiceRef);
  const printedRef = canonicalRef(invoice.declaredVendorRef);
  if (recordRef && printedRef && recordRef !== printedRef) {
    parts.push(
      `its number reads "${invoice.declaredVendorRef}", but this record says ` +
        `"${invoice.vendorInvoiceRef}"`,
    );
  }

  if (parts.length === 0) return;
  out.push({
    type: 'DOCUMENT_MISMATCH',
    severity: 'HIGH',
    impactWithTax: '0.0000',
    details: `The document disagrees with this record: ${parts.join('; ')}.`,
  });
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

/**
 * Folds spellings of the same unit onto one token. Deliberately conservative:
 * every group below is one unit written more than one way, never two units that
 * merely tend to be used interchangeably. Anything unlisted is returned
 * normalised but unmapped, so it compares exactly — an unrecognised pair is
 * surfaced, not silently accepted.
 *
 * Tenant-specific aliases belong in a settings table rather than here; this is
 * the floor that stops KG-billed-against-TONNE, not a complete UOM registry.
 */
const UOM_SYNONYMS: Record<string, string> = {
  EA: 'EA',
  EACH: 'EA',
  NO: 'EA',
  NOS: 'EA',
  NUMBER: 'EA',
  NUMBERS: 'EA',
  PC: 'EA',
  PCS: 'EA',
  PIECE: 'EA',
  PIECES: 'EA',
  UNIT: 'EA',
  UNITS: 'EA',
  KG: 'KG',
  KGS: 'KG',
  KILO: 'KG',
  KILOS: 'KG',
  KILOGRAM: 'KG',
  KILOGRAMS: 'KG',
  MT: 'MT',
  TON: 'MT',
  TONS: 'MT',
  TONNE: 'MT',
  TONNES: 'MT',
  G: 'G',
  GM: 'G',
  GMS: 'G',
  GRAM: 'G',
  GRAMS: 'G',
  L: 'L',
  LTR: 'L',
  LTRS: 'L',
  LITRE: 'L',
  LITRES: 'L',
  LITER: 'L',
  LITERS: 'L',
  M: 'M',
  MTR: 'M',
  MTRS: 'M',
  METRE: 'M',
  METRES: 'M',
  METER: 'M',
  METERS: 'M',
  BOX: 'BOX',
  BOXES: 'BOX',
  BX: 'BOX',
  BAG: 'BAG',
  BAGS: 'BAG',
  ROLL: 'ROLL',
  ROLLS: 'ROLL',
  SET: 'SET',
  SETS: 'SET',
  PAIR: 'PAIR',
  PAIRS: 'PAIR',
  PR: 'PAIR',
  LOT: 'LOT',
  LOTS: 'LOT',
};

/** Upper-cased, punctuation-stripped, then folded through UOM_SYNONYMS. */
function canonicalUom(uom: string | null | undefined): string | null {
  if (!uom) return null;
  const norm = uom
    .trim()
    .toUpperCase()
    .replace(/[.\s]+/g, '');
  if (!norm) return null;
  return UOM_SYNONYMS[norm] ?? norm;
}

/** Calendar-day equality in UTC — a time-of-day difference is not a mismatch. */
function sameUtcDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

/**
 * Invoice numbers for comparison: upper-cased with punctuation and spacing
 * removed, so "PES/2026/4471" and "PES-2026-4471" are the same reference. Only
 * an actual difference in the characters that carry meaning is reported.
 */
function canonicalRef(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const norm = ref.toUpperCase().replace(/[^A-Z0-9]+/g, '');
  return norm.length > 0 ? norm : null;
}

/** Parses an ISO date, returning null for absent or unparseable values. */
function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** dd/mm/yyyy in UTC — stable regardless of where the engine runs. */
function fmtDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

/** PARTIALLY_RECEIVED -> "partially received". */
function humanStatus(status: string): string {
  return status.toLowerCase().replace(/_/g, ' ');
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
