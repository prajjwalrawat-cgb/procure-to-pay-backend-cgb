import Decimal from 'decimal.js';

/**
 * India GST computation (Master Context §9). PURE — no I/O, no clock, no Prisma.
 * Shared by the backend (RequisitionValidator, PO totals) and the frontend
 * (live line/PR totals). Unit-tested to full coverage.
 *
 * Intra-state supply  → CGST + SGST, each half the rate.
 * Inter-state supply  → IGST at the full rate.
 * Determined by comparing the delivery plant's state code with the vendor
 * GSTIN's state code (first two digits). An unregistered dealer (URD — no
 * GSTIN) triggers reverse charge: the tax is still computed (buyer is liable)
 * but flagged so it is not charged on the vendor's invoice.
 */

export const TAX_KINDS = ['CGST_SGST', 'IGST', 'EXEMPT', 'TBD'] as const;
export type TaxKind = (typeof TAX_KINDS)[number];

/** A decimal string, e.g. "18900.00". Money never crosses the wire as a number. */
export type DecimalString = string;

export interface TaxLineInput {
  qty: DecimalString;
  unitPrice: DecimalString;
  /** Fraction, e.g. "0.05" for 5%. Defaults to 0. */
  discountPct?: DecimalString;
  /** Fraction, e.g. "0.18" for 18%. */
  taxRate: DecimalString;
}

export interface TaxContext {
  /** Delivery plant state code, e.g. "17" (Meghalaya). */
  plantStateCode: string;
  /**
   * Vendor GSTIN — first two digits are the state code. `null`/`undefined`
   * means no vendor is known yet (PR stage) → tax kind is TBD unless a
   * fallback is requested. An empty-GSTIN registered check is separate.
   */
  vendorGstin?: string | null;
  /** True when the vendor is unregistered (URD): reverse charge applies. */
  isUrd?: boolean;
  /**
   * When true (PR stage without a vendor), fall back to an intra-state estimate
   * instead of TBD, so a provisional PR total can be shown.
   */
  estimateWhenUnknown?: boolean;
}

export interface TaxLineResult {
  /** qty × unitPrice × (1 − discount), rounded to 4 dp. */
  lineSubtotal: DecimalString;
  taxRate: DecimalString;
  taxKind: TaxKind;
  cgst: DecimalString;
  sgst: DecimalString;
  igst: DecimalString;
  taxAmount: DecimalString;
  /** subtotal + taxAmount. */
  lineTotal: DecimalString;
  isReverseCharge: boolean;
}

export interface DocTaxResult {
  taxKind: TaxKind;
  subtotal: DecimalString;
  cgst: DecimalString;
  sgst: DecimalString;
  igst: DecimalString;
  taxAmount: DecimalString;
  total: DecimalString;
  isReverseCharge: boolean;
}

const ZERO = '0.0000';

function d(value: DecimalString | undefined, fallback = '0'): Decimal {
  return new Decimal(value ?? fallback);
}

function stateOf(gstin: string | null | undefined): string | null {
  if (!gstin || gstin.length < 2) return null;
  return gstin.slice(0, 2);
}

/** Decide the tax kind for a supply given the delivery plant and vendor. */
export function determineTaxKind(ctx: TaxContext): TaxKind {
  const vendorState = stateOf(ctx.vendorGstin);
  if (vendorState === null) {
    // URD or no vendor. URD reverse charge is treated as intra-state (place of
    // supply = plant state). No vendor at all → TBD unless estimating.
    if (ctx.isUrd || ctx.estimateWhenUnknown) return 'CGST_SGST';
    return 'TBD';
  }
  return vendorState === ctx.plantStateCode ? 'CGST_SGST' : 'IGST';
}

/** Compute subtotal, tax split, and total for a single line. */
export function computeLineTax(line: TaxLineInput, ctx: TaxContext): TaxLineResult {
  const qty = d(line.qty);
  const unitPrice = d(line.unitPrice);
  const discount = d(line.discountPct);
  const taxRate = d(line.taxRate);

  const gross = qty.times(unitPrice);
  const subtotal = gross.times(new Decimal(1).minus(discount));
  const kind = determineTaxKind(ctx);
  const isReverseCharge = ctx.isUrd === true;

  let cgst = new Decimal(0);
  let sgst = new Decimal(0);
  let igst = new Decimal(0);

  if (kind === 'CGST_SGST') {
    const half = subtotal.times(taxRate).dividedBy(2);
    cgst = half;
    sgst = half;
  } else if (kind === 'IGST') {
    igst = subtotal.times(taxRate);
  }
  // EXEMPT / TBD → no tax split (TBD is resolved at PO stage).

  const taxAmount = cgst.plus(sgst).plus(igst);
  const lineTotal = subtotal.plus(taxAmount);

  return {
    lineSubtotal: subtotal.toFixed(4),
    taxRate: taxRate.toFixed(4),
    taxKind: kind,
    cgst: cgst.toFixed(4),
    sgst: sgst.toFixed(4),
    igst: igst.toFixed(4),
    taxAmount: taxAmount.toFixed(4),
    lineTotal: lineTotal.toFixed(4),
    isReverseCharge,
  };
}

/** Aggregate a document's lines into subtotal, tax split, and total. */
export function computeDocTax(lines: TaxLineInput[], ctx: TaxContext): DocTaxResult {
  let subtotal = new Decimal(0);
  let cgst = new Decimal(0);
  let sgst = new Decimal(0);
  let igst = new Decimal(0);
  const kind = determineTaxKind(ctx);

  for (const line of lines) {
    const r = computeLineTax(line, ctx);
    subtotal = subtotal.plus(r.lineSubtotal);
    cgst = cgst.plus(r.cgst);
    sgst = sgst.plus(r.sgst);
    igst = igst.plus(r.igst);
  }

  const taxAmount = cgst.plus(sgst).plus(igst);
  return {
    taxKind: kind,
    subtotal: subtotal.toFixed(4),
    cgst: cgst.toFixed(4),
    sgst: sgst.toFixed(4),
    igst: igst.toFixed(4),
    taxAmount: taxAmount.toFixed(4),
    total: subtotal.plus(taxAmount).toFixed(4),
    isReverseCharge: ctx.isUrd === true,
  };
}

/** Human label for a tax kind (used by PDF + UI). */
export function taxKindLabel(kind: TaxKind): string {
  switch (kind) {
    case 'CGST_SGST':
      return 'CGST + SGST';
    case 'IGST':
      return 'IGST';
    case 'EXEMPT':
      return 'Exempt';
    case 'TBD':
      return 'TBD at PO stage';
  }
}

export const TAX_ZERO = ZERO;
