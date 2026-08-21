import { Injectable } from '@nestjs/common';
import { Prisma } from '@procureflow/db';
import type {
  LedgerEntryView,
  LedgerQuery,
  LedgerResponse,
  LocationStockBreakdown,
  PendingDispositionResponse,
  ProductDetailResponse,
  ProductListItem,
  ProductListQuery,
  ProductListResponse,
  ProductStockResponse,
  ProductStockSummary,
} from '@procureflow/shared';

import { PrismaService } from '../prisma/prisma.service';
import { InventoryLedgerService } from './inventory-ledger.service';
import { ProductService } from './product.service';

/** Raw shape of one `product_stock_summary` row. */
interface SummaryRow {
  product_id: string;
  opening_stock: bigint;
  total_in: bigint;
  total_out: bigint;
  return_qty: bigint;
  damage_qty: bigint;
  current_stock: bigint;
  last_movement_at: Date | null;
}

const EMPTY_SUMMARY: ProductStockSummary = {
  openingStock: 0,
  totalIn: 0,
  totalOut: 0,
  returnQty: 0,
  damageQty: 0,
  currentStock: 0,
  lastMovementAt: null,
};

/** Ledger row + the joins every view needs. */
const LEDGER_INCLUDE = {
  product: { select: { code: true, name: true, colour: true } },
  location: { select: { name: true } },
  vendor: { select: { name: true } },
  purchaseOrder: { select: { number: true } },
} as const;

type LedgerRow = Prisma.StockLedgerEntryGetPayload<{ include: typeof LEDGER_INCLUDE }>;

/**
 * InventoryQueryService (Slice 12). All inventory reads: the stock overview,
 * the product detail drawer, and the one ledger endpoint that powers every
 * report screen.
 *
 * Derived stock figures come from the `product_stock_summary` view rather than
 * Product columns — writing them as columns would let them drift out of sync
 * with the immutable ledger, which is the whole point of the design.
 */
@Injectable()
export class InventoryQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: InventoryLedgerService,
    private readonly products: ProductService,
  ) {}

  // ══════════════════════ Stock overview ══════════════════════

  async listProducts(query: ProductListQuery): Promise<ProductListResponse> {
    const where: Prisma.ProductWhereInput = {};
    if (query.q) {
      where.OR = [
        { code: { contains: query.q, mode: 'insensitive' } },
        { name: { contains: query.q, mode: 'insensitive' } },
        { colour: { contains: query.q, mode: 'insensitive' } },
        { legacySku: { contains: query.q, mode: 'insensitive' } },
      ];
    }
    if (query.category) where.category = query.category;
    if (query.active !== null && query.active !== undefined) where.active = query.active;
    // "Held at this location" means a non-zero balance there, so filter on
    // products with ledger history at the location and drop the zeroes below.
    if (query.locationId) {
      where.ledgerEntries = { some: { locationId: query.locationId } };
    }

    const rows = await this.prisma.client.product.findMany({
      where,
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;

    const ids = page.map((p) => p.id);
    const [summaries, breakdowns, locationNames] = await Promise.all([
      this.summariesFor(ids),
      this.ledger.stockByLocationForProducts(ids),
      this.locationNameMap(),
    ]);

    let items: ProductListItem[] = page.map((p) => {
      const summary = summaries.get(p.id) ?? EMPTY_SUMMARY;
      const locations = this.decorateLocations(
        breakdowns.get(p.id) ?? [],
        locationNames,
        query.locationId,
      );
      return {
        id: p.id,
        code: p.code,
        name: p.name,
        category: p.category,
        colour: p.colour,
        barcode: p.barcode,
        requiresBatchTracking: p.requiresBatchTracking,
        imageUrl: p.imageUrl,
        unit: p.unit,
        reorderPoint: p.reorderPoint,
        active: p.active,
        currentStock: summary.currentStock,
        lowStock: this.isLowStock(summary.currentStock, p.reorderPoint),
        locations,
        updatedAt: p.updatedAt.toISOString(),
      };
    });

    // Filters that depend on ledger aggregates can only be applied after the
    // summary join, so they narrow the page rather than the SQL query.
    if (query.locationId) items = items.filter((i) => i.locations.length > 0);
    if (query.lowStock) items = items.filter((i) => i.lowStock);

    return {
      items,
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      totalEstimate: await this.prisma.client.product.count({ where }),
    };
  }

  /**
   * The product detail drawer — the one screen that must account for every
   * Master Inventory Sheet column, including the ones superseded by `code`.
   */
  async productDetail(productId: string): Promise<ProductDetailResponse> {
    const p = await this.products.require(productId);
    const [summary, breakdown, locationNames] = await Promise.all([
      this.summaryFor(productId),
      this.ledger.stockByLocation(productId),
      this.locationNameMap(),
    ]);

    return {
      id: p.id,
      code: p.code,
      name: p.name,
      category: p.category,
      colour: p.colour,
      barcode: p.barcode,
      requiresBatchTracking: p.requiresBatchTracking,
      imageUrl: p.imageUrl,
      unit: p.unit,
      reorderPoint: p.reorderPoint,
      active: p.active,
      currentStock: summary.currentStock,
      lowStock: this.isLowStock(summary.currentStock, p.reorderPoint),
      locations: this.decorateLocations(breakdown, locationNames),
      updatedAt: p.updatedAt.toISOString(),
      legacyProductId: p.legacyProductId,
      legacySku: p.legacySku,
      expiryOrWarrantyDate: p.expiryOrWarrantyDate?.toISOString() ?? null,
      remark: p.remark,
      itemId: p.itemId,
      createdFromImportBatchId: p.createdFromImportBatchId,
      createdAt: p.createdAt.toISOString(),
      summary,
    };
  }

  /** GET /inventory/products/:id/stock — by location + total. */
  async productStock(productId: string): Promise<ProductStockResponse> {
    const p = await this.products.require(productId);
    const [summary, breakdown, locationNames] = await Promise.all([
      this.summaryFor(productId),
      this.ledger.stockByLocation(productId),
      this.locationNameMap(),
    ]);
    return {
      productId: p.id,
      code: p.code,
      name: p.name,
      total: summary.currentStock,
      locations: this.decorateLocations(breakdown, locationNames),
      summary,
    };
  }

  // ══════════════════════ Ledger / reports ══════════════════════

  /**
   * The single ledger read. Every legacy report sheet is a saved filter over
   * this, not a separate table.
   */
  async ledgerEntries(query: LedgerQuery): Promise<LedgerResponse> {
    const where: Prisma.StockLedgerEntryWhereInput = {};
    if (query.product) where.productId = query.product;
    if (query.location) where.locationId = query.location;
    if (query.txnType) where.txnType = query.txnType;
    if (query.issueDept) where.issueDept = query.issueDept;
    if (query.vendorId) where.vendorId = query.vendorId;
    if (query.orderId) where.orderId = query.orderId;
    if (query.from || query.to) {
      where.txnDate = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }
    // "Open" is derived, so narrow to issues here and filter on the computed
    // balance once the rows (and their linked returns) are loaded.
    if (query.openOnly) where.txnType = 'INTERNAL_ISSUE';

    const rows = await this.prisma.client.stockLedgerEntry.findMany({
      where,
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ txnDate: 'desc' }, { id: 'desc' }],
      include: LEDGER_INCLUDE,
    });
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;

    let items = await this.toLedgerViews(page);
    if (query.openOnly) items = items.filter((i) => i.issueStatus === 'OPEN');

    return {
      items,
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      totalEstimate: await this.prisma.client.stockLedgerEntry.count({ where }),
    };
  }

  async ledgerEntry(entryId: string): Promise<LedgerEntryView | null> {
    const row = await this.prisma.client.stockLedgerEntry.findUnique({
      where: { id: entryId },
      include: LEDGER_INCLUDE,
    });
    if (!row) return null;
    return (await this.toLedgerViews([row]))[0] ?? null;
  }

  /**
   * Work queues: receipts still awaiting a QC verdict, and customer returns
   * still awaiting a restock decision (business rules 2 and 5).
   */
  async pendingDispositions(): Promise<PendingDispositionResponse> {
    const [qcRows, restockRows] = await Promise.all([
      this.prisma.client.stockLedgerEntry.findMany({
        where: { txnType: { in: ['VENDOR_INWARD', 'SAMPLE_INWARD'] }, qcStatus: 'PENDING' },
        orderBy: [{ txnDate: 'desc' }, { id: 'desc' }],
        take: 100,
        include: LEDGER_INCLUDE,
      }),
      this.prisma.client.stockLedgerEntry.findMany({
        where: { txnType: 'CUSTOMER_RETURN_IN', restockDecision: null },
        orderBy: [{ txnDate: 'desc' }, { id: 'desc' }],
        take: 100,
        include: LEDGER_INCLUDE,
      }),
    ]);
    return {
      qcPending: await this.toLedgerViews(qcRows),
      restockPending: await this.toLedgerViews(restockRows),
    };
  }

  // ══════════════════════ internals ══════════════════════

  /**
   * Read the derived summary view for a set of products. The view groups by
   * tenant_id and runs with `security_invoker`, and we filter on tenant here as
   * well so a missing GUC can never widen the result.
   */
  private async summariesFor(
    productIds: string[],
  ): Promise<Map<string, ProductStockSummary>> {
    const out = new Map<string, ProductStockSummary>();
    if (productIds.length === 0) return out;

    const rows = await this.prisma.client.$queryRaw<SummaryRow[]>`
      SELECT product_id, opening_stock, total_in, total_out,
             return_qty, damage_qty, current_stock, last_movement_at
      FROM product_stock_summary
      WHERE tenant_id = ${this.tenantId()}::uuid
        AND product_id IN (${Prisma.join(productIds)})
    `;
    for (const r of rows) out.set(r.product_id, this.toSummary(r));
    return out;
  }

  private async summaryFor(productId: string): Promise<ProductStockSummary> {
    return (await this.summariesFor([productId])).get(productId) ?? EMPTY_SUMMARY;
  }

  private toSummary(r: SummaryRow): ProductStockSummary {
    return {
      openingStock: Number(r.opening_stock),
      totalIn: Number(r.total_in),
      totalOut: Number(r.total_out),
      returnQty: Number(r.return_qty),
      damageQty: Number(r.damage_qty),
      currentStock: Number(r.current_stock),
      lastMovementAt: r.last_movement_at ? r.last_movement_at.toISOString() : null,
    };
  }

  private async locationNameMap(): Promise<
    Map<string, { name: string; rackNo: string | null }>
  > {
    const rows = await this.prisma.client.location.findMany({
      select: { id: true, name: true, rackNo: true },
    });
    return new Map(rows.map((r) => [r.id, { name: r.name, rackNo: r.rackNo }]));
  }

  private decorateLocations(
    breakdown: { locationId: string; qty: number }[],
    names: Map<string, { name: string; rackNo: string | null }>,
    onlyLocationId?: string | null,
  ): LocationStockBreakdown[] {
    return breakdown
      .filter((b) => !onlyLocationId || b.locationId === onlyLocationId)
      .map((b) => ({
        locationId: b.locationId,
        locationName: names.get(b.locationId)?.name ?? 'Unknown',
        rackNo: names.get(b.locationId)?.rackNo ?? null,
        qty: b.qty,
      }));
  }

  private isLowStock(currentStock: number, reorderPoint: number | null): boolean {
    return reorderPoint !== null && reorderPoint > 0 && currentStock <= reorderPoint;
  }

  /**
   * Project ledger rows to the wire shape, resolving the derived open balance
   * for INTERNAL_ISSUE rows in one batched pass rather than per row.
   */
  private async toLedgerViews(rows: LedgerRow[]): Promise<LedgerEntryView[]> {
    const issueIds = rows.filter((r) => r.txnType === 'INTERNAL_ISSUE').map((r) => r.id);
    const balances = await this.ledger.openBalancesForIssues(issueIds);

    return rows.map((r) => {
      const balance = r.txnType === 'INTERNAL_ISSUE' ? (balances.get(r.id) ?? 0) : null;
      return {
        id: r.id,
        productId: r.productId,
        productCode: r.product.code,
        productName: r.product.name,
        colour: r.product.colour,
        locationId: r.locationId,
        locationName: r.location.name,
        txnType: r.txnType,
        qty: r.qty,
        direction: r.direction,
        signedQty: r.qty * r.direction,
        vendorId: r.vendorId,
        vendorName: r.vendor?.name ?? null,
        purchaseOrderId: r.purchaseOrderId,
        purchaseOrderNumber: r.purchaseOrder?.number ?? null,
        grnNo: r.grnNo,
        gatePassNo: r.gatePassNo,
        rate: r.rate?.toString() ?? null,
        taxPct: r.taxPct?.toString() ?? null,
        qcStatus: r.qcStatus,
        damageQty: r.damageQty,
        issueDept: r.issueDept,
        issuedToName: r.issuedToName,
        approvedById: r.approvedById,
        balanceQty: balance,
        issueStatus: balance === null ? null : balance > 0 ? 'OPEN' : 'CLOSED',
        tentativeReturnDate: r.tentativeReturnDate?.toISOString() ?? null,
        platform: r.platform,
        orderId: r.orderId,
        customerName: r.customerName,
        courierName: r.courierName,
        trackingId: r.trackingId,
        paymentMode: r.paymentMode,
        orderValue: r.orderValue?.toString() ?? null,
        returnReason: r.returnReason,
        productCondition: r.productCondition,
        restockDecision: r.restockDecision,
        correctionOfId: r.correctionOfId,
        performedById: r.performedById,
        remark: r.remark,
        txnDate: r.txnDate.toISOString(),
        importBatchId: r.importBatchId,
        sourceRowRef: r.sourceRowRef,
      };
    });
  }

  private tenantId(): string {
    const tid = this.prisma.currentTenantId;
    if (!tid) throw new Error('No tenant context');
    return tid;
  }
}
