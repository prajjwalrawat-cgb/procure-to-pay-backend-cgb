/**
 * Inventory domain vocabularies (Slice 12). Mirrors the Prisma enums so the web
 * app can render filters and badges without importing the Prisma client.
 */

/** Every physical movement shape observed across the nine source sheets. */
export const STOCK_TXN_TYPE = [
  'VENDOR_INWARD',
  'VENDOR_RETURN_OUT',
  'SAMPLE_INWARD',
  'INTERNAL_ISSUE',
  'INTERNAL_RETURN',
  'CUSTOMER_ORDER_OUT',
  'CUSTOMER_RETURN_IN',
  'DAMAGE_WRITE_OFF',
  'ADJUSTMENT',
] as const;
export type StockTxnType = (typeof STOCK_TXN_TYPE)[number];

/**
 * Sign each movement type contributes to on-hand stock. This is the single
 * source of truth for `direction` — services derive it, callers never send it,
 * so a caller can't post an inward movement that secretly decrements stock.
 *
 * VENDOR_RETURN_OUT is -1 (goods physically leave for repair/replacement) even
 * though the summary view also counts it under `return_qty`, mirroring the
 * source sheet's own treatment.
 */
export const STOCK_TXN_DIRECTION: Record<StockTxnType, 1 | -1> = {
  VENDOR_INWARD: 1,
  VENDOR_RETURN_OUT: -1,
  SAMPLE_INWARD: 1,
  INTERNAL_ISSUE: -1,
  INTERNAL_RETURN: 1,
  CUSTOMER_ORDER_OUT: -1,
  CUSTOMER_RETURN_IN: 1,
  DAMAGE_WRITE_OFF: -1,
  ADJUSTMENT: 1, // sign carried by the caller's signed qty — see directionFor()
};

/**
 * Resolve the ledger direction for a movement. ADJUSTMENT is the only type that
 * can go either way (opening stock is positive, a stock-count shortfall or a
 * correction is negative), so it takes the sign from the signed quantity.
 */
export function directionFor(txnType: StockTxnType, signedQty: number): 1 | -1 {
  if (txnType === 'ADJUSTMENT') return signedQty < 0 ? -1 : 1;
  return STOCK_TXN_DIRECTION[txnType];
}

export const ISSUE_DEPT = ['PHOTOSHOOT', 'SALES', 'OTHER'] as const;
export type IssueDept = (typeof ISSUE_DEPT)[number];

export const INVENTORY_QC_STATUS = ['PENDING', 'OK', 'REJECTED'] as const;
export type InventoryQcStatus = (typeof INVENTORY_QC_STATUS)[number];

export const IMPORT_TYPE = ['PRODUCT_MASTER', 'STOCK_LEDGER'] as const;
export type ImportType = (typeof IMPORT_TYPE)[number];

export const IMPORT_ROW_STATUS = [
  'PENDING',
  'VALID',
  'CREATED',
  'UPDATED',
  'ERROR',
  'SKIPPED',
] as const;
export type ImportRowStatus = (typeof IMPORT_ROW_STATUS)[number];

export const IMPORT_BATCH_STATUS = [
  'PROCESSING',
  'COMPLETED',
  'COMPLETED_WITH_ERRORS',
  'FAILED',
] as const;
export type ImportBatchStatus = (typeof IMPORT_BATCH_STATUS)[number];

/** Category applied when the legacy sheet has no category (601 of 625 rows). */
export const UNCATEGORIZED = 'Uncategorized';

/**
 * Category → product-code prefix for auto-generated `Product.code`
 * ({PREFIX}-{6-digit sequence}, e.g. HD-000123). Unknown categories fall back to
 * an initials-derived prefix; see `categoryPrefix`.
 */
export const CATEGORY_CODE_PREFIX: Record<string, string> = {
  'home decor': 'HD',
  stationery: 'ST',
  rainwear: 'RW',
  box: 'BX',
  packaging: 'PK',
  apparel: 'AP',
  electronics: 'EL',
  kitchenware: 'KW',
  bags: 'BG',
  [UNCATEGORIZED.toLowerCase()]: 'UC',
};

/**
 * Derive a stable 2–3 char uppercase code prefix for a category. Known
 * categories use the curated table; anything else is derived from word initials
 * (falling back to the first letters) so new categories never collide with a
 * numeric sequence and stay readable.
 */
export function categoryPrefix(category: string): string {
  const key = category.trim().toLowerCase();
  const known = CATEGORY_CODE_PREFIX[key];
  if (known) return known;

  const words = key.split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length === 0) return 'UC';
  const initials = words
    .map((w) => w[0])
    .join('')
    .toUpperCase();
  if (initials.length >= 2) return initials.slice(0, 3);
  return (words[0] ?? 'uc').slice(0, 3).toUpperCase().padEnd(2, 'X');
}

/** Format a product code from its prefix and sequence number. */
export function formatProductCode(prefix: string, sequence: number): string {
  return `${prefix}-${String(sequence).padStart(6, '0')}`;
}
