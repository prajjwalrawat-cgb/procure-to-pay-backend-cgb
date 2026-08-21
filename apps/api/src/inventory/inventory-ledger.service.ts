import { Injectable } from '@nestjs/common';
import { Prisma, newId } from '@procureflow/db';
import {
  DOMAIN_EVENTS,
  directionFor,
  type StockTxnType,
} from '@procureflow/shared';

import { DomainEventService } from '../common/events/domain-event.service';
import { PrismaService } from '../prisma/prisma.service';
import { InsufficientStockError, InventoryValidationError } from './inventory.errors';

/**
 * One ledger row. `direction` is deliberately absent — it is always derived from
 * `txnType` so a caller can never post an inward movement that decrements stock.
 * ADJUSTMENT is the sole exception and takes its sign from `signedQty`.
 */
export interface LedgerPostInput {
  productId: string;
  locationId: string;
  txnType: StockTxnType;
  /** Positive piece count. For ADJUSTMENT, pass `signedQty` instead. */
  qty?: number;
  /** ADJUSTMENT only — may be negative. */
  signedQty?: number;
  performedById: string;
  remark?: string | null;
  txnDate?: Date | null;

  vendorId?: string | null;
  purchaseOrderId?: string | null;
  invoiceId?: string | null;
  grnId?: string | null;
  rmaId?: string | null;
  grnNo?: string | null;
  gatePassNo?: string | null;
  rate?: Prisma.Decimal | null;
  taxPct?: Prisma.Decimal | null;
  qcStatus?: 'PENDING' | 'OK' | 'REJECTED' | null;
  damageQty?: number | null;
  /** Slice 13 — supplier batch/lot, captured at receipt and carried for FEFO. */
  batchNumber?: string | null;
  /**
   * Slice 13 — expiry of *this* consignment (not the product-level warranty
   * date). Never defaulted: a batch-tracked receipt without one is rejected
   * upstream rather than silently posted with a guessed date.
   */
  expiryDate?: Date | null;
  /**
   * Slice 14 — the box this movement went into or came out of. Null means the
   * stock is loose at the location, which is the normal case for most rows.
   *
   * Note for callers: `stockAt` and the outward sufficiency check below are
   * *location*-level and deliberately blind to boxes. Anything moving stock
   * between a box and the shelf it sits on must run its own box-aware check —
   * see BoxMovementService.
   */
  boxId?: string | null;

  issueDept?: 'PHOTOSHOOT' | 'SALES' | 'OTHER' | null;
  issuedToName?: string | null;
  approvedById?: string | null;
  balanceQty?: number | null;
  tentativeReturnDate?: Date | null;
  issueEntryId?: string | null;

  platform?: string | null;
  orderId?: string | null;
  customerName?: string | null;
  courierName?: string | null;
  trackingId?: string | null;
  paymentMode?: string | null;
  orderValue?: Prisma.Decimal | null;

  returnReason?: string | null;
  productCondition?: string | null;
  restockDecision?: boolean | null;

  correctionOfId?: string | null;
  importBatchId?: string | null;
  sourceRowRef?: string | null;

  /** Skip the outward stock-sufficiency check (explicit override only). */
  allowNegativeStock?: boolean;
}

export interface LocationQty {
  locationId: string;
  qty: number;
}

/**
 * InventoryLedgerService (Slice 12) — the ONLY write path into
 * `StockLedgerEntry`. The table is insert-only and immutable: there is no
 * update or delete method here, and a DB trigger blocks both at the storage
 * layer as well. Mistakes are corrected with an offsetting ADJUSTMENT entry
 * linked through `correctionOfId`.
 *
 * Current stock is always `SUM(qty * direction)` grouped by product + location —
 * never a stored counter, which would drift out of sync with the ledger.
 */
@Injectable()
export class InventoryLedgerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: DomainEventService,
  ) {}

  /**
   * Append one immutable movement. Runs inside the request's tenant transaction
   * (PrismaService.runInTenantContext), so the sufficiency check and the insert
   * are atomic against concurrent movements on the same product+location.
   */
  async post(input: LedgerPostInput): Promise<string> {
    const { qty, direction } = this.resolveQty(input);

    // Outward movements must not drive a location negative unless overridden.
    if (direction === -1 && !input.allowNegativeStock) {
      const available = await this.stockAt(input.productId, input.locationId);
      if (available < qty) {
        throw new InsufficientStockError(
          `Insufficient stock: ${available} available at this location, ${qty} requested.`,
          { productId: input.productId, locationId: input.locationId, available, requested: qty },
        );
      }
    }

    const id = newId('stockLedgerEntry');
    await this.prisma.client.stockLedgerEntry.create({
      data: {
        id,
        tenantId: this.tenantId(),
        productId: input.productId,
        locationId: input.locationId,
        txnType: input.txnType,
        qty,
        direction,
        vendorId: input.vendorId ?? null,
        purchaseOrderId: input.purchaseOrderId ?? null,
        invoiceId: input.invoiceId ?? null,
        grnId: input.grnId ?? null,
        rmaId: input.rmaId ?? null,
        grnNo: input.grnNo ?? null,
        gatePassNo: input.gatePassNo ?? null,
        rate: input.rate ?? null,
        taxPct: input.taxPct ?? null,
        qcStatus: input.qcStatus ?? null,
        damageQty: input.damageQty ?? 0,
        batchNumber: input.batchNumber ?? null,
        expiryDate: input.expiryDate ?? null,
        boxId: input.boxId ?? null,
        issueDept: input.issueDept ?? null,
        issuedToName: input.issuedToName ?? null,
        approvedById: input.approvedById ?? null,
        balanceQty: input.balanceQty ?? null,
        tentativeReturnDate: input.tentativeReturnDate ?? null,
        issueEntryId: input.issueEntryId ?? null,
        platform: input.platform ?? null,
        orderId: input.orderId ?? null,
        customerName: input.customerName ?? null,
        courierName: input.courierName ?? null,
        trackingId: input.trackingId ?? null,
        paymentMode: input.paymentMode ?? null,
        orderValue: input.orderValue ?? null,
        returnReason: input.returnReason ?? null,
        productCondition: input.productCondition ?? null,
        restockDecision: input.restockDecision ?? null,
        correctionOfId: input.correctionOfId ?? null,
        performedById: input.performedById,
        remark: input.remark ?? null,
        ...(input.txnDate ? { txnDate: input.txnDate } : {}),
        importBatchId: input.importBatchId ?? null,
        sourceRowRef: input.sourceRowRef ?? null,
      },
    });

    // "Last Updated" on the Master Inventory Sheet bumps on any movement, and
    // @updatedAt only fires on an actual update — so touch the product here.
    await this.prisma.client.product.update({
      where: { id: input.productId },
      data: { updatedAt: new Date() },
    });

    await this.events.emit(DOMAIN_EVENTS.INVENTORY_ENTRY_POSTED, {
      entryId: id,
      productId: input.productId,
      locationId: input.locationId,
      txnType: input.txnType,
      qty,
      direction,
      performedById: input.performedById,
    });

    if (direction === -1) await this.emitLowStockIfBreached(input.productId);
    return id;
  }

  /** On-hand quantity for a product at one location. */
  async stockAt(productId: string, locationId: string): Promise<number> {
    const rows = await this.prisma.client.$queryRaw<{ qty: bigint | null }[]>`
      SELECT COALESCE(SUM("qty" * "direction"), 0)::bigint AS qty
      FROM "StockLedgerEntry"
      WHERE "product_id" = ${productId} AND "location_id" = ${locationId}
    `;
    return Number(rows[0]?.qty ?? 0);
  }

  /** Total on-hand quantity for a product across every location. */
  async totalStock(productId: string): Promise<number> {
    const rows = await this.prisma.client.$queryRaw<{ qty: bigint | null }[]>`
      SELECT COALESCE(SUM("qty" * "direction"), 0)::bigint AS qty
      FROM "StockLedgerEntry"
      WHERE "product_id" = ${productId}
    `;
    return Number(rows[0]?.qty ?? 0);
  }

  /** Per-location breakdown for a product, zero-stock locations excluded. */
  async stockByLocation(productId: string): Promise<LocationQty[]> {
    const rows = await this.prisma.client.$queryRaw<
      { location_id: string; qty: bigint }[]
    >`
      SELECT "location_id", COALESCE(SUM("qty" * "direction"), 0)::bigint AS qty
      FROM "StockLedgerEntry"
      WHERE "product_id" = ${productId}
      GROUP BY "location_id"
      HAVING COALESCE(SUM("qty" * "direction"), 0) <> 0
      ORDER BY qty DESC
    `;
    return rows.map((r) => ({ locationId: r.location_id, qty: Number(r.qty) }));
  }

  /**
   * Per-location breakdown for many products in one round trip — the stock
   * overview grid would otherwise fire N queries per page.
   */
  async stockByLocationForProducts(
    productIds: string[],
  ): Promise<Map<string, LocationQty[]>> {
    const out = new Map<string, LocationQty[]>();
    if (productIds.length === 0) return out;

    const rows = await this.prisma.client.$queryRaw<
      { product_id: string; location_id: string; qty: bigint }[]
    >`
      SELECT "product_id", "location_id",
             COALESCE(SUM("qty" * "direction"), 0)::bigint AS qty
      FROM "StockLedgerEntry"
      WHERE "product_id" IN (${Prisma.join(productIds)})
      GROUP BY "product_id", "location_id"
      HAVING COALESCE(SUM("qty" * "direction"), 0) <> 0
      ORDER BY qty DESC
    `;
    for (const r of rows) {
      const list = out.get(r.product_id) ?? [];
      list.push({ locationId: r.location_id, qty: Number(r.qty) });
      out.set(r.product_id, list);
    }
    return out;
  }

  /**
   * Live unreturned balance for an INTERNAL_ISSUE: the issued quantity minus
   * every INTERNAL_RETURN linked to it. Derived rather than read from the
   * stored `balanceQty` snapshot so partial returns can never drift.
   */
  async openBalanceForIssue(issueEntryId: string): Promise<number> {
    const issue = await this.prisma.client.stockLedgerEntry.findUnique({
      where: { id: issueEntryId },
      select: { qty: true, txnType: true },
    });
    if (!issue || issue.txnType !== 'INTERNAL_ISSUE') return 0;

    const returned = await this.prisma.client.stockLedgerEntry.aggregate({
      where: { issueEntryId, txnType: 'INTERNAL_RETURN' },
      _sum: { qty: true },
    });
    return issue.qty - (returned._sum.qty ?? 0);
  }

  /** Derived open balances for many issues at once (open-issues board). */
  async openBalancesForIssues(issueIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (issueIds.length === 0) return out;

    const issues = await this.prisma.client.stockLedgerEntry.findMany({
      where: { id: { in: issueIds }, txnType: 'INTERNAL_ISSUE' },
      select: { id: true, qty: true },
    });
    for (const i of issues) out.set(i.id, i.qty);

    const returns = await this.prisma.client.stockLedgerEntry.groupBy({
      by: ['issueEntryId'],
      where: { issueEntryId: { in: issueIds }, txnType: 'INTERNAL_RETURN' },
      _sum: { qty: true },
    });
    for (const r of returns) {
      if (!r.issueEntryId) continue;
      const issued = out.get(r.issueEntryId);
      if (issued === undefined) continue;
      out.set(r.issueEntryId, issued - (r._sum.qty ?? 0));
    }
    return out;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Normalise qty/signedQty into a positive magnitude plus a derived sign. */
  private resolveQty(input: LedgerPostInput): { qty: number; direction: 1 | -1 } {
    const raw = input.txnType === 'ADJUSTMENT' ? input.signedQty : input.qty;
    if (raw === undefined || raw === null || !Number.isFinite(raw)) {
      throw new InventoryValidationError(
        input.txnType === 'ADJUSTMENT'
          ? 'signedQty is required for an ADJUSTMENT entry.'
          : 'qty is required.',
      );
    }
    if (!Number.isInteger(raw)) {
      throw new InventoryValidationError('Quantities must be whole pieces.');
    }
    if (raw === 0) {
      throw new InventoryValidationError('Quantity cannot be zero.');
    }
    if (input.txnType !== 'ADJUSTMENT' && raw < 0) {
      throw new InventoryValidationError(
        'qty must be positive — direction is derived from the transaction type.',
      );
    }
    if (input.damageQty != null && input.damageQty > Math.abs(raw)) {
      throw new InventoryValidationError('damageQty cannot exceed the movement quantity.');
    }
    return { qty: Math.abs(raw), direction: directionFor(input.txnType, raw) };
  }

  /** Fire a low-stock event when a movement leaves the product at/below reorder. */
  private async emitLowStockIfBreached(productId: string): Promise<void> {
    const product = await this.prisma.client.product.findUnique({
      where: { id: productId },
      select: { code: true, reorderPoint: true },
    });
    if (!product?.reorderPoint || product.reorderPoint <= 0) return;

    const current = await this.totalStock(productId);
    if (current > product.reorderPoint) return;

    await this.events.emit(DOMAIN_EVENTS.INVENTORY_LOW_STOCK, {
      productId,
      productCode: product.code,
      currentStock: current,
      reorderPoint: product.reorderPoint,
    });
  }

  private tenantId(): string {
    const tid = this.prisma.currentTenantId;
    if (!tid) throw new Error('No tenant context');
    return tid;
  }
}
