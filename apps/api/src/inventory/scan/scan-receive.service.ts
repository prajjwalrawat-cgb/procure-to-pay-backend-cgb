import { Injectable } from '@nestjs/common';
import { newId } from '@procureflow/db';
import type { ScanReceiveInput, ScanReceiveResponse } from '@procureflow/shared';

import { PrismaService } from '../../prisma/prisma.service';
import { InventoryLedgerService } from '../inventory-ledger.service';
import { InventoryReceiptService } from '../inventory-receipt.service';
import { LocationService } from '../location.service';
import { ScanResolveService } from './scan-resolve.service';
import { ScanValidationError } from './scan.errors';
import { SCAN_EVENT_SELECT, isDuplicateScan, toScanEventView } from './scan-idempotency';

/**
 * ScanReceiveService (Slice 13, Module 3) — goods receipt from the handset.
 *
 * Two invariants shape this service:
 *
 * 1. **One transaction.** The ScanEvent and its ledger row are written together
 *    or not at all. That comes free here: every request runs inside
 *    `PrismaService.runInTenantContext`, which is a single interactive
 *    transaction, so a throw anywhere below rolls back both.
 *
 * 2. **No invented expiry.** A batch-tracked product with no expiry on the scan
 *    is a 422 telling the operator to type it in. Defaulting the date would put
 *    a plausible lie into an immutable ledger and quietly corrupt FEFO for the
 *    life of that batch.
 *
 * Business rule 1 (a receipt needs a receivable PO, or an explicit Challan-only
 * override) is *not* re-implemented here — it is enforced by delegating to
 * `InventoryReceiptService.receive`. The scanner is a new input device, not a
 * bypass around the procurement control.
 */
@Injectable()
export class ScanReceiveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolve: ScanResolveService,
    private readonly receipts: InventoryReceiptService,
    private readonly ledger: InventoryLedgerService,
    private readonly locations: LocationService,
  ) {}

  async receive(input: ScanReceiveInput, actorId: string): Promise<ScanReceiveResponse> {
    const replay = await this.findReplay(input.clientUuid);
    if (replay) return replay;

    const product = await this.resolve.resolveBarcode(input.barcodeRaw);
    await this.locations.require(input.locationId);

    // Batch gate — never a silent default (spec Module 3, verification item 3).
    if (product.requiresBatchTracking) {
      if (!input.expiryDate) {
        throw new ScanValidationError(
          `${product.code} is batch-tracked: enter the expiry date printed on the pack before receiving.`,
          { productId: product.id, productCode: product.code, missing: 'expiryDate' },
        );
      }
      if (!input.batchNumber) {
        throw new ScanValidationError(
          `${product.code} is batch-tracked: enter the batch/lot number printed on the pack.`,
          { productId: product.id, productCode: product.code, missing: 'batchNumber' },
        );
      }
    }

    const { id: ledgerEntryId } = await this.receipts.receive(
      {
        productId: product.id,
        locationId: input.locationId,
        qty: input.quantity,
        purchaseOrderId: input.purchaseOrderId ?? null,
        nonPoReceipt: input.nonPoReceipt,
        nonPoReason: input.nonPoReason ?? null,
        batchNumber: input.batchNumber ?? null,
        expiryDate: input.expiryDate ?? null,
        qcStatus: 'PENDING',
        damageQty: 0,
        remark: input.remark ?? null,
        // The scan's own timestamp is the truth for an offline-queued receipt:
        // it arrived on the dock when it was scanned, not when wifi came back.
        txnDate: input.clientTimestamp ?? null,
      },
      actorId,
    );

    const scanEvent = await this.writeScan(input, product.id, ledgerEntryId, actorId);
    // A concurrent replay won the insert race — return its result, not a 500.
    if (scanEvent === null) {
      const raced = await this.findReplay(input.clientUuid);
      if (raced) return raced;
      throw new ScanValidationError('Scan could not be recorded; retry.', {
        clientUuid: input.clientUuid,
      });
    }

    const entry = await this.prisma.client.stockLedgerEntry.findUniqueOrThrow({
      where: { id: ledgerEntryId },
      select: { id: true, qty: true, batchNumber: true, expiryDate: true },
    });

    return {
      scanEvent: toScanEventView(scanEvent),
      ledgerEntry: {
        id: entry.id,
        qty: entry.qty,
        batchNumber: entry.batchNumber,
        expiryDate: entry.expiryDate ? entry.expiryDate.toISOString() : null,
      },
      currentStockLevel: await this.ledger.stockAt(product.id, input.locationId),
      duplicate: false,
    };
  }

  /**
   * Insert the ScanEvent, returning null when the unique index rejects it as a
   * replay. Everything else propagates — a swallowed error here would look like
   * a successful receipt that never happened.
   */
  private async writeScan(
    input: ScanReceiveInput,
    productId: string,
    ledgerEntryId: string,
    actorId: string,
  ) {
    try {
      return await this.prisma.client.scanEvent.create({
        data: {
          id: newId('scanEvent'),
          tenantId: this.tenantId(),
          productId,
          scanType: 'RECEIVE',
          barcodeRaw: input.barcodeRaw.trim(),
          quantity: input.quantity,
          locationId: input.locationId,
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

  /**
   * Rebuild the original response for an already-recorded scan. Returns 200 with
   * `duplicate: true` rather than an error: from the handset's point of view the
   * scan succeeded, and the queue needs to hear that so it can stop retrying.
   */
  private async findReplay(clientUuid: string): Promise<ScanReceiveResponse | null> {
    const existing = await this.prisma.client.scanEvent.findFirst({
      where: { clientUuid, scanType: 'RECEIVE' },
      select: SCAN_EVENT_SELECT,
    });
    if (!existing) return null;

    const entry = existing.ledgerEntryId
      ? await this.prisma.client.stockLedgerEntry.findUnique({
          where: { id: existing.ledgerEntryId },
          select: { id: true, qty: true, batchNumber: true, expiryDate: true },
        })
      : null;

    return {
      scanEvent: toScanEventView(existing),
      ledgerEntry: {
        id: entry?.id ?? '',
        qty: entry?.qty ?? existing.quantity,
        batchNumber: entry?.batchNumber ?? null,
        expiryDate: entry?.expiryDate ? entry.expiryDate.toISOString() : null,
      },
      currentStockLevel: existing.locationId
        ? await this.ledger.stockAt(existing.productId, existing.locationId)
        : await this.ledger.totalStock(existing.productId),
      duplicate: true,
    };
  }

  private tenantId(): string {
    const tid = this.prisma.currentTenantId;
    if (!tid) throw new Error('No tenant context');
    return tid;
  }
}
