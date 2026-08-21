import { Injectable } from '@nestjs/common';
import { newId } from '@procureflow/db';
import type { BoxMoveInput, BoxMoveResponse, BoxPackInput } from '@procureflow/shared';

import { AuditLogService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryLedgerService } from '../inventory-ledger.service';
import { ScanResolveService } from '../scan/scan-resolve.service';
import { BoxService } from './box.service';
import { BoxStateError, BoxValidationError } from './box.errors';

/** On-hand for one batch in one specific place (location + box, or loose). */
interface PlacedBatch {
  batchNumber: string | null;
  expiryDate: Date | null;
  qty: number;
}

/**
 * BoxMovementService (Slice 14) — putting stock into a box, taking it out, and
 * moving a box with everything inside it.
 *
 * **Why moving a box writes ledger rows.** The alternative — just repointing
 * `Box.locationId` and treating the box as the authority on where its contents
 * are — would quietly break every existing stock-by-location figure in the
 * module, because those aggregate the ledger's `location_id`. Boxed stock would
 * keep reporting the section where it was *packed*. So a box move posts a
 * TRANSFER_OUT / TRANSFER_IN pair per product and batch inside it, and the
 * ledger stays the single authority on where stock physically is.
 *
 * **Why the sufficiency checks are local.** `InventoryLedgerService.post`
 * guards against driving a *location* negative, which is the right check for
 * shelf movements and the wrong one here: moving stock from the shelf into a box
 * standing on that same shelf does not change the location total at all. Each
 * operation below therefore checks the box-aware balance itself before posting,
 * and passes `allowNegativeStock` so the location-level check does not
 * second-guess a movement it cannot see correctly.
 */
@Injectable()
export class BoxMovementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly boxes: BoxService,
    private readonly resolve: ScanResolveService,
    private readonly ledger: InventoryLedgerService,
    private readonly audit: AuditLogService,
  ) {}

  // ── pack / unpack ──────────────────────────────────────────────────────────

  /** Move loose stock at a location into a box standing at that location. */
  async pack(input: BoxPackInput, actorId: string): Promise<BoxMoveResponse> {
    return this.shift(input, actorId, 'IN');
  }

  /** Take stock out of a box, leaving it loose at the same location. */
  async unpack(input: BoxPackInput, actorId: string): Promise<BoxMoveResponse> {
    return this.shift(input, actorId, 'OUT');
  }

  /**
   * The shared body of pack and unpack: the same stock, the same location, one
   * side boxed and the other loose. Direction decides which side is the source.
   */
  private async shift(
    input: BoxPackInput,
    actorId: string,
    direction: 'IN' | 'OUT',
  ): Promise<BoxMoveResponse> {
    const { id: boxId } = await this.boxes.resolveByBarcode(input.boxBarcodeRaw);
    const box = await this.prisma.client.box.findFirstOrThrow({
      where: { id: boxId },
      select: { id: true, code: true, active: true, locationId: true },
    });
    if (!box.active) {
      throw new BoxStateError(`Box ${box.code} is retired.`, { boxId });
    }
    if (!box.locationId) {
      throw new BoxValidationError(
        `Box ${box.code} has no location yet — put it on a shelf before filling it.`,
        { boxId },
      );
    }

    const product = await this.resolve.resolveBarcode(input.barcodeRaw);

    // Source is the shelf when packing, the box when unpacking.
    const sourceBoxId = direction === 'IN' ? null : boxId;
    const destBoxId = direction === 'IN' ? boxId : null;

    const available = await this.balances(
      product.id,
      box.locationId,
      sourceBoxId,
      input.batchNumber ?? undefined,
    );
    const total = available.reduce((s, b) => s + b.qty, 0);
    if (total < input.quantity) {
      throw new BoxValidationError(
        direction === 'IN'
          ? `Only ${total} of ${product.code} is loose at this location; cannot pack ${input.quantity}.`
          : `Box ${box.code} holds only ${total} of ${product.code}; cannot remove ${input.quantity}.`,
        {
          productId: product.id,
          productCode: product.code,
          available: total,
          requested: input.quantity,
        },
      );
    }

    // Oldest expiry first, so packing a carton does not leave the near-expiry
    // stock stranded on the shelf behind fresher goods.
    let outstanding = input.quantity;
    let posted = 0;
    for (const batch of available) {
      if (outstanding === 0) break;
      const take = Math.min(batch.qty, outstanding);
      outstanding -= take;

      await this.ledger.post({
        productId: product.id,
        locationId: box.locationId,
        boxId: sourceBoxId,
        txnType: 'TRANSFER_OUT',
        qty: take,
        batchNumber: batch.batchNumber,
        expiryDate: batch.expiryDate,
        performedById: actorId,
        remark:
          input.remark ??
          (direction === 'IN' ? `Packed into ${box.code}` : `Removed from ${box.code}`),
        allowNegativeStock: true, // checked box-aware above — see class note
      });
      await this.ledger.post({
        productId: product.id,
        locationId: box.locationId,
        boxId: destBoxId,
        txnType: 'TRANSFER_IN',
        qty: take,
        batchNumber: batch.batchNumber,
        expiryDate: batch.expiryDate,
        performedById: actorId,
        remark:
          input.remark ??
          (direction === 'IN' ? `Packed into ${box.code}` : `Removed from ${box.code}`),
        allowNegativeStock: true,
      });
      posted += 2;
    }

    await this.audit.record({
      action: direction === 'IN' ? 'BOX_PACKED' : 'BOX_UNPACKED',
      entityType: 'Box',
      entityId: boxId,
      actorId,
      after: { productId: product.id, quantity: input.quantity, entriesPosted: posted },
    });

    const detail = await this.boxes.detail(boxId);
    return {
      box: detail,
      from: detail.location
        ? { id: detail.location.id, name: detail.location.name }
        : null,
      to: detail.location
        ? { id: detail.location.id, name: detail.location.name }
        : { id: '', name: '' },
      entriesPosted: posted,
      duplicate: false,
    };
  }

  // ── moving the whole box ───────────────────────────────────────────────────

  /**
   * Move a box to another section. Everything inside travels with it.
   *
   * Atomic by virtue of the request transaction: if any leg fails, the box has
   * not moved and neither has a single unit of its contents.
   */
  async move(input: BoxMoveInput, actorId: string): Promise<BoxMoveResponse> {
    const { id: boxId } = await this.boxes.resolveByBarcode(input.boxBarcodeRaw);
    const box = await this.prisma.client.box.findFirstOrThrow({
      where: { id: boxId },
      select: {
        id: true,
        code: true,
        active: true,
        locationId: true,
        location: { select: { id: true, name: true } },
      },
    });
    if (!box.active) throw new BoxStateError(`Box ${box.code} is retired.`, { boxId });

    const destination = input.toBinBarcodeRaw
      ? await this.resolve.resolveBin(input.toBinBarcodeRaw)
      : await this.requireLocation(input.toLocationId as string);

    if (box.locationId === destination.id) {
      // Loud, not silent: the operator believes they moved something.
      throw new BoxStateError(
        `Box ${box.code} is already in ${destination.name} — nothing to move.`,
        { boxId, locationId: destination.id },
      );
    }

    // Contents are read before anything is posted, so the loop below works from
    // a stable picture rather than one it is mutating as it goes.
    const contents = await this.boxes.contents(boxId);
    let posted = 0;

    for (const line of contents) {
      const expiryDate = line.expiryDate ? new Date(line.expiryDate) : null;
      if (box.locationId) {
        await this.ledger.post({
          productId: line.productId,
          locationId: box.locationId,
          boxId,
          txnType: 'TRANSFER_OUT',
          qty: line.qty,
          batchNumber: line.batchNumber,
          expiryDate,
          performedById: actorId,
          remark: input.remark ?? `Box ${box.code} → ${destination.name}`,
          allowNegativeStock: true,
        });
        posted += 1;
      }
      await this.ledger.post({
        productId: line.productId,
        locationId: destination.id,
        boxId,
        txnType: 'TRANSFER_IN',
        qty: line.qty,
        batchNumber: line.batchNumber,
        expiryDate,
        performedById: actorId,
        remark: input.remark ?? `Box ${box.code} → ${destination.name}`,
        allowNegativeStock: true,
      });
      posted += 1;
    }

    await this.prisma.client.boxMove.create({
      data: {
        id: newId('boxMove'),
        tenantId: this.tenantId(),
        boxId,
        fromLocationId: box.locationId,
        toLocationId: destination.id,
        entriesPosted: posted,
        movedById: actorId,
      },
    });
    // The cache and its authority are written together — see the note on
    // `Box.locationId` in the schema.
    await this.prisma.client.box.update({
      where: { id: boxId },
      data: { locationId: destination.id },
    });

    await this.audit.record({
      action: 'BOX_MOVED',
      entityType: 'Box',
      entityId: boxId,
      actorId,
      before: { locationId: box.locationId },
      after: { locationId: destination.id, entriesPosted: posted },
    });

    return {
      box: await this.boxes.detail(boxId),
      from: box.location ? { id: box.location.id, name: box.location.name } : null,
      to: { id: destination.id, name: destination.name },
      entriesPosted: posted,
      duplicate: false,
    };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * Per-batch balance in one exact place: a location *and* a specific box, or a
   * location with no box at all. `IS NOT DISTINCT FROM` rather than `=` because
   * the loose case compares against NULL, where `=` yields NULL and matches
   * nothing — which would silently report every shelf as empty.
   */
  private async balances(
    productId: string,
    locationId: string,
    boxId: string | null,
    batchNumber?: string,
  ): Promise<PlacedBatch[]> {
    const rows = await this.prisma.client.$queryRaw<
      { batch_number: string | null; expiry_date: Date | null; qty: bigint }[]
    >`
      SELECT "batch_number", "expiry_date",
             COALESCE(SUM("qty" * "direction"), 0)::bigint AS qty
      FROM "StockLedgerEntry"
      WHERE "product_id" = ${productId}
        AND "location_id" = ${locationId}
        AND "box_id" IS NOT DISTINCT FROM ${boxId}
        AND (${batchNumber ?? null}::text IS NULL OR "batch_number" = ${batchNumber ?? null})
      GROUP BY "batch_number", "expiry_date"
      HAVING COALESCE(SUM("qty" * "direction"), 0) > 0
      ORDER BY "expiry_date" ASC NULLS LAST
    `;
    return rows.map((r) => ({
      batchNumber: r.batch_number,
      expiryDate: r.expiry_date,
      qty: Number(r.qty),
    }));
  }

  private async requireLocation(
    locationId: string,
  ): Promise<{ id: string; name: string }> {
    const found = await this.prisma.client.location.findFirst({
      where: { id: locationId },
      select: { id: true, name: true },
    });
    if (!found) {
      throw new BoxValidationError(`Location ${locationId} does not exist.`, {
        locationId,
      });
    }
    return found;
  }

  private tenantId(): string {
    const tid = this.prisma.currentTenantId;
    if (!tid) throw new Error('No tenant context');
    return tid;
  }
}
