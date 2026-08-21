import { z } from 'zod';

import {
  IMPORT_ROW_STATUS,
  IMPORT_TYPE,
  INVENTORY_QC_STATUS,
  ISSUE_DEPT,
  LOCATION_KIND,
  STOCK_TXN_TYPE,
} from '../constants/inventory-status';

const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'must be a decimal string');
/** Physical piece counts are whole numbers throughout the source workbook. */
const positiveQty = z.number().int().positive('quantity must be greater than zero');

// ══════════════════════════ Products ══════════════════════════

export const ProductCreateInputSchema = z.object({
  name: z.string().min(1).max(200),
  category: z.string().min(1).max(80),
  /**
   * Slice 13 — the EAN/UPC printed on the pack. Without one the product cannot
   * be found by camera at all, only by typing its code, so this is the single
   * most useful field on the form for a warehouse that scans.
   */
  barcode: z.string().max(120).nullish(),
  /**
   * Slice 13 — when set, a scanned receipt must carry a batch number and expiry
   * date, and FEFO picking will draw the oldest batch first.
   */
  requiresBatchTracking: z.boolean().default(false),
  colour: z.string().max(80).nullish(),
  imageUrl: z.string().url().max(1000).nullish(),
  unit: z.string().min(1).max(20).default('pcs'),
  reorderPoint: z.number().int().min(0).nullish(),
  expiryOrWarrantyDate: z.string().datetime().nullish(),
  remark: z.string().max(2000).nullish(),
  /** Optional bridge to the Slice 4 procurement item master. */
  itemId: z.string().max(60).nullish(),
  /** Preserved verbatim from the legacy sheet for audit; "N/A" on all 625 rows. */
  legacyProductId: z.string().max(120).nullish(),
  legacySku: z.string().max(120).nullish(),
});
export type ProductCreateInput = z.infer<typeof ProductCreateInputSchema>;

/** `code` is server-generated and never client-supplied, so it is not updatable. */
export const ProductUpdateInputSchema = ProductCreateInputSchema.partial().extend({
  active: z.boolean().optional(),
});
export type ProductUpdateInput = z.infer<typeof ProductUpdateInputSchema>;

export const ProductListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().nullish(),
  q: z.string().max(120).nullish(),
  category: z.string().max(80).nullish(),
  locationId: z.string().max(60).nullish(),
  active: z.coerce.boolean().nullish(),
  /** Only products whose current stock is at or below their reorder point. */
  lowStock: z.coerce.boolean().nullish(),
});
export type ProductListQuery = z.infer<typeof ProductListQuerySchema>;

// ══════════════════════════ Locations ══════════════════════════

export const LocationCreateInputSchema = z.object({
  name: z.string().min(1).max(120),
  rackNo: z.string().max(120).nullish(),
  parentId: z.string().max(60).nullish(),
  /**
   * Slice 13 — the label stuck on the shelf, scanned during putaway, transfer
   * and cycle count. Only leaf locations normally carry one: nobody scans "Main
   * Warehouse", they scan the section they are standing at.
   */
  barcode: z.string().max(120).nullish(),
  /**
   * Slice 14 — which level of the hierarchy this row is. Defaults to OTHER so
   * an existing tenant's free-text locations keep working untouched; set it to
   * get warehouse → rack → section paths on the scanner.
   */
  kind: z.enum(LOCATION_KIND).default('OTHER'),
});
export type LocationCreateInput = z.infer<typeof LocationCreateInputSchema>;

export const LocationUpdateInputSchema = LocationCreateInputSchema.partial().extend({
  active: z.boolean().optional(),
});
export type LocationUpdateInput = z.infer<typeof LocationUpdateInputSchema>;

// ══════════════════════════ Movements ══════════════════════════

/** Common fields every movement endpoint accepts. */
const movementBase = {
  productId: z.string().min(1).max(60),
  locationId: z.string().min(1).max(60),
  qty: positiveQty,
  remark: z.string().max(2000).nullish(),
  txnDate: z.string().datetime().nullish(),
};

/** POST /inventory/receipts — VENDOR_INWARD (business rule 1). */
export const ReceiptCreateInputSchema = z
  .object({
    ...movementBase,
    vendorId: z.string().max(60).nullish(),
    /** Required unless `nonPoReceipt` is set — see business rule 1. */
    purchaseOrderId: z.string().max(60).nullish(),
    /**
     * Explicit override for Challan-only receipts, which the source sheet does
     * genuinely contain. Never a silent default: the caller must opt in.
     */
    nonPoReceipt: z.boolean().default(false),
    nonPoReason: z.string().max(500).nullish(),
    invoiceId: z.string().max(60).nullish(),
    grnId: z.string().max(60).nullish(),
    grnNo: z.string().max(120).nullish(),
    invoiceNo: z.string().max(120).nullish(),
    rate: decimalString.nullish(),
    taxPct: decimalString.nullish(),
    qcStatus: z.enum(INVENTORY_QC_STATUS).default('PENDING'),
    /** Damaged-on-arrival portion of `qty`; never posts to sellable stock. */
    damageQty: z.number().int().min(0).default(0),
    /** Slice 13 — supplier batch/lot code, required for batch-tracked products. */
    batchNumber: z.string().max(120).nullish(),
    /** Slice 13 — this consignment's expiry, the input FEFO allocation reads. */
    expiryDate: z.string().datetime().nullish(),
  })
  .refine((v) => v.nonPoReceipt || !!v.purchaseOrderId, {
    message:
      'purchaseOrderId is required for a goods receipt. Set nonPoReceipt=true for a Challan-only receipt.',
    path: ['purchaseOrderId'],
  })
  .refine((v) => !v.nonPoReceipt || !!v.nonPoReason, {
    message: 'nonPoReason is required when nonPoReceipt is set.',
    path: ['nonPoReason'],
  })
  .refine((v) => v.damageQty <= v.qty, {
    message: 'damageQty cannot exceed the received quantity.',
    path: ['damageQty'],
  });
export type ReceiptCreateInput = z.infer<typeof ReceiptCreateInputSchema>;

/** POST /inventory/receipts/:id/qc — the QC gate (business rule 2). */
export const ReceiptQcInputSchema = z
  .object({
    qcStatus: z.enum(['OK', 'REJECTED']),
    /** Rejected portion; defaults to the whole receipt when REJECTED. */
    rejectedQty: z.number().int().min(0).nullish(),
    /** How rejected stock leaves the pending-disposition queue. */
    disposition: z.enum(['RETURN_TO_VENDOR', 'WRITE_OFF']).nullish(),
    remark: z.string().max(2000).nullish(),
  })
  .refine((v) => v.qcStatus !== 'REJECTED' || !!v.disposition, {
    message: 'disposition is required when rejecting a receipt.',
    path: ['disposition'],
  });
export type ReceiptQcInput = z.infer<typeof ReceiptQcInputSchema>;

/** POST /inventory/vendor-returns — VENDOR_RETURN_OUT (gate-pass out). */
export const VendorReturnInputSchema = z.object({
  ...movementBase,
  vendorId: z.string().max(60).nullish(),
  gatePassNo: z.string().max(120).nullish(),
  /** The invoice/challan the goods came in against. */
  invoiceNo: z.string().max(120).nullish(),
  purpose: z.string().max(200).nullish(),
  tentativeReturnDate: z.string().datetime().nullish(),
  rmaId: z.string().max(60).nullish(),
});
export type VendorReturnInput = z.infer<typeof VendorReturnInputSchema>;

/** POST /inventory/samples — SAMPLE_INWARD (non-stock sample receipt). */
export const SampleInwardInputSchema = z.object({
  ...movementBase,
  vendorId: z.string().max(60).nullish(),
  rate: decimalString.nullish(),
  qcStatus: z.enum(INVENTORY_QC_STATUS).default('PENDING'),
});
export type SampleInwardInput = z.infer<typeof SampleInwardInputSchema>;

/** POST /inventory/issues — INTERNAL_ISSUE (business rule 3). */
export const IssueCreateInputSchema = z.object({
  ...movementBase,
  issueDept: z.enum(ISSUE_DEPT),
  issuedToName: z.string().min(1).max(200),
  /** Required above the tenant's configured qty/value threshold. */
  approvedById: z.string().max(60).nullish(),
  tentativeReturnDate: z.string().datetime().nullish(),
  /** Sales-team issues record the client the stock went out for. */
  customerName: z.string().max(200).nullish(),
});
export type IssueCreateInput = z.infer<typeof IssueCreateInputSchema>;

/** POST /inventory/issues/:id/return — INTERNAL_RETURN, partial or full. */
export const IssueReturnInputSchema = z.object({
  qty: positiveQty,
  /** Defaults to the location the stock was issued from. */
  locationId: z.string().max(60).nullish(),
  remark: z.string().max(2000).nullish(),
  txnDate: z.string().datetime().nullish(),
});
export type IssueReturnInput = z.infer<typeof IssueReturnInputSchema>;

/** POST /inventory/orders/fulfill — CUSTOMER_ORDER_OUT (business rule 4). */
export const OrderFulfillInputSchema = z.object({
  ...movementBase,
  platform: z.string().max(80).nullish(),
  orderId: z.string().max(120).nullish(),
  customerName: z.string().max(200).nullish(),
  courierName: z.string().max(120).nullish(),
  trackingId: z.string().max(200).nullish(),
  paymentMode: z.string().max(40).nullish(),
  orderValue: decimalString.nullish(),
  /**
   * Ship despite insufficient stock at the chosen location. The source sheet has
   * no such control today; the block is new and the override is explicit.
   */
  allowNegativeStock: z.boolean().default(false),
});
export type OrderFulfillInput = z.infer<typeof OrderFulfillInputSchema>;

/** POST /inventory/returns — CUSTOMER_RETURN_IN (business rule 5). */
export const CustomerReturnInputSchema = z.object({
  ...movementBase,
  orderId: z.string().max(120).nullish(),
  customerName: z.string().max(200).nullish(),
  returnReason: z.string().max(500).nullish(),
  productCondition: z.string().max(200).nullish(),
});
export type CustomerReturnInput = z.infer<typeof CustomerReturnInputSchema>;

/** POST /inventory/returns/:id/restock-decision. */
export const RestockDecisionInputSchema = z.object({
  restock: z.boolean(),
  remark: z.string().max(2000).nullish(),
});
export type RestockDecisionInput = z.infer<typeof RestockDecisionInputSchema>;

/** POST /inventory/damage — DAMAGE_WRITE_OFF. */
export const DamageWriteOffInputSchema = z.object({
  ...movementBase,
  reason: z.string().min(1).max(500),
});
export type DamageWriteOffInput = z.infer<typeof DamageWriteOffInputSchema>;

/**
 * POST /inventory/adjustments — ADJUSTMENT. The only movement that may be
 * negative, and the only way to correct a mistake (business rule 6): pass
 * `correctionOfId` to link the compensating entry to the entry it offsets.
 */
export const AdjustmentInputSchema = z.object({
  productId: z.string().min(1).max(60),
  locationId: z.string().min(1).max(60),
  /** Signed: negative writes stock down (stock count shortfall, correction). */
  signedQty: z
    .number()
    .int()
    .refine((n) => n !== 0, 'adjustment quantity cannot be zero'),
  reason: z.string().min(1).max(500),
  correctionOfId: z.string().max(60).nullish(),
  txnDate: z.string().datetime().nullish(),
});
export type AdjustmentInput = z.infer<typeof AdjustmentInputSchema>;

// ══════════════════════════ Ledger query ══════════════════════════

/**
 * GET /inventory/ledger — powers every report screen. Each legacy sheet is a
 * saved filter over this one endpoint, not a separate table.
 */
export const LedgerQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().nullish(),
  product: z.string().max(60).nullish(),
  location: z.string().max(60).nullish(),
  txnType: z.enum(STOCK_TXN_TYPE).nullish(),
  issueDept: z.enum(ISSUE_DEPT).nullish(),
  vendorId: z.string().max(60).nullish(),
  orderId: z.string().max(120).nullish(),
  /** Open internal issues only (derived balance > 0). */
  openOnly: z.coerce.boolean().nullish(),
  from: z.string().datetime().nullish(),
  to: z.string().datetime().nullish(),
});
export type LedgerQuery = z.infer<typeof LedgerQuerySchema>;

/** The eight legacy report sheets, reproduced as saved ledger filters. */
export const LEDGER_SAVED_VIEWS = [
  { key: 'vendor_inward', label: 'Vendor Inward', txnType: 'VENDOR_INWARD' },
  { key: 'vendor_outward', label: 'Vendor Outward', txnType: 'VENDOR_RETURN_OUT' },
  { key: 'sample_inward', label: 'Sample Inward', txnType: 'SAMPLE_INWARD' },
  { key: 'daily_in_out', label: 'Daily In & Out', txnType: null },
  { key: 'photoshoot', label: 'Photoshoot Team', txnType: 'INTERNAL_ISSUE', issueDept: 'PHOTOSHOOT' },
  { key: 'sales_team', label: 'Sales Team Out & In', txnType: 'INTERNAL_ISSUE', issueDept: 'SALES' },
  { key: 'other_issue', label: 'Other Place / Person', txnType: 'INTERNAL_ISSUE', issueDept: 'OTHER' },
  { key: 'daily_order', label: 'Daily Order Report', txnType: 'CUSTOMER_ORDER_OUT' },
  { key: 'return_inventory', label: 'Return Inventory', txnType: 'CUSTOMER_RETURN_IN' },
] as const;
export type LedgerSavedViewKey = (typeof LEDGER_SAVED_VIEWS)[number]['key'];

// ══════════════════════════ Bulk import ══════════════════════════

export const BulkImportCreateSchema = z.object({
  importType: z.enum(IMPORT_TYPE),
});
export type BulkImportCreate = z.infer<typeof BulkImportCreateSchema>;

export const ImportRowsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().nullish(),
  status: z.enum(IMPORT_ROW_STATUS).nullish(),
});
export type ImportRowsQuery = z.infer<typeof ImportRowsQuerySchema>;

/** POST /inventory/bulk-imports/:id/rows/:rowId/resolve — quarantine triage. */
export const ImportRowResolveSchema = z
  .object({
    /** Create the product this row referenced, or map it to an existing one. */
    action: z.enum(['CREATE_PRODUCT', 'MAP_TO_PRODUCT', 'DISCARD']),
    productId: z.string().max(60).nullish(),
    category: z.string().max(80).nullish(),
  })
  .refine((v) => v.action !== 'MAP_TO_PRODUCT' || !!v.productId, {
    message: 'productId is required when mapping a skipped row to a product.',
    path: ['productId'],
  });
export type ImportRowResolve = z.infer<typeof ImportRowResolveSchema>;

// ══════════════════════════ Read models ══════════════════════════

/** Every derived Master Inventory Sheet column, straight from the ledger view. */
export interface ProductStockSummary {
  openingStock: number;
  totalIn: number;
  totalOut: number;
  returnQty: number;
  damageQty: number;
  currentStock: number;
  lastMovementAt: string | null;
}

export interface LocationStockBreakdown {
  locationId: string;
  locationName: string;
  rackNo: string | null;
  qty: number;
}

export interface ProductListItem {
  id: string;
  code: string;
  name: string;
  category: string;
  colour: string | null;
  /** Null until someone captures the pack's EAN or prints an internal label. */
  barcode: string | null;
  /** When true, a scanned receipt must carry a batch number and expiry. */
  requiresBatchTracking: boolean;
  imageUrl: string | null;
  unit: string;
  reorderPoint: number | null;
  active: boolean;
  currentStock: number;
  /** True when currentStock <= reorderPoint (reorderPoint set and > 0). */
  lowStock: boolean;
  locations: LocationStockBreakdown[];
  updatedAt: string;
}

export interface ProductListResponse {
  items: ProductListItem[];
  nextCursor: string | null;
  totalEstimate: number;
}

/**
 * The product detail drawer's payload — the one place a warehouse user can
 * confirm nothing from the old sheet was lost, so it carries every legacy
 * column including the ones superseded by `code`.
 */
export interface ProductDetailResponse extends ProductListItem {
  legacyProductId: string | null;
  legacySku: string | null;
  expiryOrWarrantyDate: string | null;
  remark: string | null;
  itemId: string | null;
  createdFromImportBatchId: string | null;
  createdAt: string;
  summary: ProductStockSummary;
}

export interface ProductStockResponse {
  productId: string;
  code: string;
  name: string;
  total: number;
  locations: LocationStockBreakdown[];
  summary: ProductStockSummary;
}

export interface LocationView {
  id: string;
  name: string;
  rackNo: string | null;
  parentId: string | null;
  parentName: string | null;
  barcode: string | null;
  kind: (typeof LOCATION_KIND)[number];
  active: boolean;
  /** Distinct products currently holding stock here. */
  productCount: number;
  totalQty: number;
}

export interface LocationListResponse {
  items: LocationView[];
}

export interface LedgerEntryView {
  id: string;
  productId: string;
  productCode: string;
  productName: string;
  colour: string | null;
  locationId: string;
  locationName: string;
  txnType: string;
  qty: number;
  direction: number;
  signedQty: number;
  vendorId: string | null;
  vendorName: string | null;
  purchaseOrderId: string | null;
  purchaseOrderNumber: string | null;
  grnNo: string | null;
  gatePassNo: string | null;
  rate: string | null;
  taxPct: string | null;
  qcStatus: string | null;
  damageQty: number | null;
  issueDept: string | null;
  issuedToName: string | null;
  approvedById: string | null;
  /** Live unreturned balance, derived from linked INTERNAL_RETURN rows. */
  balanceQty: number | null;
  /** Derived from balanceQty: > 0 is Open. Null for non-issue rows. */
  issueStatus: 'OPEN' | 'CLOSED' | null;
  tentativeReturnDate: string | null;
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
  correctionOfId: string | null;
  performedById: string;
  remark: string | null;
  txnDate: string;
  importBatchId: string | null;
  sourceRowRef: string | null;
}

export interface LedgerResponse {
  items: LedgerEntryView[];
  nextCursor: string | null;
  totalEstimate: number;
}

export interface ImportBatchView {
  id: string;
  importType: string;
  fileName: string;
  uploadedById: string;
  status: string;
  totalRows: number;
  successRows: number;
  errorRows: number;
  skippedRows: number;
  /** Rows not yet processed by the validation job. */
  pendingRows: number;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ImportRowView {
  id: string;
  rowNumber: number;
  status: string;
  productId: string | null;
  ledgerEntryId: string | null;
  errorMessage: string | null;
  rawData: Record<string, unknown>;
}

export interface ImportBatchDetailResponse extends ImportBatchView {
  rows: ImportRowView[];
  nextCursor: string | null;
}

export interface ImportBatchListResponse {
  items: ImportBatchView[];
  nextCursor: string | null;
}

/** Pending QC / pending restock-decision work queues. */
export interface PendingDispositionResponse {
  qcPending: LedgerEntryView[];
  restockPending: LedgerEntryView[];
}
