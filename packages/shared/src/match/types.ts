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
  /**
   * Absolute rupee tolerance when comparing the total PRINTED on the document
   * against the sum of its own lines. Vendors round per line, per tax head, or
   * at the foot, so a genuine invoice is routinely off by paise. Defaults to
   * ₹1 — tight enough that a dropped or misread line cannot hide inside it.
   */
  amountRoundingAbs?: string;
  /**
   * Days of slack on date-sequence checks. An invoice dated the same day as
   * the PO but timestamped a few hours earlier is a clock artefact, not
   * back-dating. Defaults to 1.
   */
  dateGraceDays?: string;
}

/** Statuses a purchase order may legitimately be invoiced against. */
export const INVOICEABLE_PO_STATUS = [
  'ISSUED',
  'ACKNOWLEDGED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'PARTIALLY_INVOICED',
  'INVOICED',
] as const;

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
  /**
   * `qty` expressed in the PO line's unit, when the two units differ and the
   * item has a conversion defined. Resolved by the caller — the engine stays
   * pure — exactly as GRN already does for receipts booked in a different unit
   * (`GrnLine.uomConversionFactor`).
   *
   * Absent when the units agree (nothing to convert) or when no conversion
   * exists for the item. Those two cases are not the same: the second means the
   * quantities are genuinely incomparable, and the engine raises UOM_MISMATCH
   * rather than comparing numbers that mean different things.
   */
  qtyInPoUom?: string | null;
}

export interface MatchInput {
  po: {
    lines: MatchPoLine[];
    allowFreightLines: boolean;
    /** PoStatus. Absent on older callers — the status check then skips. */
    status?: string | null;
    /** When the PO was issued to the vendor, ISO 8601. */
    issuedAt?: string | null;
  } | null;
  grn: {
    lines: MatchGrnLine[];
    /**
     * Receipt date of the EARLIEST goods receipt on this PO, ISO 8601. Earliest,
     * not latest: on a part-delivered order an invoice legitimately predates
     * later receipts, so only predating the first one means nothing had arrived.
     */
    firstReceivedAt?: string | null;
  } | null;
  invoice: {
    lines: MatchInvoiceLine[];
    /** Date on the document itself, ISO 8601. */
    invoiceDate?: string | null;
    /**
     * Grand total printed on the document (incl. tax), as read by OCR. Null when
     * the provider returned none — the check skips rather than assuming a match.
     */
    declaredTotal?: string | null;
  };
  /** Vendor state at match time. Absent on older callers — check skips. */
  vendor?: {
    /** VendorLifecycleStatus. */
    lifecycleStatus?: string | null;
  } | null;
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
