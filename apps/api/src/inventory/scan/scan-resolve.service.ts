import { Injectable } from '@nestjs/common';
import type {
  BarcodeMatchType,
  ScanProductView,
  ScanResolveResponse,
} from '@procureflow/shared';

import { PrismaService } from '../../prisma/prisma.service';
import { InventoryLedgerService } from '../inventory-ledger.service';
import { BarcodeNotFoundError, BinNotFoundError } from './scan.errors';
import { gtinVariants } from './gtin';

/** A resolved product plus how confident the match was. */
export interface ResolvedProduct {
  id: string;
  code: string;
  name: string;
  category: string;
  colour: string | null;
  unit: string;
  barcode: string | null;
  imageUrl: string | null;
  /** Product flag OR the bridged procurement item's `requiresBatch`. */
  requiresBatchTracking: boolean;
  matchType: BarcodeMatchType;
}

/** A resolved bin. Bins are leaf Locations; there is no separate Bin entity. */
export interface ResolvedBin {
  id: string;
  name: string;
  rackNo: string | null;
  barcode: string | null;
}

/** Everything the lookups need, in one shape, so the mapper stays honest. */
const PRODUCT_SELECT = {
  id: true,
  code: true,
  name: true,
  category: true,
  colour: true,
  unit: true,
  barcode: true,
  imageUrl: true,
  requiresBatchTracking: true,
  item: { select: { requiresBatch: true } },
} as const;

/**
 * ScanResolveService (Slice 13, Module 2) — turns whatever came off the camera
 * into a Product.
 *
 * Four strategies, tried in descending confidence:
 *   1. exact match on `Product.barcode`     — the printed EAN/UPC
 *   2. exact match on `Product.code`        — the internal warehouse SKU, typed
 *                                             in by hand when a label is torn
 *   3. exact match on the bridged `Item.skuCode` (procurement master)
 *   4. GTIN normalisation — the same article padded to 8/12/13/14 digits
 *
 * Anything else is a 404 carrying the raw value, never a guess. A wrong product
 * on a receive scan writes a wrong ledger row, and the ledger is immutable.
 */
@Injectable()
export class ScanResolveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: InventoryLedgerService,
  ) {}

  /** Resolve a scanned barcode to a product, or throw a 404 with the raw value. */
  async resolveBarcode(raw: string): Promise<ResolvedProduct> {
    const value = raw.trim();

    // 1 — the printed barcode. Active products only: a deactivated SKU should
    // not silently absorb stock, and the operator needs to be told why.
    const byBarcode = await this.prisma.client.product.findFirst({
      where: { barcode: value, active: true },
      select: PRODUCT_SELECT,
    });
    if (byBarcode) return this.toResolved(byBarcode, 'exact_barcode');

    // 2 — the internal warehouse SKU (`Product.code`), and the legacy SKU the
    // migration preserved, which is what is still printed on older stock.
    const byCode = await this.prisma.client.product.findFirst({
      where: { active: true, OR: [{ code: value }, { legacySku: value }] },
      select: PRODUCT_SELECT,
    });
    if (byCode) return this.toResolved(byCode, 'exact_sku_code');

    // 3 — the procurement item master, reachable for products that were bridged.
    const byItemSku = await this.prisma.client.product.findFirst({
      where: { active: true, item: { skuCode: value } },
      select: PRODUCT_SELECT,
    });
    if (byItemSku) return this.toResolved(byItemSku, 'exact_sku_code');

    // 4 — GTIN padding variants. Skipped entirely for non-numeric codes, so an
    // alphanumeric internal code can never fuzzy-match a numeric barcode.
    const variants = gtinVariants(value);
    if (variants.length > 0) {
      const byGtin = await this.prisma.client.product.findFirst({
        where: { active: true, barcode: { in: variants } },
        select: PRODUCT_SELECT,
      });
      if (byGtin) return this.toResolved(byGtin, 'fuzzy_gtin');
    }

    throw new BarcodeNotFoundError(value);
  }

  /** The full resolve response, including live stock, for `POST /scan/resolve`. */
  async resolveView(raw: string): Promise<ScanResolveResponse> {
    const product = await this.resolveBarcode(raw);
    const currentStock = await this.ledger.totalStock(product.id);
    const view: ScanProductView = {
      id: product.id,
      code: product.code,
      name: product.name,
      category: product.category,
      colour: product.colour,
      unit: product.unit,
      barcode: product.barcode,
      imageUrl: product.imageUrl,
      requiresBatchTracking: product.requiresBatchTracking,
      currentStock,
    };
    return { product: view, matchType: product.matchType };
  }

  /**
   * Resolve a bin label. Falls back to the location *name* so a warehouse that
   * has not finished labelling its racks can still use the scanner with manual
   * entry — the same fallback the UI offers for a damaged product barcode.
   */
  async resolveBin(raw: string): Promise<ResolvedBin> {
    const value = raw.trim();
    const bin = await this.prisma.client.location.findFirst({
      where: { active: true, OR: [{ barcode: value }, { name: value }] },
      select: { id: true, name: true, rackNo: true, barcode: true },
    });
    if (!bin) throw new BinNotFoundError(value);
    return bin;
  }

  /**
   * The effective batch requirement. A product carries its own flag; products
   * bridged to the procurement master inherit `Item.requiresBatch` as well, so
   * neither catalogue can quietly disagree about whether expiry is mandatory.
   */
  private toResolved(
    row: {
      id: string;
      code: string;
      name: string;
      category: string;
      colour: string | null;
      unit: string;
      barcode: string | null;
      imageUrl: string | null;
      requiresBatchTracking: boolean;
      item: { requiresBatch: boolean } | null;
    },
    matchType: BarcodeMatchType,
  ): ResolvedProduct {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      category: row.category,
      colour: row.colour,
      unit: row.unit,
      barcode: row.barcode,
      imageUrl: row.imageUrl,
      requiresBatchTracking:
        row.requiresBatchTracking || (row.item?.requiresBatch ?? false),
      matchType,
    };
  }
}
