import { Injectable } from '@nestjs/common';
import { newId } from '@procureflow/db';
import type {
  CycleCountScanInput,
  CycleCountSessionResponse,
  CycleCountStartInput,
  CycleCountVarianceView,
} from '@procureflow/shared';

import { AuditLogService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryLedgerService } from '../inventory-ledger.service';
import { LocationService } from '../location.service';
import { ScanResolveService } from './scan-resolve.service';
import { CycleCountStateError, ScanValidationError } from './scan.errors';
import { SCAN_EVENT_SELECT, isDuplicateScan } from './scan-idempotency';

/**
 * ScanCycleCountService (Slice 13, Module 6) — counting a bin.
 *
 * The whole point of this service is what it does *not* do: a count never
 * adjusts stock. Counting produces scans; completing produces variances;
 * neither touches the ledger. Only `approve` — gated on `inventory:adjust`,
 * the same permission that governs every other correction in the module —
 * writes ADJUSTMENT rows.
 *
 * `expected` comes from ledger state, never from scan history. Deriving it from
 * scans would make the count a mirror of itself: it would always agree, and the
 * variance would always be zero.
 */
@Injectable()
export class ScanCycleCountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolve: ScanResolveService,
    private readonly ledger: InventoryLedgerService,
    private readonly locations: LocationService,
    private readonly audit: AuditLogService,
  ) {}

  /** `POST /scan/cycle-count/start` */
  async start(
    input: CycleCountStartInput,
    actorId: string,
  ): Promise<CycleCountSessionResponse> {
    const bin = input.binBarcodeRaw
      ? await this.resolve.resolveBin(input.binBarcodeRaw)
      : await this.locations.require(input.locationId as string);

    // Two people counting one bin at once produces two half-counts, each of
    // which looks like a shortfall. Refuse the second.
    const open = await this.prisma.client.cycleCountSession.findFirst({
      where: { locationId: bin.id, status: { in: ['IN_PROGRESS', 'PENDING_REVIEW'] } },
      select: { id: true, status: true },
    });
    if (open) {
      throw new CycleCountStateError(
        `A cycle count for this bin is already ${open.status === 'IN_PROGRESS' ? 'in progress' : 'awaiting review'}.`,
        { sessionId: open.id, locationId: bin.id, status: open.status },
      );
    }

    const id = newId('cycleCountSession');
    await this.prisma.client.cycleCountSession.create({
      data: {
        id,
        tenantId: this.tenantId(),
        locationId: bin.id,
        countedById: actorId,
        notes: input.notes ?? null,
      },
    });
    return this.view(id);
  }

  /**
   * `POST /scan/cycle-count/:sessionId/scan` — record one counted SKU.
   * Writes a ScanEvent and nothing else.
   */
  async scan(
    sessionId: string,
    input: CycleCountScanInput,
    actorId: string,
  ): Promise<CycleCountSessionResponse> {
    const session = await this.requireSession(sessionId);
    if (session.status !== 'IN_PROGRESS') {
      throw new CycleCountStateError(
        `This count is ${session.status.toLowerCase().replace('_', ' ')} — no further scans can be added.`,
        { sessionId, status: session.status },
      );
    }

    const product = await this.resolve.resolveBarcode(input.barcodeRaw);

    try {
      await this.prisma.client.scanEvent.create({
        data: {
          id: newId('scanEvent'),
          tenantId: this.tenantId(),
          productId: product.id,
          scanType: 'CYCLE_COUNT',
          barcodeRaw: input.barcodeRaw.trim(),
          quantity: input.quantity,
          locationId: session.locationId,
          deviceId: input.deviceId,
          userId: actorId,
          gpsLat: input.gpsLat ?? null,
          gpsLng: input.gpsLng ?? null,
          sessionId,
          clientUuid: input.clientUuid,
          clientTimestamp: input.clientTimestamp ? new Date(input.clientTimestamp) : null,
          syncedAt: new Date(),
        },
        select: SCAN_EVENT_SELECT,
      });
    } catch (err) {
      // A replayed count scan is a no-op: the original is already counted, and
      // adding it again would double the bin's tally.
      if (!isDuplicateScan(err)) throw err;
    }

    return this.view(sessionId);
  }

  /**
   * `POST /scan/cycle-count/:sessionId/complete` — freeze the count and compute
   * variances. Still no ledger writes.
   *
   * The product set is the *union* of what was scanned and what the ledger says
   * is in the bin: a product the ledger holds but nobody scanned is the most
   * important variance there is, and counting only what was scanned would hide
   * it completely.
   */
  async complete(sessionId: string, actorId: string): Promise<CycleCountSessionResponse> {
    const session = await this.requireSession(sessionId);
    if (session.status !== 'IN_PROGRESS') {
      throw new CycleCountStateError(
        `This count is already ${session.status.toLowerCase().replace('_', ' ')}.`,
        { sessionId, status: session.status },
      );
    }

    const counted = await this.countedByProduct(sessionId);
    const expected = await this.expectedByProduct(session.locationId);
    const productIds = new Set<string>([...counted.keys(), ...expected.keys()]);

    if (productIds.size === 0) {
      throw new ScanValidationError(
        'Nothing was counted and the bin is empty — there is nothing to review.',
        { sessionId },
      );
    }

    await this.prisma.client.cycleCountVariance.deleteMany({ where: { sessionId } });
    for (const productId of productIds) {
      const countedQty = counted.get(productId) ?? 0;
      const expectedQty = expected.get(productId) ?? 0;
      await this.prisma.client.cycleCountVariance.create({
        data: {
          id: newId('cycleCountVariance'),
          tenantId: this.tenantId(),
          sessionId,
          productId,
          expectedQty,
          countedQty,
          deltaQty: countedQty - expectedQty,
        },
      });
    }

    await this.prisma.client.cycleCountSession.update({
      where: { id: sessionId },
      data: { status: 'PENDING_REVIEW', completedAt: new Date() },
    });

    await this.audit.record({
      action: 'CYCLE_COUNT_COMPLETED',
      entityType: 'CycleCountSession',
      entityId: sessionId,
      actorId,
      after: { locationId: session.locationId, products: productIds.size },
    });

    return this.view(sessionId);
  }

  /**
   * `POST /scan/cycle-count/:sessionId/approve` — the only step that moves stock.
   *
   * Guarded twice over. The controller requires `inventory:adjust`; here, each
   * variance is re-checked against live ledger state before anything is posted.
   * If the bin moved between the count and the approval, the recorded delta is
   * stale — applying it would write a number nobody ever counted — so the whole
   * approval is refused and the bin is recounted. Refusing is cheap; a wrong
   * adjustment lives in an immutable ledger forever.
   */
  async approve(sessionId: string, actorId: string): Promise<CycleCountSessionResponse> {
    const session = await this.requireSession(sessionId);
    if (session.status !== 'PENDING_REVIEW') {
      throw new CycleCountStateError(
        session.status === 'APPROVED'
          ? 'This count has already been approved.'
          : 'Complete the count before approving it.',
        { sessionId, status: session.status },
      );
    }

    const variances = await this.prisma.client.cycleCountVariance.findMany({
      where: { sessionId },
      select: {
        id: true,
        productId: true,
        expectedQty: true,
        countedQty: true,
        deltaQty: true,
      },
    });

    const live = await this.expectedByProduct(session.locationId);
    const stale = variances.filter((v) => (live.get(v.productId) ?? 0) !== v.expectedQty);
    if (stale.length > 0) {
      throw new CycleCountStateError(
        `Stock at this bin changed after the count (${stale.length} product(s)). Recount before approving.`,
        {
          sessionId,
          staleProductIds: stale.map((s) => s.productId),
        },
      );
    }

    for (const variance of variances) {
      if (variance.deltaQty === 0) continue;
      const entryId = await this.ledger.post({
        productId: variance.productId,
        locationId: session.locationId,
        txnType: 'ADJUSTMENT',
        // ADJUSTMENT is the one movement type that takes its sign from the
        // caller: a shortfall is negative, found stock is positive.
        signedQty: variance.deltaQty,
        performedById: actorId,
        remark: `Cycle count ${sessionId}: counted ${variance.countedQty}, expected ${variance.expectedQty}`,
      });
      await this.prisma.client.cycleCountVariance.update({
        where: { id: variance.id },
        data: { ledgerEntryId: entryId },
      });
    }

    await this.prisma.client.cycleCountSession.update({
      where: { id: sessionId },
      data: { status: 'APPROVED', approvedById: actorId, approvedAt: new Date() },
    });

    await this.audit.record({
      action: 'CYCLE_COUNT_APPROVED',
      entityType: 'CycleCountSession',
      entityId: sessionId,
      actorId,
      after: {
        locationId: session.locationId,
        adjustments: variances.filter((v) => v.deltaQty !== 0).length,
      },
    });

    return this.view(sessionId);
  }

  /** The session as the review screen and the handset both render it. */
  async view(sessionId: string): Promise<CycleCountSessionResponse> {
    const session = await this.prisma.client.cycleCountSession.findFirst({
      where: { id: sessionId },
      select: {
        id: true,
        locationId: true,
        status: true,
        countedById: true,
        approvedById: true,
        startedAt: true,
        completedAt: true,
        approvedAt: true,
        notes: true,
        location: { select: { name: true } },
        variances: {
          select: {
            productId: true,
            expectedQty: true,
            countedQty: true,
            deltaQty: true,
            ledgerEntryId: true,
            product: { select: { code: true, name: true } },
          },
        },
      },
    });
    if (!session) {
      throw new CycleCountStateError(`Cycle count session ${sessionId} not found.`, {
        sessionId,
      });
    }

    const counted = await this.countedByProduct(sessionId);
    const names = await this.productNames([...counted.keys()]);

    const variances: CycleCountVarianceView[] = session.variances.map((v) => ({
      productId: v.productId,
      productCode: v.product.code,
      productName: v.product.name,
      expectedQty: v.expectedQty,
      countedQty: v.countedQty,
      deltaQty: v.deltaQty,
      ledgerEntryId: v.ledgerEntryId,
    }));

    return {
      id: session.id,
      locationId: session.locationId,
      locationName: session.location.name,
      status: session.status as CycleCountSessionResponse['status'],
      countedById: session.countedById,
      approvedById: session.approvedById,
      startedAt: session.startedAt.toISOString(),
      completedAt: session.completedAt ? session.completedAt.toISOString() : null,
      approvedAt: session.approvedAt ? session.approvedAt.toISOString() : null,
      notes: session.notes,
      variances,
      countedSoFar: [...counted.entries()].map(([productId, countedQty]) => ({
        productId,
        productName: names.get(productId) ?? '',
        countedQty,
      })),
    };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Scanned quantity per product within a session. */
  private async countedByProduct(sessionId: string): Promise<Map<string, number>> {
    const rows = await this.prisma.client.scanEvent.groupBy({
      by: ['productId'],
      where: { sessionId, scanType: 'CYCLE_COUNT' },
      _sum: { quantity: true },
    });
    return new Map(rows.map((r) => [r.productId, r._sum.quantity ?? 0]));
  }

  /**
   * Ledger-derived on-hand per product at a location — the "expected" side of
   * the variance. `SUM(qty * direction)`, exactly as every other quantity in
   * this module is derived.
   */
  private async expectedByProduct(locationId: string): Promise<Map<string, number>> {
    const rows = await this.prisma.client.$queryRaw<
      { product_id: string; qty: bigint }[]
    >`
      SELECT "product_id", COALESCE(SUM("qty" * "direction"), 0)::bigint AS qty
      FROM "StockLedgerEntry"
      WHERE "location_id" = ${locationId}
      GROUP BY "product_id"
      HAVING COALESCE(SUM("qty" * "direction"), 0) <> 0
    `;
    return new Map(rows.map((r) => [r.product_id, Number(r.qty)]));
  }

  private async productNames(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.client.product.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  private async requireSession(sessionId: string) {
    const session = await this.prisma.client.cycleCountSession.findFirst({
      where: { id: sessionId },
      select: { id: true, locationId: true, status: true },
    });
    if (!session) {
      throw new CycleCountStateError(`Cycle count session ${sessionId} not found.`, {
        sessionId,
      });
    }
    return session;
  }

  private tenantId(): string {
    const tid = this.prisma.currentTenantId;
    if (!tid) throw new Error('No tenant context');
    return tid;
  }
}
