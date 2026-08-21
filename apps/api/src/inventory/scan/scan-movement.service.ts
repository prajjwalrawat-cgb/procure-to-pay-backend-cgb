import { Injectable } from '@nestjs/common';

import { InventoryLedgerService } from '../inventory-ledger.service';
import { FefoService } from './fefo.service';

/** The ledger rows a bin-to-bin move produced, in allocation order. */
export interface TransferLegs {
  outEntryIds: string[];
  inEntryIds: string[];
  allocations: { batchNumber: string | null; expiryDate: Date | null; qty: number }[];
}

/**
 * ScanMovementService (Slice 13) — the shared "move stock between locations"
 * primitive behind both putaway (Module 4) and transfer (Module 7).
 *
 * Two design points worth stating, because neither is obvious:
 *
 * **Why a pair of rows.** The Slice 12 ledger has no location-change movement
 * type and no mutable location column — a row's location is part of the
 * immutable record of what happened. So a move is expressed the only way an
 * insert-only ledger can express it: an outward leg at the source and an inward
 * leg at the destination, posted together. `current_stock` nets to zero across
 * the pair, which is exactly right — nothing entered or left the warehouse.
 *
 * **Why it is batch-aware.** Receiving happens at the dock and picking happens
 * at the bin, so every unit passes through at least one move on its way to being
 * picked. If a move dropped the batch and expiry, FEFO would be blind by the
 * time it mattered. Each leg therefore carries the batch it moved, allocated
 * oldest-expiry-first from the source.
 */
@Injectable()
export class ScanMovementService {
  constructor(
    private readonly ledger: InventoryLedgerService,
    private readonly fefo: FefoService,
  ) {}

  /**
   * Move `qty` of a product from one location to another, preserving batches.
   *
   * Atomicity is the request transaction's: the caller runs inside
   * `runInTenantContext`, so if the inward leg throws, the outward leg it was
   * paired with is rolled back with it. There is no window in which stock has
   * left the source without arriving at the destination.
   */
  async move(params: {
    productId: string;
    fromLocationId: string;
    toLocationId: string;
    qty: number;
    performedById: string;
    remark?: string | null;
    txnDate?: Date | null;
  }): Promise<TransferLegs> {
    const allocations = await this.fefo.allocate(
      params.productId,
      params.fromLocationId,
      params.qty,
    );

    const outEntryIds: string[] = [];
    const inEntryIds: string[] = [];

    for (const alloc of allocations) {
      const outId = await this.ledger.post({
        productId: params.productId,
        locationId: params.fromLocationId,
        txnType: 'TRANSFER_OUT',
        qty: alloc.qty,
        batchNumber: alloc.batchNumber,
        expiryDate: alloc.expiryDate,
        performedById: params.performedById,
        remark: params.remark ?? null,
        txnDate: params.txnDate ?? null,
      });
      outEntryIds.push(outId);

      const inId = await this.ledger.post({
        productId: params.productId,
        locationId: params.toLocationId,
        txnType: 'TRANSFER_IN',
        qty: alloc.qty,
        batchNumber: alloc.batchNumber,
        expiryDate: alloc.expiryDate,
        performedById: params.performedById,
        remark: params.remark ?? null,
        txnDate: params.txnDate ?? null,
        // The outward leg above already removed this quantity from the source in
        // the same transaction; the destination check would be about the wrong
        // location anyway. Sufficiency was enforced by the FEFO allocation.
        allowNegativeStock: true,
      });
      inEntryIds.push(inId);
    }

    return {
      outEntryIds,
      inEntryIds,
      allocations: allocations.map((a) => ({
        batchNumber: a.batchNumber,
        expiryDate: a.expiryDate,
        qty: a.qty,
      })),
    };
  }
}
