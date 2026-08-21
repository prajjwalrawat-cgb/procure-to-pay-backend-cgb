import { Injectable } from '@nestjs/common';
import { newId } from '@procureflow/db';
import type {
  PickAllocation,
  PickListCreateInput,
  PickListResponse,
  ScanPickInput,
  ScanPickResponse,
} from '@procureflow/shared';

import { PrismaService } from '../../prisma/prisma.service';
import { InventoryLedgerService } from '../inventory-ledger.service';
import { FefoService } from './fefo.service';
import { ScanResolveService } from './scan-resolve.service';
import { PickListStateError, ScanValidationError } from './scan.errors';
import { SCAN_EVENT_SELECT, isDuplicateScan, toScanEventView } from './scan-idempotency';

/**
 * ScanPickService (Slice 13, Module 5) — scan-driven picking against an order.
 *
 * **On the pick list.** The ledger records an outbound order as free text on
 * `StockLedgerEntry.orderId` — enough to say what shipped, not enough to say
 * what *should* ship. `PickList` adds only the missing part: required quantity
 * per product, and how much of it has been picked. It is not an order
 * subsystem, and deliberately reuses the same free-text reference so a picked
 * line and its ledger row still tie back to one another.
 *
 * **On FEFO.** Allocation goes through `FefoService`, shared with putaway and
 * transfer, so "oldest expiry first" means the same thing everywhere in the
 * module. A pick can span batches and locations; each leg becomes its own
 * CUSTOMER_ORDER_OUT row carrying the batch it consumed, which is what makes a
 * recall traceable after the fact.
 *
 * **On over-picking.** A line's remaining quantity is the hard ceiling. The
 * warehouse can under-pick (a short shipment is a real thing) but never
 * over-pick, because the ledger row would then contradict the order.
 */
@Injectable()
export class ScanPickService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolve: ScanResolveService,
    private readonly fefo: FefoService,
    private readonly ledger: InventoryLedgerService,
  ) {}

  // ── pick list management ───────────────────────────────────────────────────

  /** Create a pick list for an outbound order. */
  async createPickList(
    input: PickListCreateInput,
    actorId: string,
  ): Promise<PickListResponse> {
    const existing = await this.prisma.client.pickList.findFirst({
      where: { orderRef: input.orderRef },
      select: { id: true },
    });
    if (existing) {
      throw new PickListStateError(
        `A pick list already exists for order ${input.orderRef}.`,
        {
          orderRef: input.orderRef,
          pickListId: existing.id,
        },
      );
    }

    // Duplicate products would create two lines the scanner cannot tell apart.
    const seen = new Set<string>();
    for (const line of input.lines) {
      if (seen.has(line.productId)) {
        throw new ScanValidationError(
          `Product ${line.productId} appears more than once — combine the quantities into one line.`,
          { productId: line.productId },
        );
      }
      seen.add(line.productId);
    }

    const id = newId('pickList');
    await this.prisma.client.pickList.create({
      data: {
        id,
        tenantId: this.tenantId(),
        orderRef: input.orderRef,
        platform: input.platform ?? null,
        customerName: input.customerName ?? null,
        createdById: actorId,
        lines: {
          create: input.lines.map((l) => ({
            id: newId('pickListLine'),
            tenantId: this.tenantId(),
            productId: l.productId,
            qtyRequired: l.qtyRequired,
          })),
        },
      },
    });
    return this.pickList(input.orderRef);
  }

  /**
   * `GET /scan/pick/:orderId` — the live checklist. Everything the handset needs
   * to render progress without a second round trip: per-line required, picked,
   * remaining, plus the barcode so the UI can verify a scan locally.
   */
  async pickList(orderRef: string): Promise<PickListResponse> {
    const list = await this.prisma.client.pickList.findFirst({
      where: { orderRef },
      select: {
        id: true,
        orderRef: true,
        platform: true,
        customerName: true,
        status: true,
        lines: {
          select: {
            productId: true,
            qtyRequired: true,
            qtyPicked: true,
            product: { select: { code: true, name: true, barcode: true } },
          },
        },
      },
    });
    if (!list) {
      throw new PickListStateError(`No pick list found for order ${orderRef}.`, {
        orderRef,
      });
    }

    const lines = list.lines.map((l) => ({
      productId: l.productId,
      productCode: l.product.code,
      productName: l.product.name,
      barcode: l.product.barcode,
      qtyRequired: l.qtyRequired,
      qtyPicked: l.qtyPicked,
      remaining: Math.max(0, l.qtyRequired - l.qtyPicked),
      complete: l.qtyPicked >= l.qtyRequired,
    }));

    return {
      id: list.id,
      orderRef: list.orderRef,
      platform: list.platform,
      customerName: list.customerName,
      status: list.status as PickListResponse['status'],
      lines,
      totalRequired: lines.reduce((s, l) => s + l.qtyRequired, 0),
      totalPicked: lines.reduce((s, l) => s + l.qtyPicked, 0),
    };
  }

  // ── the pick scan ──────────────────────────────────────────────────────────

  async pick(input: ScanPickInput, actorId: string): Promise<ScanPickResponse> {
    const replay = await this.findReplay(input.clientUuid);
    if (replay) return replay;

    const list = await this.prisma.client.pickList.findFirst({
      where: { orderRef: input.orderId },
      select: {
        id: true,
        status: true,
        platform: true,
        customerName: true,
        orderRef: true,
      },
    });
    if (!list) {
      throw new PickListStateError(`No pick list found for order ${input.orderId}.`, {
        orderRef: input.orderId,
      });
    }
    if (list.status === 'CANCELLED' || list.status === 'PICKED') {
      throw new PickListStateError(
        `Order ${list.orderRef} is ${list.status.toLowerCase()} — it cannot be picked against.`,
        { orderRef: list.orderRef, status: list.status },
      );
    }

    const product = await this.resolve.resolveBarcode(input.barcodeRaw);

    const line = await this.prisma.client.pickListLine.findFirst({
      where: { pickListId: list.id, productId: product.id },
      select: { id: true, qtyRequired: true, qtyPicked: true },
    });
    if (!line) {
      throw new ScanValidationError(`${product.code} is not on order ${list.orderRef}.`, {
        orderRef: list.orderRef,
        productId: product.id,
        productCode: product.code,
      });
    }

    const remaining = line.qtyRequired - line.qtyPicked;
    if (remaining <= 0) {
      throw new ScanValidationError(
        `${product.code} is already fully picked for order ${list.orderRef}.`,
        {
          orderRef: list.orderRef,
          productCode: product.code,
          qtyRequired: line.qtyRequired,
        },
      );
    }
    if (input.quantity > remaining) {
      throw new ScanValidationError(
        `Cannot pick ${input.quantity} of ${product.code}: only ${remaining} remain on order ${list.orderRef}.`,
        {
          orderRef: list.orderRef,
          productCode: product.code,
          requested: input.quantity,
          remaining,
        },
      );
    }

    // FEFO — oldest expiry first, expired batches excluded.
    const allocations = await this.fefo.allocateForPick(product.id, input.quantity);

    const posted: PickAllocation[] = [];
    for (const alloc of allocations) {
      const entryId = await this.ledger.post({
        productId: product.id,
        locationId: alloc.locationId,
        txnType: 'CUSTOMER_ORDER_OUT',
        qty: alloc.qty,
        batchNumber: alloc.batchNumber,
        expiryDate: alloc.expiryDate,
        orderId: list.orderRef,
        platform: list.platform,
        customerName: list.customerName,
        performedById: actorId,
        remark: input.remark ?? null,
        txnDate: input.clientTimestamp ? new Date(input.clientTimestamp) : null,
      });
      posted.push({
        ledgerEntryId: entryId,
        locationId: alloc.locationId,
        batchNumber: alloc.batchNumber,
        expiryDate: alloc.expiryDate ? alloc.expiryDate.toISOString() : null,
        qty: alloc.qty,
      });
    }

    const qtyPicked = line.qtyPicked + input.quantity;
    await this.prisma.client.pickListLine.update({
      where: { id: line.id },
      data: { qtyPicked },
    });

    const orderComplete = await this.refreshListStatus(list.id);

    const scanEvent = await this.writeScan(
      input,
      product.id,
      allocations[0]?.locationId ?? null,
      posted[0]?.ledgerEntryId ?? null,
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
      allocations: posted,
      line: {
        productId: product.id,
        qtyRequired: line.qtyRequired,
        qtyPicked,
        remaining: line.qtyRequired - qtyPicked,
      },
      orderComplete,
      duplicate: false,
    };
  }

  /**
   * Move the list to IN_PROGRESS on the first pick and to PICKED once every line
   * is satisfied. Derived from the lines rather than incremented, so a partial
   * pick followed by a correction cannot leave the header out of step.
   */
  private async refreshListStatus(pickListId: string): Promise<boolean> {
    const lines = await this.prisma.client.pickListLine.findMany({
      where: { pickListId },
      select: { qtyRequired: true, qtyPicked: true },
    });
    const complete = lines.every((l) => l.qtyPicked >= l.qtyRequired);
    const started = lines.some((l) => l.qtyPicked > 0);

    await this.prisma.client.pickList.update({
      where: { id: pickListId },
      data: {
        status: complete ? 'PICKED' : started ? 'IN_PROGRESS' : 'OPEN',
        completedAt: complete ? new Date() : null,
      },
    });
    return complete;
  }

  private async writeScan(
    input: ScanPickInput,
    productId: string,
    locationId: string | null,
    ledgerEntryId: string | null,
    actorId: string,
  ) {
    try {
      return await this.prisma.client.scanEvent.create({
        data: {
          id: newId('scanEvent'),
          tenantId: this.tenantId(),
          productId,
          scanType: 'PICK',
          barcodeRaw: input.barcodeRaw.trim(),
          quantity: input.quantity,
          locationId,
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

  private async findReplay(clientUuid: string): Promise<ScanPickResponse | null> {
    const existing = await this.prisma.client.scanEvent.findFirst({
      where: { clientUuid, scanType: 'PICK' },
      select: SCAN_EVENT_SELECT,
    });
    if (!existing) return null;

    const line = await this.prisma.client.pickListLine.findFirst({
      where: { productId: existing.productId },
      orderBy: { pickList: { createdAt: 'desc' } },
      select: {
        qtyRequired: true,
        qtyPicked: true,
        pickList: { select: { status: true } },
      },
    });

    return {
      scanEvent: toScanEventView(existing),
      allocations: existing.ledgerEntryId
        ? [
            {
              ledgerEntryId: existing.ledgerEntryId,
              locationId: existing.locationId ?? '',
              batchNumber: null,
              expiryDate: null,
              qty: existing.quantity,
            },
          ]
        : [],
      line: {
        productId: existing.productId,
        qtyRequired: line?.qtyRequired ?? 0,
        qtyPicked: line?.qtyPicked ?? 0,
        remaining: Math.max(0, (line?.qtyRequired ?? 0) - (line?.qtyPicked ?? 0)),
      },
      orderComplete: line?.pickList?.status === 'PICKED',
      duplicate: true,
    };
  }

  private tenantId(): string {
    const tid = this.prisma.currentTenantId;
    if (!tid) throw new Error('No tenant context');
    return tid;
  }
}
