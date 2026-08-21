import { STOCK_TXN_TYPE, UNCATEGORIZED, type StockTxnType } from '@procureflow/shared';

/**
 * Column aliases per logical field. The legacy sheets, the parser's generated
 * CSVs and a hand-edited re-upload all spell these differently, so accept every
 * observed spelling rather than forcing the uploader to rename columns.
 */
const ALIASES: Record<string, string[]> = {
  code: ['code', 'product_code', 'sku_code'],
  name: ['name', 'product_name', 'productname', 'product'],
  category: ['category'],
  colour: ['colour', 'color'],
  // Slice 13 — the pack's printed EAN/UPC. Accepted from the spreadsheet
  // because capturing barcodes for a catalogue of hundreds is a bulk job:
  // editing them one product at a time is not a realistic rollout path.
  barcode: ['barcode', 'bar_code', 'ean', 'upc', 'gtin'],
  imageUrl: ['image_url', 'image_link', 'image'],
  unit: ['unit', 'uom'],
  reorderPoint: ['reorder_point', 'reorder_level', 'min_qty'],
  expiryOrWarrantyDate: ['expiry_or_warranty_date', 'expiry_waranty_date', 'expiry_warranty_date', 'expiry_date'],
  remark: ['remark', 'remarks', 'remark_1', 'note', 'notes'],
  legacyProductId: ['legacy_product_id', 'product_id'],
  legacySku: ['legacy_sku', 'sku'],
  // `current_stock` first, deliberately: the legacy Master sheet carries BOTH
  // an "Opening Stock" and a "Current Stock" column, and Current Stock is the
  // authoritative on-hand figure (Current = Opening + IN − Out − Damage).
  // Seeding from Opening would restate months of movements as stock on hand.
  openingStock: ['current_stock', 'opening_stock', 'stock'],
  damageQty: ['damage_qty', 'damage_received_qty', 'any_damage_received'],
  locationName: ['location_name', 'location'],
  rackNo: ['rack_no', 'rack', 'rack_number'],
  qty: ['qty', 'quantity', 'qty_received', 'issue_qty', 'return_qty', 'qty_return'],
  txnType: ['txn_type', 'transaction_type', 'type'],
  txnDate: ['txn_date', 'date', 'order_date', 'issue_date', 'return_date', 'sample_date'],
  vendorName: ['vendor_name', 'vendor'],
  grnNo: ['grn_no', 'grn'],
  gatePassNo: ['gate_pass_no', 'gate_pass'],
  rate: ['rate', 'unit_rate', 'price'],
  taxPct: ['tax_pct', 'tax', 'tax_percent'],
  qcStatus: ['qc_status', 'qc'],
  issueDept: ['issue_dept', 'department', 'dept'],
  issuedToName: ['issued_to_name', 'issued_to', 'team_member_name', 'sales_person', 'name_place', 'to'],
  platform: ['platform', 'platefrom'],
  orderId: ['order_id', 'order_no'],
  customerName: ['customer_name', 'customer', 'claint_name', 'client_name'],
  courierName: ['courier_name', 'courier'],
  trackingId: ['tracking_id', 'tracking', 'awb'],
  paymentMode: ['payment_mode', 'payment'],
  orderValue: ['order_value', 'value', 'total_amount'],
  returnReason: ['return_reason', 'reason'],
  productCondition: ['product_condition', 'production_condation', 'product_condation', 'condition'],
  restockDecision: ['restock_decision', 'restock_yes_no', 'restock'],
  sourceRowRef: ['source_row_ref', 'source_ref'],
};

/**
 * Every column name the mapper understands, flattened. The file parser scores
 * candidate header rows against this so it can find the real header row in a
 * spreadsheet that opens with a merged title, and pick the right worksheet in a
 * multi-sheet workbook.
 */
export const KNOWN_HEADER_KEYS: ReadonlySet<string> = new Set(
  Object.values(ALIASES).flat(),
);

/**
 * Columns that strongly indicate a sheet is of a given import type. Both sheet
 * shapes share `product_name`/`colour`/`remark`, so the generic score alone
 * cannot separate a product catalogue from a movement log — these break the tie.
 */
export const TYPE_SIGNAL_HEADERS: Record<string, readonly string[]> = {
  PRODUCT_MASTER: [
    'opening_stock',
    'current_stock',
    'category',
    'sku',
    'product_id',
    'image_link',
    'rack_no',
    'reorder_point',
  ],
  STOCK_LEDGER: [
    'txn_type',
    'transaction_type',
    'qty_received',
    'issue_qty',
    'qty_return',
    'return_qty',
    'grn_no',
    'gate_pass_no',
    'order_id',
    'issued_to',
    'team_member_name',
    'sales_person',
    'vendor',
    'vendor_name',
    'platform',
    // The workbook's own misspelling — signals must match real column names,
    // not idealised ones, or a movement sheet scores as a catalogue.
    'platefrom',
    'customer_name',
    'courier_name',
    'tracking_id',
    'qc_status',
  ],
};

/** Read the first populated alias for a logical field. */
export function field(row: Record<string, unknown>, key: string): string {
  for (const alias of ALIASES[key] ?? [key]) {
    const raw = row[alias];
    if (raw === null || raw === undefined) continue;
    const value = String(raw).trim();
    if (value !== '') return value;
  }
  return '';
}

/**
 * Value of the first alias column that EXISTS on the row, even when blank;
 * `null` only when none of the aliases is a column at all.
 *
 * `field()` returns the first *non-empty* alias, which is wrong when an empty
 * cell is itself meaningful. The Master sheet leaves Current Stock blank on 23
 * rows where Opening − Out − Damage nets to nil; falling through to Opening
 * Stock there would restate written-off units as stock on hand.
 */
export function presentField(row: Record<string, unknown>, key: string): string | null {
  for (const alias of ALIASES[key] ?? [key]) {
    if (Object.prototype.hasOwnProperty.call(row, alias)) {
      const raw = row[alias];
      return raw === null || raw === undefined ? '' : String(raw).trim();
    }
  }
  return null;
}

/** Values the source workbook uses to mean "nothing here". */
const BLANKS = new Set(['', 'n/a', 'na', 'nil', '-', '--', 'none', 'null', 'undefined']);

/** Treat the workbook's many spellings of "empty" as empty. */
export function cleaned(value: string): string {
  return BLANKS.has(value.trim().toLowerCase()) ? '' : value.trim();
}

/**
 * Parse an integer quantity. The workbook stores everything as a float
 * ("250.0"), and blank means zero-not-stated, so distinguish "absent" (null)
 * from "explicitly zero" (0) and reject anything genuinely non-numeric.
 */
export function parseIntOrNull(value: string): number | null {
  const v = cleaned(value);
  if (v === '') return null;
  const n = Number(v.replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  // Fractional pieces are meaningless in this warehouse; round toward zero and
  // let the caller decide whether the loss matters.
  return Math.trunc(n);
}

export function parseDecimalOrNull(value: string): string | null {
  const v = cleaned(value);
  if (v === '') return null;
  const n = Number(v.replace(/,/g, ''));
  return Number.isFinite(n) ? String(n) : null;
}

/**
 * Parse a date cell. Handles ISO strings, dd/mm/yyyy (the workbook's format)
 * and Excel serial numbers, which is what an unformatted date cell exports as
 * ("46028" = 2026-01-13).
 */
/**
 * Clean a barcode coming out of a spreadsheet.
 *
 * Excel treats a 13-digit EAN as a number, so a column of barcodes routinely
 * arrives as "8.90123E+12" (scientific notation) or "8901234567890.0". Both
 * would import as a value the scanner can never match, and the failure would
 * only surface months later at a shelf. Scientific notation is expanded, a
 * trailing ".0" is dropped, and anything still not a plain code is discarded.
 */
export function normaliseBarcode(value: string): string | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;

  // "8.9012345678901E+12" → the integer it was before Excel got hold of it.
  if (/^\d(\.\d+)?[eE][+-]?\d+$/.test(raw)) {
    const expanded = Number(raw);
    if (!Number.isFinite(expanded)) return null;
    return BigInt(Math.round(expanded)).toString();
  }
  // "8901234567890.0" → "8901234567890"
  const trimmed = raw.replace(/\.0+$/, '');
  // Digits, letters, hyphens: covers EAN/UPC and internal codes alike.
  if (!/^[A-Za-z0-9-]{4,120}$/.test(trimmed)) return null;
  return trimmed;
}

export function parseDateOrNull(value: string): Date | null {
  const v = cleaned(value);
  if (v === '') return null;

  // Excel serial: days since 1899-12-30 (the 1900 leap-year bug is baked in).
  if (/^\d{4,6}(\.\d+)?$/.test(v)) {
    const serial = Number(v);
    if (serial > 20_000 && serial < 80_000) {
      return new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000);
    }
  }

  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(v);
  if (dmy) {
    const [, d, m, y] = dmy;
    return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  }

  const parsed = new Date(v);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Yes/No style cells: "Yes", "Y", "TRUE", "1" are all true. */
export function parseBoolOrNull(value: string): boolean | null {
  const v = cleaned(value).toLowerCase();
  if (v === '') return null;
  if (['yes', 'y', 'true', '1', 'restock'].includes(v)) return true;
  if (['no', 'n', 'false', '0'].includes(v)) return false;
  return null;
}

export function parseTxnType(value: string): StockTxnType | null {
  const v = cleaned(value).toUpperCase().replace(/[^A-Z]+/g, '_');
  return (STOCK_TXN_TYPE as readonly string[]).includes(v) ? (v as StockTxnType) : null;
}

export function parseQcStatus(value: string): 'PENDING' | 'OK' | 'REJECTED' | null {
  const v = cleaned(value).toLowerCase();
  if (v === '') return null;
  if (v.startsWith('ok') || v.startsWith('approve') || v.startsWith('pass')) return 'OK';
  if (v.startsWith('reject') || v.startsWith('fail')) return 'REJECTED';
  if (v.startsWith('pend')) return 'PENDING';
  return null;
}

export function parseIssueDept(value: string): 'PHOTOSHOOT' | 'SALES' | 'OTHER' | null {
  const v = cleaned(value).toLowerCase();
  if (v === '') return null;
  if (v.startsWith('photo')) return 'PHOTOSHOOT';
  if (v.startsWith('sale')) return 'SALES';
  if (v.startsWith('other')) return 'OTHER';
  return null;
}

/** Category is required going forward; blanks become the backfill value. */
export function normaliseCategory(value: string): string {
  return cleaned(value) || UNCATEGORIZED;
}

export interface RowIssue {
  status: 'ERROR' | 'SKIPPED';
  message: string;
}

export interface ProductMasterRow {
  name: string;
  category: string;
  colour: string | null;
  /** The pack's printed EAN/UPC, when the spreadsheet carries one. */
  barcode: string | null;
  imageUrl: string | null;
  unit: string;
  reorderPoint: number | null;
  expiryOrWarrantyDate: Date | null;
  remark: string | null;
  legacyProductId: string | null;
  legacySku: string | null;
  /** Seeded as one ADJUSTMENT entry when present. */
  openingStock: number | null;
  damageQty: number | null;
  locationName: string | null;
  rackNo: string | null;
}

/**
 * Validate and shape one PRODUCT_MASTER row. Returns either the mapped row or
 * the reason it cannot be processed.
 */
export function mapProductMasterRow(
  raw: Record<string, unknown>,
): { ok: true; value: ProductMasterRow } | { ok: false; issue: RowIssue } {
  const name = cleaned(field(raw, 'name'));
  if (!name) {
    return { ok: false, issue: { status: 'ERROR', message: 'Product Name is required.' } };
  }

  // Presence-based, not value-based: a blank Current Stock cell means zero on
  // hand, not "look at Opening Stock instead".
  const openingRaw = presentField(raw, 'openingStock');
  let openingStock: number | null = null;
  if (openingRaw !== null) {
    if (cleaned(openingRaw) === '') {
      openingStock = 0;
    } else {
      openingStock = parseIntOrNull(openingRaw);
      if (openingStock === null) {
        return {
          ok: false,
          issue: {
            status: 'ERROR',
            message: `Opening Stock "${openingRaw}" is not a number.`,
          },
        };
      }
    }
  }
  if (openingStock !== null && openingStock < 0) {
    return {
      ok: false,
      issue: { status: 'ERROR', message: 'Opening Stock cannot be negative.' },
    };
  }

  const reorderRaw = field(raw, 'reorderPoint');
  const reorderPoint = parseIntOrNull(reorderRaw);
  if (cleaned(reorderRaw) !== '' && reorderPoint === null) {
    return {
      ok: false,
      issue: { status: 'ERROR', message: `Reorder Point "${reorderRaw}" is not a number.` },
    };
  }

  const damageQty = parseIntOrNull(field(raw, 'damageQty'));

  return {
    ok: true,
    value: {
      name,
      category: normaliseCategory(field(raw, 'category')),
      colour: cleaned(field(raw, 'colour')) || null,
      // Spreadsheets store long barcodes as numbers, which arrive as
      // "8901234567890" or, worse, "8.90123e+12". Anything that is not a clean
      // run of digits or a plain alphanumeric code is dropped rather than
      // imported as a value no scanner will ever produce.
      barcode: normaliseBarcode(field(raw, 'barcode')),
      imageUrl: cleaned(field(raw, 'imageUrl')) || null,
      unit: cleaned(field(raw, 'unit')) || 'pcs',
      reorderPoint,
      expiryOrWarrantyDate: parseDateOrNull(field(raw, 'expiryOrWarrantyDate')),
      remark: cleaned(field(raw, 'remark')) || null,
      legacyProductId: field(raw, 'legacyProductId') || null,
      legacySku: field(raw, 'legacySku') || null,
      openingStock,
      damageQty: damageQty && damageQty > 0 ? damageQty : null,
      locationName: cleaned(field(raw, 'locationName')) || null,
      rackNo: cleaned(field(raw, 'rackNo')) || null,
    },
  };
}

export interface StockLedgerRow {
  productCode: string | null;
  productName: string;
  colour: string | null;
  txnType: StockTxnType;
  qty: number;
  locationName: string;
  rackNo: string | null;
  txnDate: Date | null;
  vendorName: string | null;
  grnNo: string | null;
  gatePassNo: string | null;
  rate: string | null;
  taxPct: string | null;
  qcStatus: 'PENDING' | 'OK' | 'REJECTED' | null;
  issueDept: 'PHOTOSHOOT' | 'SALES' | 'OTHER' | null;
  issuedToName: string | null;
  platform: string | null;
  orderId: string | null;
  customerName: string | null;
  courierName: string | null;
  trackingId: string | null;
  paymentMode: string | null;
  orderValue: string | null;
  returnReason: string | null;
  productCondition: string | null;
  restockDecision: boolean | null;
  remark: string | null;
  sourceRowRef: string | null;
}

/** Validate and shape one STOCK_LEDGER row. */
export function mapStockLedgerRow(
  raw: Record<string, unknown>,
): { ok: true; value: StockLedgerRow } | { ok: false; issue: RowIssue } {
  const productName = cleaned(field(raw, 'name'));
  const productCode = cleaned(field(raw, 'code')) || null;
  if (!productName && !productCode) {
    return {
      ok: false,
      issue: { status: 'ERROR', message: 'Product Name or Code is required.' },
    };
  }

  const txnType = parseTxnType(field(raw, 'txnType'));
  if (!txnType) {
    return {
      ok: false,
      issue: {
        status: 'ERROR',
        message: `Unknown transaction type "${field(raw, 'txnType')}". Expected one of: ${STOCK_TXN_TYPE.join(', ')}.`,
      },
    };
  }

  const qty = parseIntOrNull(field(raw, 'qty'));
  if (qty === null) {
    return {
      ok: false,
      issue: { status: 'ERROR', message: `Quantity "${field(raw, 'qty')}" is not a number.` },
    };
  }
  if (qty === 0) {
    return { ok: false, issue: { status: 'ERROR', message: 'Quantity cannot be zero.' } };
  }
  if (qty < 0 && txnType !== 'ADJUSTMENT') {
    return {
      ok: false,
      issue: {
        status: 'ERROR',
        message: `Quantity must be positive for ${txnType} — direction is derived from the transaction type.`,
      },
    };
  }

  const locationName = cleaned(field(raw, 'locationName'));
  if (!locationName) {
    return { ok: false, issue: { status: 'ERROR', message: 'Location is required.' } };
  }

  return {
    ok: true,
    value: {
      productCode,
      productName,
      colour: cleaned(field(raw, 'colour')) || null,
      txnType,
      qty,
      locationName,
      rackNo: cleaned(field(raw, 'rackNo')) || null,
      txnDate: parseDateOrNull(field(raw, 'txnDate')),
      vendorName: cleaned(field(raw, 'vendorName')) || null,
      grnNo: cleaned(field(raw, 'grnNo')) || null,
      gatePassNo: cleaned(field(raw, 'gatePassNo')) || null,
      rate: parseDecimalOrNull(field(raw, 'rate')),
      taxPct: parseDecimalOrNull(field(raw, 'taxPct')),
      qcStatus: parseQcStatus(field(raw, 'qcStatus')),
      issueDept: parseIssueDept(field(raw, 'issueDept')),
      issuedToName: cleaned(field(raw, 'issuedToName')) || null,
      platform: cleaned(field(raw, 'platform')) || null,
      orderId: cleaned(field(raw, 'orderId')) || null,
      customerName: cleaned(field(raw, 'customerName')) || null,
      courierName: cleaned(field(raw, 'courierName')) || null,
      trackingId: cleaned(field(raw, 'trackingId')) || null,
      paymentMode: cleaned(field(raw, 'paymentMode')) || null,
      orderValue: parseDecimalOrNull(field(raw, 'orderValue')),
      returnReason: cleaned(field(raw, 'returnReason')) || null,
      productCondition: cleaned(field(raw, 'productCondition')) || null,
      restockDecision: parseBoolOrNull(field(raw, 'restockDecision')),
      remark: cleaned(field(raw, 'remark')) || null,
      sourceRowRef: cleaned(field(raw, 'sourceRowRef')) || null,
    },
  };
}
