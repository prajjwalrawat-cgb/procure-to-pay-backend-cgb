import type { ExceptionSeverity, ExceptionType } from '../constants/status';

/**
 * Domain-neutral 3-way match types (Master Context §9). Numbers crossing this
 * boundary are decimal *strings* so no precision is lost. The engine is a pure
 * function over these types — reusable by the API and any UI.
 */

export type { ExceptionSeverity };

export interface MatchTolerances {
  /** Price variance fraction, e.g. 0.005 = ±0.5%. */
  priceVariancePct: string;
  /** Quantity variance fraction, e.g. 0.02 = ±2%. */
  qtyVariancePct: string;
  /** Absolute quantity tolerance in units (whichever is greater wins). */
  qtyVarianceAbs: string;
  /** Tax must match exactly when true. */
  taxExact: boolean;
}

export interface MatchPoLine {
  id: string;
  lineNo: number;
  itemDesc: string;
  uom: string;
  qtyOrdered: string;
  unitPrice: string;
  taxRate: string;
  /**
   * Quantity already billed against this PO line by OTHER live invoices
   * (rejected and cancelled ones excluded). Without this the matcher scores
   * every invoice against the full ordered/received quantity in isolation, so
   * a vendor can bill 200 against a 1000-unit PO nine times and each invoice
   * passes on its own — 1800 units paid on a 1000-unit order. Defaults to '0'
   * so existing callers keep the previous single-invoice behaviour.
   */
  qtyAlreadyInvoiced?: string;
}

export interface MatchGrnLine {
  poLineId: string;
  qtyAccepted: string;
  qtyRejected: string;
}

export interface MatchInvoiceLine {
  id: string;
  lineNo: number;
  itemDesc: string;
  uom: string;
  qty: string;
  unitPrice: string;
  taxRate: string;
  /** Explicit PO line link when known; otherwise matched by item description. */
  poLineId?: string | null;
}

export interface MatchInput {
  po: { lines: MatchPoLine[]; allowFreightLines: boolean } | null;
  grn: { lines: MatchGrnLine[] } | null;
  invoice: { lines: MatchInvoiceLine[] };
  tolerances: MatchTolerances;
  /** True when another invoice with the same vendor ref already exists. */
  isDuplicate?: boolean;
}

export interface MatchException {
  type: ExceptionType;
  severity: ExceptionSeverity;
  poLineId?: string | null;
  invoiceLineId?: string | null;
  /** Expected value (PO/GRN basis), decimal string, when applicable. */
  expected?: string;
  /** Actual value from the invoice, decimal string, when applicable. */
  actual?: string;
  /** Signed variance fraction (actual-expected)/expected, when applicable. */
  variancePct?: string;
  /** Monetary impact of this exception incl. tax, decimal string. */
  impactWithTax: string;
  details: string;
}

export interface MatchResult {
  matched: boolean;
  exceptions: MatchException[];
  /** Sum of all exception impacts incl. tax (the headline variance). */
  varianceTotal: string;
  poSubtotal: string;
  invoiceSubtotal: string;
}
