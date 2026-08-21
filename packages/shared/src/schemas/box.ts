import { z } from 'zod';

import { LOCATION_KIND } from '../constants/inventory-status';

/**
 * Physical box tracking contracts (Slice 14).
 *
 * Two questions this module exists to answer, both derived from the ledger
 * rather than stored anywhere:
 *
 *   "What is in this box?"        — scan a box, see its contents
 *   "Where is this product?"      — warehouse → rack → section → box → qty
 */

const positiveQty = z.number().int().positive('quantity must be greater than zero');
const barcodeRaw = z.string().trim().min(1, 'a barcode is required').max(120);

// ══════════════════════════ Box master ══════════════════════════

export const BoxCreateInputSchema = z.object({
  /**
   * The label printed on the box. Optional on create: a warehouse printing its
   * own labels wants the server to allocate the code, while one using
   * pre-printed labels needs to supply what is already stuck on the carton.
   */
  barcode: z.string().trim().max(120).nullish(),
  /** Section it starts in. Optional — a flat-packed empty box is nowhere yet. */
  locationId: z.string().max(60).nullish(),
  notes: z.string().max(2000).nullish(),
});
export type BoxCreateInput = z.infer<typeof BoxCreateInputSchema>;

/** One product/batch line inside a box, derived from the ledger. */
export interface BoxContentLine {
  productId: string;
  productCode: string;
  productName: string;
  barcode: string | null;
  batchNumber: string | null;
  expiryDate: string | null;
  qty: number;
  /** True when the expiry has already passed — flagged, never silently hidden. */
  expired: boolean;
}

/** The ancestry of a location: warehouse → rack → section. */
export interface LocationPath {
  warehouse: string | null;
  rack: string | null;
  section: string | null;
  /** Every level, outermost first, for display when the tree is deeper. */
  full: { id: string; name: string; kind: (typeof LOCATION_KIND)[number] }[];
}

/**
 * What the handset shows when a box barcode is scanned: where the box is, and
 * everything inside it.
 */
export interface BoxDetailResponse {
  id: string;
  code: string;
  barcode: string;
  active: boolean;
  notes: string | null;
  location: {
    id: string;
    name: string;
    kind: (typeof LOCATION_KIND)[number];
    path: LocationPath;
  } | null;
  contents: BoxContentLine[];
  /** Total pieces across every line — the number an operator sanity-checks. */
  totalQty: number;
  distinctProducts: number;
  lastMovedAt: string | null;
}

export interface BoxListItem {
  id: string;
  code: string;
  barcode: string;
  locationName: string | null;
  totalQty: number;
  distinctProducts: number;
}

export const BoxListQuerySchema = z.object({
  q: z.string().max(120).nullish(),
  locationId: z.string().max(60).nullish(),
  /** Only boxes holding this product — the reverse lookup, narrowed. */
  productId: z.string().max(60).nullish(),
  active: z.coerce.boolean().nullish(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type BoxListQuery = z.infer<typeof BoxListQuerySchema>;

// ══════════════════════════ Putting stock into a box ══════════════════════════

/**
 * Move stock that is already at a location into a box sitting at that same
 * location. Not a stock movement in the accounting sense — the pieces do not
 * leave the section — but it must still be a ledger pair, because "in box B"
 * and "loose on the shelf" are different physical places to look.
 */
export const BoxPackInputSchema = z.object({
  boxBarcodeRaw: barcodeRaw,
  barcodeRaw,
  quantity: positiveQty,
  /** Which batch to take. Omitted means FEFO picks the oldest. */
  batchNumber: z.string().max(120).nullish(),
  deviceId: z.string().min(1).max(120).nullish(),
  clientUuid: z.string().uuid().nullish(),
  remark: z.string().max(2000).nullish(),
});
export type BoxPackInput = z.infer<typeof BoxPackInputSchema>;

/** Take stock back out of a box, leaving it loose at the same location. */
export const BoxUnpackInputSchema = BoxPackInputSchema;
export type BoxUnpackInput = z.infer<typeof BoxUnpackInputSchema>;

// ══════════════════════════ Moving a box ══════════════════════════

/**
 * Move a whole box to another section. Everything inside travels with it: the
 * service posts a transfer pair per product/batch so the ledger keeps telling
 * the truth about where stock physically is.
 */
export const BoxMoveInputSchema = z
  .object({
    boxBarcodeRaw: barcodeRaw,
    /** Destination section, by label or id. */
    toBinBarcodeRaw: barcodeRaw.nullish(),
    toLocationId: z.string().max(60).nullish(),
    deviceId: z.string().min(1).max(120).nullish(),
    clientUuid: z.string().uuid().nullish(),
    remark: z.string().max(2000).nullish(),
  })
  .refine((v) => !!v.toBinBarcodeRaw || !!v.toLocationId, {
    message: 'A destination is required: scan the section label or pass a location id.',
    path: ['toBinBarcodeRaw'],
  });
export type BoxMoveInput = z.infer<typeof BoxMoveInputSchema>;

export interface BoxMoveResponse {
  box: BoxDetailResponse;
  from: { id: string; name: string } | null;
  to: { id: string; name: string };
  /** Ledger rows written — 0 when the box was empty. */
  entriesPosted: number;
  duplicate: boolean;
}

// ══════════════════════════ Reverse lookup ══════════════════════════

/** One physical place a product is stored, boxed or loose. */
export interface ProductLocationRow {
  locationId: string;
  path: LocationPath;
  /** Null when the stock is loose on the shelf rather than in a box. */
  box: { id: string; code: string; barcode: string } | null;
  batchNumber: string | null;
  expiryDate: string | null;
  qty: number;
}

/**
 * "Where exactly is this product physically stored?" — every place it sits,
 * with the full warehouse → rack → section → box path and the quantity there.
 */
export interface ProductWhereResponse {
  product: { id: string; code: string; name: string; barcode: string | null };
  totalQty: number;
  rows: ProductLocationRow[];
}
