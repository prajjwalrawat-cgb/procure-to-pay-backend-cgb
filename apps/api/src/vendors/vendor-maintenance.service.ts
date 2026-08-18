import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';
import { PinoLogger } from 'nestjs-pino';

import {
  SCHEDULER_DRAIN_DELAY_SECONDS,
  guardBullMq,
  scheduleRepeatable,
  schedulersDisabled,
} from '../common/queue/queue-guard';
import type { Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { VendorDocumentService } from './vendor-document.service';
import { VendorScorecardService } from './vendor-scorecard.service';

export const VENDOR_MAINTENANCE_QUEUE = 'vendor-maintenance';

/**
 * VendorMaintenanceService (Slice 7 — audit remediation). Registers a nightly
 * BullMQ repeatable job that, per tenant: runs the document-expiry scan
 * (warns on documents nearing expiry, marks lapsed ones EXPIRED and
 * auto-suspends vendors whose mandatory documents expired) and refreshes vendor
 * scorecards. Mirrors SlaService; `sweepAll` is Redis-free and unit-tested.
 *
 * Before this, expireCheck/refreshAll existed but were never scheduled — the
 * compliance control silently did nothing (audit finding, Slice 7).
 */
@Injectable()
export class VendorMaintenanceService implements OnModuleInit, OnModuleDestroy {
  private connection?: IORedis;
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly documents: VendorDocumentService,
    private readonly scorecards: VendorScorecardService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(VendorMaintenanceService.name);
  }

  onModuleInit(): void {
    if (schedulersDisabled(this.config)) return;
    this.connection = new IORedis(this.config.get('REDIS_URL', { infer: true }), {
      maxRetriesPerRequest: null,
    });
    const conn = this.connection as unknown as ConnectionOptions;
    this.queue = new Queue(VENDOR_MAINTENANCE_QUEUE, { connection: conn });
    // Nightly at 02:00. Repeatable job is idempotent — re-adding is a no-op.
    scheduleRepeatable(
      VENDOR_MAINTENANCE_QUEUE,
      this.queue,
      'nightly',
      { repeat: { pattern: '0 2 * * *' }, removeOnComplete: true, removeOnFail: 50 },
      (m) => this.logger.error(m),
    );
    this.worker = new Worker(
      VENDOR_MAINTENANCE_QUEUE,
      async () => {
        await this.sweepAll();
      },
      { connection: conn, drainDelay: SCHEDULER_DRAIN_DELAY_SECONDS },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error(
        { jobId: job?.id, err: err.message },
        'Vendor maintenance sweep failed',
      );
    });
    guardBullMq(
      VENDOR_MAINTENANCE_QUEUE,
      { connection: this.connection, queue: this.queue, worker: this.worker },
      (m) => this.logger.error(m),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    this.connection?.disconnect();
  }

  /** Nightly sweep across every tenant, each in its own RLS context. */
  async sweepAll(): Promise<{ tenants: number; expired: number; suspended: number }> {
    const tenants = await this.prisma.tenant.findMany({ select: { id: true } });
    let expired = 0;
    let suspended = 0;
    for (const t of tenants) {
      await this.prisma.runInTenantContext(t.id, async () => {
        const res = await this.documents.expireCheck(t.id);
        expired += res.expired;
        suspended += res.suspended;
        await this.scorecards.refreshAll(t.id);
      });
    }
    return { tenants: tenants.length, expired, suspended };
  }
}
