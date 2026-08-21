import { Injectable } from '@nestjs/common';
import { newId } from '@procureflow/db';
import type { ScanPutawayInput, ScanPutawayResponse } from '@procureflow/shared';

import { PrismaService } from '../../prisma/prisma.service';
import { ScanMovementService } from './scan-movement.service';
import { ScanResolveService } from './scan-resolve.service';
import { ScanValidationError } from './scan.errors';
import { SCAN_EVENT_SELECT, isDuplicateScan, toScanEventView } from './scan-idempotency';

/**
 * ScanPutawayService (Slice 13, Module 4) — moving received stock from where it
 * landed to the bin it lives in, via two scans: the SKU, then the bin label.
 *
 * **The location-change pattern.** Slice 12's ledger has no location-change
 * movement type and treats a row's location as immutable, so a putaway is a
 * paired TRANSFER_OUT / TRANSFER_IN through `ScanMovementService` — the source
 * location gives the stock up, the bin takes it, and the pair nets to zero
 * warehouse-wide. Rewriting the receipt row's location instead would have meant
 * mutating an insert-only ledger, which the database trigger blocks outright.
 *
 * **Over-putaway.** You cannot put away more than arrived. The outstanding
 * quantity is derived from scan history — RECEIVE scans at the source location
 * minus PUTAWAY scans out of it — so a second putaway of the same pallet is
 * rejected rather than quietly creating stock that was never received.
 */
@Injectable()
export class ScanPutawayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolve: ScanResolveService,
    private readonly movement: ScanMovementService,
  ) {}

  async putaway(input: ScanPutawayInput, actorId: string): Promise<ScanPutawayResponse> {
    const replay = await this.findReplay(input.clientUuid);
    if (replay) return replay;

    const product = await this.resolve.resolveBarcode(input.barcodeRaw);
    const bin = await this.resolve.resolveBin(input.binBarcodeRaw);

    // Where did this stock arrive? The most recent RECEIVE scan for the product
    // is the pallet the operator is standing over.
    const lastReceive = await this.prisma.client.scanEvent.findFirst({
      where: { productId: product.id, scanType: 'RECEIVE', locationId: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { locationId: true },
    });
    const sourceLocationId = lastReceive?.locationId;
    if (!sourceLocationId) {
      throw new ScanValidationError(
        `Nothing to put away: ${product.code} has no recorded receipt to move from.`,
        { productId: product.id, productCode: product.code },
      );
    }

    if (sourceLocationId === bin.id) {
      throw new ScanValidationError(
        `${product.code} was received into ${bin.name} — it is already in that bin.`,
        { productId: product.id, binId: bin.id },
      );
    }

    const outstanding = await this.outstandingToPutaway(product.id, sourceLocationId);
    if (input.quantity > outstanding) {
      throw new ScanValidationError(
        `Cannot put away ${input.quantity}: only ${outstanding} of ${product.code} is awaiting putaway.`,
        {
          productId: product.id,
          productCode: product.code,
          requested: input.quantity,
          outstanding,
        },
      );
    }

    const legs = await this.movement.move({
      productId: product.id,
      fromLocationId: sourceLocationId,
      toLocationId: bin.id,
      qty: input.quantity,
      performedById: actorId,
      remark: input.remark ?? `Putaway to ${bin.name}`,
      txnDate: input.clientTimestamp ? new Date(input.clientTimestamp) : null,
    });

    const scanEvent = await this.writeScan(
      input,
      product.id,
      bin.id,
      legs.outEntryIds[0] ?? null,
      actorId,
    );
    if (scanEvent === null) {
      const raced = await this.findReplay(input.clientUuid);
      if (raced) return raced;
      throw new ScanValidationError('Scan could not be recorded; retry.', {
        clientUuid: input.clientUuid,
      });
    }

    return {
      scanEvent: toScanEventView(scanEvent),
      binLocation: bin,
      skuName: product.name,
      remainingToPutaway: outstanding - input.quantity,
      duplicate: false,
    };
  }

  /**
   * Quantity received into a location but not yet moved out of it by a putaway.
   * Derived from ScanEvent history rather than the ledger, because the ledger
   * cannot distinguish a putaway transfer from any other transfer out of that
   * location — the intent lives on the scan, not the movement.
   */
  private async outstandingToPutaway(
    productId: string,
    locationId: string,
  ): Promise<number> {
    const [received, putaway] = await Promise.all([
      this.prisma.client.scanEvent.aggregate({
        where: { productId, locationId, scanType: 'RECEIVE' },
        _sum: { quantity: true },
      }),
      // A PUTAWAY scan records its *destination* bin, so the quantity that left
      // this location is found through the ledger rows the move produced.
      this.prisma.client.stockLedgerEntry.aggregate({
        where: { productId, locationId, txnType: 'TRANSFER_OUT' },
        _sum: { qty: true },
      }),
    ]);
    const outstanding = (received._sum.quantity ?? 0) - (putaway._sum.qty ?? 0);
    return Math.max(0, outstanding);
  }

  private async writeScan(
    input: ScanPutawayInput,
    productId: string,
    binLocationId: string,
    ledgerEntryId: string | null,
    actorId: string,
  ) {
    try {
      return await this.prisma.client.scanEvent.create({
        data: {
          id: newId('scanEvent'),
          tenantId: this.tenantId(),
          productId,
          scanType: 'PUTAWAY',
          barcodeRaw: input.barcodeRaw.trim(),
          quantity: input.quantity,
          locationId: binLocationId,
          binId: input.binBarcodeRaw.trim(),
          deviceId: input.deviceId,
          userId: actorId,
          gpsLat: input.gpsLat ?? null,
          gpsLng: input.gpsLng ?? null,
          ledgerEntryId,
          clientUuid: input.clientUuid,
          clientTimestamp: input.clientTimestamp ? new Date(input.clientTimestamp) : null,
          syncedAt: new Date(),
        },
        select: SCAN_EVENT_SELECT,
      });
    } catch (err) {
      if (isDuplicateScan(err)) return null;
      throw err;
    }
  }

  private async findReplay(clientUuid: string): Promise<ScanPutawayResponse | null> {
    const existing = await this.prisma.client.scanEvent.findFirst({
      where: { clientUuid, scanType: 'PUTAWAY' },
      select: { ...SCAN_EVENT_SELECT, binId: true },
    });
    if (!existing) return null;

    const bin = existing.locationId
      ? await this.prisma.client.location.findUnique({
          where: { id: existing.locationId },
          select: { id: true, name: true, rackNo: true, barcode: true },
        })
      : null;
    const product = await this.prisma.client.product.findUnique({
      where: { id: existing.productId },
      select: { name: true },
    });

    return {
      scanEvent: toScanEventView(existing),
      binLocation: bin ?? {
        id: '',
        name: existing.binId ?? '',
        rackNo: null,
        barcode: null,
      },
      skuName: product?.name ?? '',
      remainingToPutaway: 0,
      duplicate: true,
    };
  }

  private tenantId(): string {
    const tid = this.prisma.currentTenantId;
    if (!tid) throw new Error('No tenant context');
    return tid;
  }
}
