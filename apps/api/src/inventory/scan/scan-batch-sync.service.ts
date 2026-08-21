import { Injectable, Logger } from '@nestjs/common';
import {
  CycleCountScanInputSchema,
  PERMISSIONS,
  ScanPickInputSchema,
  ScanPutawayInputSchema,
  ScanReceiveInputSchema,
  ScanTransferInputSchema,
  type BatchSyncItemResult,
  type BatchSyncResponse,
  type ScanBatchSyncInput,
} from '@procureflow/shared';
import type { ZodError, ZodSchema } from 'zod';

import { DomainError } from '../../common/errors/domain-error';
import { PrismaService } from '../../prisma/prisma.service';
import { ScanCycleCountService } from './scan-cycle-count.service';
import { ScanPickService } from './scan-pick.service';
import { ScanPutawayService } from './scan-putaway.service';
import { ScanReceiveService } from './scan-receive.service';
import { ScanTransferService } from './scan-transfer.service';

/** One entry of the request array. */
type SyncItem = ScanBatchSyncInput['scans'][number];

/**
 * The permission each queued scan needs, mirroring the guard on its live route.
 *
 * This table is not a convenience — it is the reason batch-sync is not a
 * privilege-escalation hole. Permissions in this API are enforced by a
 * controller-level guard, and batch-sync has exactly one guard for five
 * different operations. Without re-checking here, a user admitted on
 * `inventory:scan` could queue a RECEIVE and have it applied by a service that
 * never checks who is calling it.
 */
const REQUIRED_PERMISSION: Record<SyncItem['type'], string> = {
  RECEIVE: PERMISSIONS.STORES_RECEIVE_GOODS,
  PUTAWAY: PERMISSIONS.INVENTORY_SCAN,
  PICK: PERMISSIONS.INVENTORY_FULFILL,
  TRANSFER: PERMISSIONS.INVENTORY_SCAN,
  CYCLE_COUNT: PERMISSIONS.INVENTORY_SCAN,
};

/**
 * ScanBatchSyncService (Slice 13, Module 8) — draining the handset's offline
 * queue.
 *
 * **Why each scan gets its own transaction.** Every request in this API is
 * wrapped in a single interactive transaction by `TenantInterceptor`. Inside
 * one transaction, a failed statement poisons the whole thing: Postgres marks
 * it aborted and every later statement fails with "current transaction is
 * aborted". So catching an item's error in JavaScript is not enough to keep the
 * batch going — the connection is already unusable. Each item therefore runs in
 * its own `runInTenantContext`, a genuinely separate transaction with its own
 * RLS context. One over-pick rolls back exactly one scan, and the twelve good
 * scans behind it still land.
 *
 * **Order is preserved** in both directions: items are processed in the order
 * the device queued them (a putaway can depend on the receive in front of it),
 * and the results array is index-aligned with the request so the client can zip
 * results back onto its local queue without matching on anything else.
 */
@Injectable()
export class ScanBatchSyncService {
  private readonly logger = new Logger(ScanBatchSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly receive: ScanReceiveService,
    private readonly putaway: ScanPutawayService,
    private readonly pick: ScanPickService,
    private readonly cycleCount: ScanCycleCountService,
    private readonly transfer: ScanTransferService,
  ) {}

  async sync(
    input: ScanBatchSyncInput,
    actorId: string,
    tenantId: string,
    perms: string[],
  ): Promise<BatchSyncResponse> {
    const results: BatchSyncItemResult[] = [];

    for (const item of input.scans) {
      results.push(await this.processOne(item, actorId, tenantId, perms));
    }

    const summary = {
      total: results.length,
      succeeded: results.filter((r) => r.status === 'success').length,
      duplicates: results.filter((r) => r.status === 'duplicate').length,
      failed: results.filter((r) => r.status === 'error').length,
    };
    this.logger.log(
      `batch-sync: ${summary.succeeded} succeeded, ${summary.duplicates} duplicates, ${summary.failed} failed (${summary.total} total)`,
    );
    return { results, summary };
  }

  /**
   * One queue entry. Never throws: an item's failure is *its* result, not the
   * batch's. The only thing that can take the whole request down is a failure
   * outside the per-item transaction, which is why nothing else happens here.
   */
  private async processOne(
    item: SyncItem,
    actorId: string,
    tenantId: string,
    perms: string[],
  ): Promise<BatchSyncItemResult> {
    // Authorise the *operation*, not just the endpoint — see REQUIRED_PERMISSION.
    const needed = REQUIRED_PERMISSION[item.type];
    if (needed && !perms.includes(needed)) {
      return {
        clientUuid: item.clientUuid,
        status: 'error',
        detail: `You do not have permission to sync a ${item.type} scan (${needed} required).`,
      };
    }

    // An already-recorded scan is reported as a duplicate rather than replayed.
    // The device needs to hear "this one is done, drop it" — an error would keep
    // it in the queue forever, and a silent success would hide the double-send.
    const already = await this.prisma.client.scanEvent.findFirst({
      where: { clientUuid: item.clientUuid },
      select: { id: true, scanType: true },
    });
    if (already) {
      return {
        clientUuid: item.clientUuid,
        status: 'duplicate',
        detail: `Already recorded as ${already.scanType} scan ${already.id}.`,
      };
    }

    const schema = this.schemaFor(item.type);
    // The envelope's key wins over anything the payload carries: the idempotency
    // key the client reported is the one the result is reported against.
    const payload: Record<string, unknown> = {
      ...item.payload,
      clientUuid: item.clientUuid,
    };
    if (item.clientTimestamp && payload.clientTimestamp === undefined) {
      payload.clientTimestamp = item.clientTimestamp;
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      return {
        clientUuid: item.clientUuid,
        status: 'error',
        detail: 'Scan failed validation.',
        issues: this.issues(parsed.error),
      };
    }

    try {
      const detail = await this.prisma.runInTenantContext(tenantId, () =>
        this.dispatch(item, parsed.data, actorId),
      );
      return { clientUuid: item.clientUuid, status: 'success', detail };
    } catch (err) {
      // A scan the warehouse state refuses (over-pick, short stock, unknown
      // barcode) is a per-item error the operator must see and resolve — it is
      // not an outage, and must not stall the rest of the queue.
      if (err instanceof DomainError) {
        return { clientUuid: item.clientUuid, status: 'error', detail: err.message };
      }
      this.logger.error(
        `batch-sync item ${item.clientUuid} (${item.type}) failed unexpectedly`,
        err instanceof Error ? err.stack : String(err),
      );
      return {
        clientUuid: item.clientUuid,
        status: 'error',
        detail: 'Unexpected error processing this scan; it was not applied.',
      };
    }
  }

  /** Route a validated payload to the same service the live endpoint uses. */
  private async dispatch(
    item: SyncItem,
    payload: Record<string, unknown>,
    actorId: string,
  ): Promise<string> {
    switch (item.type) {
      case 'RECEIVE': {
        const r = await this.receive.receive(payload as never, actorId);
        return `Received ${r.ledgerEntry.qty}; on hand ${r.currentStockLevel}.`;
      }
      case 'PUTAWAY': {
        const r = await this.putaway.putaway(payload as never, actorId);
        return `Put away to ${r.binLocation.name}; ${r.remainingToPutaway} left to put away.`;
      }
      case 'PICK': {
        const r = await this.pick.pick(payload as never, actorId);
        return `Picked ${r.scanEvent.quantity}; ${r.line.remaining} remaining on the line.`;
      }
      case 'TRANSFER': {
        const r = await this.transfer.transfer(payload as never, actorId);
        return `Transferred ${r.scanEvent.quantity} from ${r.sourceBin.name} to ${r.destBin.name}.`;
      }
      case 'CYCLE_COUNT': {
        if (!item.sessionId) {
          throw new SyncItemError(
            'A cycle-count scan must name the session it belongs to.',
          );
        }
        const r = await this.cycleCount.scan(item.sessionId, payload as never, actorId);
        return `Counted against session ${r.id}.`;
      }
      default:
        throw new SyncItemError(`Unsupported scan type "${String(item.type)}".`);
    }
  }

  private schemaFor(type: SyncItem['type']): ZodSchema {
    switch (type) {
      case 'RECEIVE':
        return ScanReceiveInputSchema;
      case 'PUTAWAY':
        return ScanPutawayInputSchema;
      case 'PICK':
        return ScanPickInputSchema;
      case 'TRANSFER':
        return ScanTransferInputSchema;
      case 'CYCLE_COUNT':
        return CycleCountScanInputSchema;
    }
  }

  /** Field-level issues, in the same shape the validation pipe surfaces them. */
  private issues(error: ZodError): { path: string; message: string }[] {
    return error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  }
}

/** A per-item failure that is the item's fault, reported without a stack trace. */
class SyncItemError extends DomainError {
  readonly status = 422;
  readonly type = 'https://procureflow.io/errors/scan-sync-item';
  readonly title = 'Queued scan rejected';
}
