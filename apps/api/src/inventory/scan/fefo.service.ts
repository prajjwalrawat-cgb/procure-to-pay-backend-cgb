import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { InsufficientStockError } from '../inventory.errors';

/** On-hand for one batch of one product at one location. */
export interface BatchBalance {
  batchNumber: string | null;
  expiryDate: Date | null;
  qty: number;
}

/** One leg of an allocation: take `qty` from this batch. */
export interface BatchAllocation extends BatchBalance {
  qty: number;
}

/** An allocation leg that also names the location it came from. */
export interface LocatedAllocation extends BatchAllocation {
  locationId: string;
}

/**
 * FefoService (Slice 13) — First-Expired-First-Out allocation.
 *
 * There was no FEFO in the codebase before this: the Slice 12 ledger tracked
 * product × location only, with no batch grain, so "oldest expiry first" had
 * nothing to sort by. Batch and expiry now ride on each ledger row, and a
 * batch's on-hand at a location is derived the same way every other quantity in
 * this module is — `SUM(qty * direction)` — never a stored counter.
 *
 * Ordering rule: earliest expiry first; rows with no expiry sort **last**.
 * Undated stock is not "infinitely fresh", but consuming it ahead of stock with
 * a known, distant expiry would be worse — it would let a dated batch age out
 * while undated stock sat behind it.
 */
@Injectable()
export class FefoService {
  constructor(private readonly prisma: PrismaService) {}

  /** Per-batch on-hand at one location, expiry-ascending. Empty batches omitted. */
  async batchesAt(productId: string, locationId: string): Promise<BatchBalance[]> {
    const rows = await this.prisma.client.$queryRaw<
      { batch_number: string | null; expiry_date: Date | null; qty: bigint }[]
    >`
      SELECT "batch_number", "expiry_date",
             COALESCE(SUM("qty" * "direction"), 0)::bigint AS qty
      FROM "StockLedgerEntry"
      WHERE "product_id" = ${productId} AND "location_id" = ${locationId}
      GROUP BY "batch_number", "expiry_date"
      HAVING COALESCE(SUM("qty" * "direction"), 0) > 0
      ORDER BY "expiry_date" ASC NULLS LAST, "batch_number" ASC NULLS LAST
    `;
    return rows.map((r) => ({
      batchNumber: r.batch_number,
      expiryDate: r.expiry_date,
      qty: Number(r.qty),
    }));
  }

  /**
   * Draw `qty` from a location, oldest expiry first, splitting across batches
   * when no single batch can cover it.
   *
   * Throws rather than partially allocating: a pick that can only be half
   * satisfied is a decision for the operator, not something to silently round
   * down inside an allocator.
   */
  async allocate(
    productId: string,
    locationId: string,
    qty: number,
  ): Promise<BatchAllocation[]> {
    const batches = await this.batchesAt(productId, locationId);
    const available = batches.reduce((sum, b) => sum + b.qty, 0);
    if (available < qty) {
      throw new InsufficientStockError(
        `Insufficient stock: ${available} available at this location, ${qty} requested.`,
        { productId, locationId, available, requested: qty },
      );
    }

    const allocations: BatchAllocation[] = [];
    let outstanding = qty;
    for (const batch of batches) {
      if (outstanding === 0) break;
      const take = Math.min(batch.qty, outstanding);
      allocations.push({ ...batch, qty: take });
      outstanding -= take;
    }
    return allocations;
  }

  /**
   * Warehouse-wide FEFO allocation for picking, where the operator scans a SKU
   * against an order rather than standing at a nominated bin.
   *
   * Already-expired batches are excluded outright: they are physically present
   * and will show up in an on-hand total, but shipping them to a customer is not
   * a decision an allocator gets to make silently. The shortfall message says so
   * explicitly, so the operator can see stock exists but is not shippable.
   */
  async allocateForPick(
    productId: string,
    qty: number,
    now: Date = new Date(),
  ): Promise<LocatedAllocation[]> {
    const rows = await this.prisma.client.$queryRaw<
      {
        location_id: string;
        batch_number: string | null;
        expiry_date: Date | null;
        qty: bigint;
      }[]
    >`
      SELECT "location_id", "batch_number", "expiry_date",
             COALESCE(SUM("qty" * "direction"), 0)::bigint AS qty
      FROM "StockLedgerEntry"
      WHERE "product_id" = ${productId}
      GROUP BY "location_id", "batch_number", "expiry_date"
      HAVING COALESCE(SUM("qty" * "direction"), 0) > 0
      ORDER BY "expiry_date" ASC NULLS LAST, "location_id" ASC
    `;

    const all = rows.map((r) => ({
      locationId: r.location_id,
      batchNumber: r.batch_number,
      expiryDate: r.expiry_date,
      qty: Number(r.qty),
    }));
    const shippable = all.filter(
      (b) => !b.expiryDate || b.expiryDate.getTime() > now.getTime(),
    );

    const available = shippable.reduce((sum, b) => sum + b.qty, 0);
    if (available < qty) {
      const expired = all.reduce((sum, b) => sum + b.qty, 0) - available;
      throw new InsufficientStockError(
        expired > 0
          ? `Insufficient stock: ${available} shippable, ${qty} requested (${expired} excluded as expired).`
          : `Insufficient stock: ${available} available, ${qty} requested.`,
        { productId, available, requested: qty, expiredExcluded: expired },
      );
    }

    const allocations: LocatedAllocation[] = [];
    let outstanding = qty;
    for (const batch of shippable) {
      if (outstanding === 0) break;
      const take = Math.min(batch.qty, outstanding);
      allocations.push({ ...batch, qty: take });
      outstanding -= take;
    }
    return allocations;
  }

  /**
   * Total on-hand across every batch at a location. Equivalent to the ledger
   * service's `stockAt`, but reads the same grouped rows the allocator uses, so
   * a caller checking availability and then allocating can never see the two
   * disagree within one transaction.
   */
  async availableAt(productId: string, locationId: string): Promise<number> {
    const batches = await this.batchesAt(productId, locationId);
    return batches.reduce((sum, b) => sum + b.qty, 0);
  }
}
