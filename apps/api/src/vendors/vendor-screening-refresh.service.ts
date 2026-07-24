import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ScreeningType } from '@procureflow/shared';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';

import type { Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { VendorVerificationService } from './vendor-verification.service';

export const VENDOR_SCREENING_REFRESH_QUEUE = 'vendor-screening-refresh';

/**
 * VendorScreeningRefreshService (Slice 10c). Activates Slice 7's per-type refresh
 * cadence (GSTIN monthly, sanctions quarterly, credit annually — encoded as
 * `nextScreeningDueAt`) against the real (simulator-backed) providers. A nightly
 * job re-screens every due (vendor, type) pair; a manual trigger re-screens the
 * full active vendor list for a type (e.g. a quarterly sanctions sweep). Per-tenant
 * loop so one tenant's provider outage never blocks another's refresh.
 */
@Injectable()
export class VendorScreeningRefreshService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VendorScreeningRefreshService.name);
  private queue?: Queue;
  private worker?: Worker;
  private connection?: IORedis;

  constructor(
    private readonly prisma: PrismaService,
    private readonly verification: VendorVerificationService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void {
    if (this.config.get('DISABLE_BACKGROUND_JOBS', { infer: true })) return;
    this.connection = new IORedis(this.config.get('REDIS_URL', { infer: true }), {
      maxRetriesPerRequest: null,
    });
    const conn = this.connection as unknown as ConnectionOptions;
    this.queue = new Queue(VENDOR_SCREENING_REFRESH_QUEUE, { connection: conn });
    // Daily at 05:00 — the per-type cadence is enforced by nextScreeningDueAt, so
    // a daily sweep only re-screens whatever is actually due that day.
    void this.queue.add(
      'daily',
      {},
      { repeat: { pattern: '0 5 * * *' }, removeOnComplete: true, removeOnFail: 50 },
    );
    this.worker = new Worker(
      VENDOR_SCREENING_REFRESH_QUEUE,
      async () => {
        await this.refreshAllTenants();
      },
      { connection: conn },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error(`Screening refresh job ${job?.id} failed: ${err.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    this.connection?.disconnect();
  }

  /** Nightly sweep — every tenant in its own RLS context; failures isolated. */
  async refreshAllTenants(): Promise<{ tenants: number; rescreened: number }> {
    const tenants = await this.prisma.tenant.findMany({ select: { id: true } });
    let rescreened = 0;
    for (const t of tenants) {
      try {
        const r = await this.prisma.runInTenantContext(t.id, () => this.refreshDue());
        rescreened += r.rescreened;
      } catch (err) {
        this.logger.warn(`Screening refresh failed for tenant ${t.id}: ${String(err)}`);
      }
    }
    return { tenants: tenants.length, rescreened };
  }

  /** Re-screen every (vendor, type) whose latest screening is due (current tenant). */
  async refreshDue(): Promise<{ rescreened: number }> {
    const now = new Date();
    const due = await this.prisma.client.vendorScreening.findMany({
      where: {
        nextScreeningDueAt: { lte: now },
        status: { in: ['CLEAR', 'FLAGGED', 'EXPIRED'] },
      },
      orderBy: { completedAt: 'desc' },
      select: {
        vendorId: true,
        screeningType: true,
        vendor: { select: { status: true } },
      },
    });
    const seen = new Set<string>();
    let rescreened = 0;
    for (const s of due) {
      const key = `${s.vendorId}|${s.screeningType}`;
      if (seen.has(key)) continue; // only the latest per (vendor,type)
      seen.add(key);
      if (s.vendor.status !== 'ACTIVE') continue;
      await this.verification.runScreening(s.vendorId, s.screeningType, 'system');
      rescreened += 1;
    }
    return { rescreened };
  }

  /** Manual re-screen of every ACTIVE vendor for one type (current tenant). */
  async rescreenAll(
    screeningType: ScreeningType,
    actorId: string,
  ): Promise<{ vendors: number; flagged: number }> {
    const vendors = await this.prisma.client.vendor.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true },
    });
    let flagged = 0;
    for (const v of vendors) {
      const r = await this.verification.runScreening(v.id, screeningType, actorId);
      if (r.status === 'FLAGGED') flagged += 1;
    }
    return { vendors: vendors.length, flagged };
  }
}
