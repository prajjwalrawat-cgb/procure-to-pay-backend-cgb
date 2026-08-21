import { z } from 'zod';

import {
  BARCODE_MATCH_TYPE,
  CYCLE_COUNT_STATUS,
  PICK_LIST_STATUS,
  SCAN_TYPE,
  SYNC_ITEM_STATUS,
} from '../constants/inventory-status';

/**
 * Mobile scanner contracts (Slice 13). Every scan endpoint shares three traits:
 *
 *  1. It identifies stock by *barcode*, never by id — the operator has a camera,
 *     not a database. Resolution happens server-side (ScanResolveService).
 *  2. It carries a client-generated `clientUuid`. A scan queued offline and
 *     replayed after a dropped response must never post a second ledger row.
 *  3. It carries a `deviceId`, so a mis-scanning handset can be traced.
 */

/** Physical piece counts, as everywhere else in the inventory module. */
const positiveQty = z.number().int().positive('quantity must be greater than zero');

/** A scanned barcode: printed labels are short, and 120 chars is already generous. */
const barcodeRaw = z.string().trim().min(1, 'a barcode is required').max(120);

/**
 * Fields every scan submission carries. `clientUuid` is a UUID rather than a
 * free-form string so a client can generate one offline with no server round
 * trip and no collision risk.
 */
const scanEnvelope = {
  deviceId: z.string().min(1).max(120),
  clientUuid: z.string().uuid('clientUuid must be a UUID generated on the device'),
  /** When the device recorded the scan — may predate arrival by hours offline. */
  clientTimestamp: z.string().datetime().nullish(),
  gpsLat: z.number().min(-90).max(90).nullish(),
  gpsLng: z.number().min(-180).max(180).nullish(),
};

// ══════════════════════════ Resolve ══════════════════════════

export const ScanResolveInputSchema = z.object({ barcodeRaw });
export type ScanResolveInput = z.infer<typeof ScanResolveInputSchema>;

/** The product card the scanner renders after a successful decode. */
export interface ScanProductView {
  id: string;
  code: string;
  name: string;
  category: string;
  colour: string | null;
  unit: string;
  barcode: string | null;
  imageUrl: string | null;
  /**
   * Effective batch requirement: the product's own flag OR the bridged
   * procurement `Item.requiresBatch`. Drives the receive screen's expiry field.
   */
  requiresBatchTracking: boolean;
  /** On-hand across every location, so the operator sees context immediately. */
  currentStock: number;
}

export interface ScanResolveResponse {
  product: ScanProductView;
  matchType: (typeof BARCODE_MATCH_TYPE)[number];
}

// ══════════════════════════ Receive ══════════════════════════

/**
 * Scan-receive posts a VENDOR_INWARD, so Slice 12 business rule 1 still applies:
 * a receipt references a receivable PO, or explicitly declares itself a
 * Challan-only receipt with a reason. The scanner is a new input device, not an
 * exemption from the control.
 */
export const ScanReceiveInputSchema = z
  .object({
    ...scanEnvelope,
    barcodeRaw,
    quantity: positiveQty,
    locationId: z.string().min(1).max(60),
    batchNumber: z.string().max(120).nullish(),
    expiryDate: z.string().datetime().nullish(),
    purchaseOrderId: z.string().max(60).nullish(),
    nonPoReceipt: z.boolean().default(false),
    nonPoReason: z.string().max(500).nullish(),
    remark: z.string().max(2000).nullish(),
  })
  .refine((v) => v.nonPoReceipt || !!v.purchaseOrderId, {
    message:
      'purchaseOrderId is required for a goods receipt. Set nonPoReceipt=true for a Challan-only receipt.',
    path: ['purchaseOrderId'],
  })
  .refine((v) => !v.nonPoReceipt || !!v.nonPoReason, {
    message: 'nonPoReason is required when nonPoReceipt is set.',
    path: ['nonPoReason'],
  });
export type ScanReceiveInput = z.infer<typeof ScanReceiveInputSchema>;

export interface ScanEventView {
  id: string;
  scanType: (typeof SCAN_TYPE)[number];
  productId: string;
  quantity: number;
  locationId: string | null;
  clientUuid: string;
  ledgerEntryId: string | null;
  createdAt: string;
  syncedAt: string | null;
}

export interface ScanReceiveResponse {
  scanEvent: ScanEventView;
  ledgerEntry: {
    id: string;
    qty: number;
    batchNumber: string | null;
    expiryDate: string | null;
  };
  /** On-hand at the receiving location after the movement. */
  currentStockLevel: number;
  /** True when this call replayed an already-recorded scan (idempotent hit). */
  duplicate: boolean;
}

// ══════════════════════════ Putaway ══════════════════════════

export const ScanPutawayInputSchema = z.object({
  ...scanEnvelope,
  barcodeRaw,
  /** The bin label. Bins are leaf Locations — there is no separate Bin entity. */
  binBarcodeRaw: barcodeRaw,
  quantity: positiveQty,
  remark: z.string().max(2000).nullish(),
});
export type ScanPutawayInput = z.infer<typeof ScanPutawayInputSchema>;

export interface ScanPutawayResponse {
  scanEvent: ScanEventView;
  binLocation: {
    id: string;
    name: string;
    rackNo: string | null;
    barcode: string | null;
  };
  skuName: string;
  /** Still-unputaway quantity from recent receipts after this putaway. */
  remainingToPutaway: number;
  duplicate: boolean;
}

// ══════════════════════════ Pick ══════════════════════════

export const ScanPickInputSchema = z.object({
  ...scanEnvelope,
  /** The pick list's order reference, as printed on the pick ticket. */
  orderId: z.string().min(1).max(120),
  barcodeRaw,
  quantity: positiveQty,
  remark: z.string().max(2000).nullish(),
});
export type ScanPickInput = z.infer<typeof ScanPickInputSchema>;

/** One FEFO allocation leg — which batch the pick actually consumed. */
export interface PickAllocation {
  ledgerEntryId: string;
  locationId: string;
  batchNumber: string | null;
  expiryDate: string | null;
  qty: number;
}

export interface ScanPickResponse {
  scanEvent: ScanEventView;
  /** Oldest expiry first — the order stock was drawn down in. */
  allocations: PickAllocation[];
  line: { productId: string; qtyRequired: number; qtyPicked: number; remaining: number };
  orderComplete: boolean;
  duplicate: boolean;
}

export interface PickListLineView {
  productId: string;
  productCode: string;
  productName: string;
  barcode: string | null;
  qtyRequired: number;
  qtyPicked: number;
  remaining: number;
  complete: boolean;
}

export interface PickListResponse {
  id: string;
  orderRef: string;
  platform: string | null;
  customerName: string | null;
  status: (typeof PICK_LIST_STATUS)[number];
  lines: PickListLineView[];
  /** Whole-list progress, so the UI can render a bar without recomputing. */
  totalRequired: number;
  totalPicked: number;
}

/**
 * Creating a pick list is not in the scanner's own spec, but without it Module 5
 * has nothing to pick against — the ledger's `orderId` is free text with no
 * quantities. Kept deliberately thin: a reference plus lines.
 */
export const PickListCreateInputSchema = z.object({
  orderRef: z.string().min(1).max(120),
  platform: z.string().max(60).nullish(),
  customerName: z.string().max(200).nullish(),
  lines: z
    .array(
      z.object({
        productId: z.string().min(1).max(60),
        qtyRequired: positiveQty,
      }),
    )
    .min(1, 'a pick list needs at least one line'),
});
export type PickListCreateInput = z.infer<typeof PickListCreateInputSchema>;

// ══════════════════════════ Cycle count ══════════════════════════

export const CycleCountStartInputSchema = z
  .object({
    /** The bin being counted, resolved from its label or chosen from a list. */
    binBarcodeRaw: barcodeRaw.nullish(),
    locationId: z.string().max(60).nullish(),
    deviceId: z.string().min(1).max(120),
    notes: z.string().max(2000).nullish(),
  })
  .refine((v) => !!v.binBarcodeRaw || !!v.locationId, {
    message: 'Either binBarcodeRaw or locationId is required.',
    path: ['binBarcodeRaw'],
  });
export type CycleCountStartInput = z.infer<typeof CycleCountStartInputSchema>;

export const CycleCountScanInputSchema = z.object({
  ...scanEnvelope,
  barcodeRaw,
  quantity: positiveQty,
});
export type CycleCountScanInput = z.infer<typeof CycleCountScanInputSchema>;

export interface CycleCountVarianceView {
  productId: string;
  productCode: string;
  productName: string;
  expectedQty: number;
  countedQty: number;
  deltaQty: number;
  ledgerEntryId: string | null;
}

export interface CycleCountSessionResponse {
  id: string;
  locationId: string;
  locationName: string;
  status: (typeof CYCLE_COUNT_STATUS)[number];
  countedById: string;
  approvedById: string | null;
  startedAt: string;
  completedAt: string | null;
  approvedAt: string | null;
  notes: string | null;
  /** Populated from `complete` onwards; empty while counting. */
  variances: CycleCountVarianceView[];
  /** Per-product running tally of what has been scanned so far. */
  countedSoFar: { productId: string; productName: string; countedQty: number }[];
}

// ══════════════════════════ Transfer ══════════════════════════

export const ScanTransferInputSchema = z
  .object({
    ...scanEnvelope,
    barcodeRaw,
    sourceBinBarcodeRaw: barcodeRaw,
    destBinBarcodeRaw: barcodeRaw,
    quantity: positiveQty,
    remark: z.string().max(2000).nullish(),
  })
  .refine((v) => v.sourceBinBarcodeRaw.trim() !== v.destBinBarcodeRaw.trim(), {
    message: 'Source and destination bins are the same — nothing to transfer.',
    path: ['destBinBarcodeRaw'],
  });
export type ScanTransferInput = z.infer<typeof ScanTransferInputSchema>;

export interface ScanTransferResponse {
  scanEvent: ScanEventView;
  /** The two ledger legs, written atomically: OUT of source, IN to destination. */
  outEntryId: string;
  inEntryId: string;
  sourceBin: { id: string; name: string };
  destBin: { id: string; name: string };
  sourceStockAfter: number;
  destStockAfter: number;
  duplicate: boolean;
}

// ══════════════════════════ Batch sync ══════════════════════════

/**
 * The offline queue's drain. Payloads are validated per item by the same schema
 * the individual endpoint uses, so this outer schema deliberately keeps
 * `payload` loose — a malformed item must fail *itself*, not reject the batch
 * at the pipe and strand every good scan behind it.
 */
export const ScanBatchSyncInputSchema = z.object({
  scans: z
    .array(
      z.object({
        type: z.enum(SCAN_TYPE),
        payload: z.record(z.unknown()),
        clientUuid: z.string().uuid(),
        clientTimestamp: z.string().datetime().nullish(),
        /** CYCLE_COUNT items need the session they belong to. */
        sessionId: z.string().max(60).nullish(),
      }),
    )
    .min(1, 'nothing to sync')
    /**
     * Chunk size, not queue size. Every request runs inside one interactive
     * transaction with Prisma's 5s ceiling, and while each scan is processed in
     * its own nested transaction, the outer one is still ticking. 50 keeps a
     * batch comfortably inside that budget; the client drains a longer queue as
     * successive chunks.
     */
    .max(50, 'sync at most 50 scans per request — send longer queues as several chunks'),
});
export type ScanBatchSyncInput = z.infer<typeof ScanBatchSyncInputSchema>;

export interface BatchSyncItemResult {
  clientUuid: string;
  status: (typeof SYNC_ITEM_STATUS)[number];
  /** Human-readable outcome, or the validation failure for an errored item. */
  detail: string;
  /** Field-level issues when the item failed schema validation. */
  issues?: { path: string; message: string }[];
}

export interface BatchSyncResponse {
  /** Same order as the request array, so the client can zip results to its queue. */
  results: BatchSyncItemResult[];
  summary: { total: number; succeeded: number; duplicates: number; failed: number };
}
