import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';
import { PinoLogger } from 'nestjs-pino';

import { guardBullMq } from '../../common/queue/queue-guard';
import type { Env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import { BulkImportService } from './bulk-import.service';

export const INVENTORY_IMPORT_QUEUE = 'inventory-import';

/** How many pending row ids to claim per round trip. */
const CHUNK_SIZE = 100;
/** Budget for a single row's transaction. */
const ROW_TIMEOUT_MS = 15_000;
/** How long to wait for the uploading request's transaction to commit. */
const BATCH_VISIBILITY_ATTEMPTS = 25;
const BATCH_VISIBILITY_DELAY_MS = 200;

interface ImportJobData {
  tenantId: string;
  batchId: string;
}

/**
 * BulkImportProcessor (Slice 12a). Runs the staged import off the request
 * thread: the upload endpoint returns a batchId immediately and the client
 * polls `GET /inventory/bulk-imports/:id` for live progress.
 *
 * BullMQ rather than a cron: an import is triggered by a user action, must
 * start promptly, and needs per-job retry semantics.
 *
 * The job re-enters the tenant transaction itself — a worker has no HTTP
 * request and therefore no TenantInterceptor to open one, and every write it
 * makes must still pass RLS.
 */
@Injectable()
export class BulkImportProcessor implements OnModuleInit, OnModuleDestroy {
  private connection?: IORedis;
  private queue?: Queue<ImportJobData>;
  private worker?: Worker<ImportJobData>;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly imports: BulkImportService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(BulkImportProcessor.name);
  }

  onModuleInit(): void {
    if (this.config.get('DISABLE_BACKGROUND_JOBS', { infer: true })) return;

    this.connection = new IORedis(this.config.get('REDIS_URL', { infer: true }), {
      maxRetriesPerRequest: null,
    });
    const conn = this.connection as unknown as ConnectionOptions;

    this.queue = new Queue(INVENTORY_IMPORT_QUEUE, { connection: conn });
    this.worker = new Worker<ImportJobData>(
      INVENTORY_IMPORT_QUEUE,
      async (job) => {
        const { tenantId, batchId } = job.data;
        await this.runBatch(tenantId, batchId);
      },
      { connection: conn },
    );

    this.worker.on('failed', (job, err) => {
      this.logger.error(
        { jobId: job?.id, batchId: job?.data?.batchId, err: err.message },
        'Inventory import job failed',
      );
      // Surface the failure on the batch so the UI stops showing "processing".
      const data = job?.data;
      if (!data) return;
      void this.prisma
        .runInTenantContext(data.tenantId, () =>
          this.imports.failBatch(data.batchId, err.message),
        )
        .catch((e: Error) =>
          this.logger.error({ err: e.message }, 'Could not mark import batch failed'),
        );
    });

    guardBullMq(
      INVENTORY_IMPORT_QUEUE,
      { connection: this.connection, queue: this.queue, worker: this.worker },
      (m) => this.logger.error(m),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    this.connection?.disconnect();
  }

  /**
   * Drain a batch, applying one row per transaction.
   *
   * Two reasons it cannot be one big transaction. A real import is ~1,900 writes
   * for 625 products, far past Prisma's 5s interactive-transaction default. And
   * Postgres aborts a transaction outright on any error, so rows sharing one
   * would mean a single bad row killing the batch. Per-row transactions also let
   * progress land incrementally, so the UI progress bar actually moves.
   */
  async runBatch(tenantId: string, batchId: string): Promise<void> {
    // The batch row is still inside the uploading request's uncommitted
    // transaction when this starts, so it is briefly invisible to a separate
    // connection. Wait for the commit rather than failing with "not found" —
    // the queued path can hit the same race if a worker picks the job up fast.
    if (!(await this.waitForBatch(tenantId, batchId))) {
      this.logger.error({ batchId }, 'Import batch never became visible; giving up');
      return;
    }

    for (;;) {
      const rowIds = await this.prisma.runInTenantContext(tenantId, () =>
        this.imports.pendingRowIds(batchId, CHUNK_SIZE),
      );
      if (rowIds.length === 0) break;

      for (const rowId of rowIds) {
        try {
          await this.prisma.runInTenantContext(
            tenantId,
            () => this.imports.processRow(batchId, rowId),
            { timeout: ROW_TIMEOUT_MS, maxWait: ROW_TIMEOUT_MS },
          );
        } catch (err) {
          // The row's transaction is aborted, so its failure has to be recorded
          // from a fresh one — otherwise the write fails too (25P02) and one bad
          // row takes the whole import down.
          const message = err instanceof Error ? err.message : String(err);
          await this.prisma
            .runInTenantContext(tenantId, () => this.imports.markRowFailed(rowId, message))
            .catch((e: Error) =>
              this.logger.error({ rowId, err: e.message }, 'Could not record row failure'),
            );
        }
      }
    }
    await this.prisma.runInTenantContext(tenantId, () => this.imports.finalise(batchId));
  }

  /**
   * Enqueue a batch for processing. When background jobs are disabled (tests,
   * local runs without Redis) the batch still runs — detached from the HTTP
   * request so it gets its own transactions rather than inheriting the request's
   * 5s one — so the feature works end to end rather than stalling at PROCESSING.
   */
  async enqueue(tenantId: string, batchId: string): Promise<{ queued: boolean }> {
    if (!this.queue) {
      this.runDetached(tenantId, batchId);
      return { queued: false };
    }
    try {
      await this.queue.add(
        'process',
        { tenantId, batchId },
        { removeOnComplete: true, removeOnFail: 100, attempts: 3, backoff: { type: 'exponential', delay: 5_000 } },
      );
      return { queued: true };
    } catch (err) {
      // Redis being down must not lose the upload — fall back to running it here.
      this.logger.error(
        { batchId, err: err instanceof Error ? err.message : String(err) },
        'Could not enqueue import job; running it in-process',
      );
      this.runDetached(tenantId, batchId);
      return { queued: false };
    }
  }

  /** Poll briefly for the batch to become visible. True once it is. */
  private async waitForBatch(tenantId: string, batchId: string): Promise<boolean> {
    for (let attempt = 0; attempt < BATCH_VISIBILITY_ATTEMPTS; attempt += 1) {
      const found = await this.prisma.runInTenantContext(tenantId, (tx) =>
        tx.importBatch.findUnique({ where: { id: batchId }, select: { id: true } }),
      );
      if (found) return true;
      await new Promise((resolve) => setTimeout(resolve, BATCH_VISIBILITY_DELAY_MS));
    }
    return false;
  }

  /**
   * Run a batch outside the caller's transaction and without blocking the
   * response. The upload handler returns immediately and the client polls
   * `GET /inventory/bulk-imports/:id`, exactly as it does for the queued path.
   */
  private runDetached(tenantId: string, batchId: string): void {
    setImmediate(() => {
      void this.runBatch(tenantId, batchId).catch((err: Error) => {
        this.logger.error({ batchId, err: err.message }, 'Inline import failed');
        void this.prisma
          .runInTenantContext(tenantId, () => this.imports.failBatch(batchId, err.message))
          .catch(() => undefined);
      });
    });
  }
}
