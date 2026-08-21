import { Injectable } from '@nestjs/common';
import { newId } from '@procureflow/db';
import type { ScanTransferInput, ScanTransferResponse } from '@procureflow/shared';

import { PrismaService } from '../../prisma/prisma.service';
import { FefoService } from './fefo.service';
import { ScanMovementService } from './scan-movement.service';
import { ScanResolveService } from './scan-resolve.service';
import { ScanValidationError } from './scan.errors';
import { SCAN_EVENT_SELECT, isDuplicateScan, toScanEventView } from './scan-idempotency';

/**
 * ScanTransferService (Slice 13, Module 7) — bin-to-bin movement.
 *
 * Three scans: the SKU, the bin it is leaving, the bin it is going to. The
 * ledger consequence is a TRANSFER_OUT / TRANSFER_IN pair per batch moved,
 * written inside the request transaction — both legs or neither, never a
 * quantity in flight between two bins.
 *
 * The source-stock check is not a courtesy: without it a mis-scanned source bin
 * would drive that bin negative and quietly invent stock in the destination.
 */
@Injectable()
export class ScanTransferService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolve: ScanResolveService,
    private readonly movement: ScanMovementService,
    private readonly fefo: FefoService,
  ) {}

  async transfer(
    input: ScanTransferInput,
    actorId: string,
  ): Promise<ScanTransferResponse> {
    const replay = await this.findReplay(input.clientUuid);
    if (replay) return replay;

    const product = await this.resolve.resolveBarcode(input.barcodeRaw);
    const source = await this.resolve.resolveBin(input.sourceBinBarcodeRaw);
    const dest = await this.resolve.resolveBin(input.destBinBarcodeRaw);

    // The schema already rejects identical barcode strings; this catches the
    // case two different labels resolve to the same location. A no-op transfer
    // must fail loudly — a silent success would tell the operator the stock
    // moved when it did not.
    if (source.id === dest.id) {
      throw new ScanValidationError(
        `Source and destination are the same bin (${source.name}) — nothing to transfer.`,
        { binId: source.id, binName: source.name },
      );
    }

    const available = await this.fefo.availableAt(product.id, source.id);
    if (available < input.quantity) {
      throw new ScanValidationError(
        `${source.name} holds ${available} of ${product.code}; cannot transfer ${input.quantity}.`,
        {
          productId: product.id,
          productCode: product.code,
          sourceBinId: source.id,
          available,
          requested: input.quantity,
        },
      );
    }

    const legs = await this.movement.move({
      productId: product.id,
      fromLocationId: source.id,
      toLocationId: dest.id,
      qty: input.quantity,
      performedById: actorId,
      remark: input.remark ?? `Transfer ${source.name} → ${dest.name}`,
      txnDate: input.clientTimestamp ? new Date(input.clientTimestamp) : null,
    });

    const scanEvent = await this.writeScan(
      input,
      product.id,
      dest.id,
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
      outEntryId: legs.outEntryIds[0] ?? '',
      inEntryId: legs.inEntryIds[0] ?? '',
      sourceBin: { id: source.id, name: source.name },
      destBin: { id: dest.id, name: dest.name },
      sourceStockAfter: await this.fefo.availableAt(product.id, source.id),
      destStockAfter: await this.fefo.availableAt(product.id, dest.id),
      duplicate: false,
    };
  }

  private async writeScan(
    input: ScanTransferInput,
    productId: string,
    destLocationId: string,
    ledgerEntryId: string | null,
    actorId: string,
  ) {
    try {
      return await this.prisma.client.scanEvent.create({
        data: {
          id: newId('scanEvent'),
          tenantId: this.tenantId(),
          productId,
          scanType: 'TRANSFER',
          barcodeRaw: input.barcodeRaw.trim(),
          quantity: input.quantity,
          locationId: destLocationId,
          binId: input.destBinBarcodeRaw.trim(),
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

  private async findReplay(clientUuid: string): Promise<ScanTransferResponse | null> {
    const existing = await this.prisma.client.scanEvent.findFirst({
      where: { clientUuid, scanType: 'TRANSFER' },
      select: SCAN_EVENT_SELECT,
    });
    if (!existing) return null;

    const dest = existing.locationId
      ? await this.prisma.client.location.findUnique({
          where: { id: existing.locationId },
          select: { id: true, name: true },
        })
      : null;
    // The outward leg names the source; it is the only record of where the
    // stock came from once the scan itself has been reduced to its destination.
    const outLeg = existing.ledgerEntryId
      ? await this.prisma.client.stockLedgerEntry.findUnique({
          where: { id: existing.ledgerEntryId },
          select: { locationId: true, location: { select: { name: true } } },
        })
      : null;

    return {
      scanEvent: toScanEventView(existing),
      outEntryId: existing.ledgerEntryId ?? '',
      inEntryId: '',
      sourceBin: { id: outLeg?.locationId ?? '', name: outLeg?.location?.name ?? '' },
      destBin: { id: dest?.id ?? '', name: dest?.name ?? '' },
      sourceStockAfter: outLeg?.locationId
        ? await this.fefo.availableAt(existing.productId, outLeg.locationId)
        : 0,
      destStockAfter: dest ? await this.fefo.availableAt(existing.productId, dest.id) : 0,
      duplicate: true,
    };
  }

  private tenantId(): string {
    const tid = this.prisma.currentTenantId;
    if (!tid) throw new Error('No tenant context');
    return tid;
  }
}
