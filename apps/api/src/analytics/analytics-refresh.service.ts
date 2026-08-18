import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { newId } from '@procureflow/db';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';
import { PinoLogger } from 'nestjs-pino';

import { ApprovalRoutingService } from '../approvals/approval-routing.service';
import {
  SCHEDULER_DRAIN_DELAY_SECONDS,
  guardBullMq,
  scheduleRepeatable,
  schedulersDisabled,
} from '../common/queue/queue-guard';
import type { Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';

export const ANALYTICS_REFRESH_QUEUE = 'analytics-refresh';

/** Views the refresh job maintains (job-refreshed summary tables — ADR-028). */
export const REFRESHABLE_VIEWS = [
  'spend_monthly',
  'vendor_monthly',
  'msme_monthly',
] as const;
export type RefreshableView = (typeof REFRESHABLE_VIEWS)[number];

interface SpendRow {
  month: string;
  gross: string;
  tax: string;
  net: string;
  cnt: number;
}
interface VendorRow extends SpendRow {
  vendorId: string;
}
interface MsmeRow {
  month: string;
  breach_count: number;
  breach_exposure: string;
}

/**
 * AnalyticsRefreshService (Slice 8, ADR-027/028). Recomputes the RLS-protected
 * summary tables (spend / vendor / msme monthly) per tenant on a nightly BullMQ
 * job, plus event-triggered partial refreshes (RFQ award approved, payment run
 * submitted) debounced to at most one per tenant per 5 minutes. Uses summary
 * tables rather than Postgres materialized views so tenant isolation stays under
 * RLS (Master Context §3 rule #1) — MVs cannot carry RLS policies.
 */
@Injectable()
export class AnalyticsRefreshService implements OnModuleInit, OnModuleDestroy {
  private connection?: IORedis;
  private queue?: Queue;
  private worker?: Worker;
  private readonly lastRefresh = new Map<string, number>();
  private static readonly DEBOUNCE_MS = 5 * 60 * 1000;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly routing: ApprovalRoutingService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AnalyticsRefreshService.name);
  }

  onModuleInit(): void {
    // Event-triggered partial refresh: award / payment-run approvals fire a
    // debounced refresh so same-day drill-downs don't wait for the nightly job.
    this.routing.onApproved('RFQ_AWARD', (_id, _actor) => this.triggerRefresh('EVENT'));
    this.routing.onApproved('PAYMENT_RUN', (_id, _actor) => this.triggerRefresh('EVENT'));

    if (schedulersDisabled(this.config)) return;
    this.connection = new IORedis(this.config.get('REDIS_URL', { infer: true }), {
      maxRetriesPerRequest: null,
    });
    const conn = this.connection as unknown as ConnectionOptions;
    this.queue = new Queue(ANALYTICS_REFRESH_QUEUE, { connection: conn });
    scheduleRepeatable(
      ANALYTICS_REFRESH_QUEUE,
      this.queue,
      'nightly',
      { repeat: { pattern: '0 3 * * *' }, removeOnComplete: true, removeOnFail: 50 },
      (m) => this.logger.error(m),
    );
    this.worker = new Worker(
      ANALYTICS_REFRESH_QUEUE,
      async () => {
        await this.refreshAll('SCHEDULED');
      },
      { connection: conn, drainDelay: SCHEDULER_DRAIN_DELAY_SECONDS },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error({ jobId: job?.id, err: err.message }, 'Analytics refresh failed');
    });
    guardBullMq(
      ANALYTICS_REFRESH_QUEUE,
      { connection: this.connection, queue: this.queue, worker: this.worker },
      (m) => this.logger.error(m),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    this.connection?.disconnect();
  }

  /** Refresh every tenant, each in its own RLS context (nightly full refresh). */
  async refreshAll(trigger: string): Promise<{ tenants: number }> {
    const tenants = await this.prisma.tenant.findMany({ select: { id: true } });
    for (const t of tenants) {
      await this.prisma.runInTenantContext(t.id, () => this.refreshTenant(t.id, trigger));
    }
    return { tenants: tenants.length };
  }

  /**
   * Event-triggered refresh of the CURRENT tenant, debounced. Runs inline in the
   * deciding request's tenant context (called from an approval hook).
   */
  async triggerRefresh(trigger: string): Promise<void> {
    const tenantId = this.prisma.currentTenantId;
    if (!tenantId) return;
    const last = this.lastRefresh.get(tenantId) ?? 0;
    if (Date.now() - last < AnalyticsRefreshService.DEBOUNCE_MS) return;
    try {
      await this.refreshTenant(tenantId, trigger);
    } catch (e) {
      this.logger.error({ err: (e as Error).message }, 'Event-triggered refresh failed');
    }
  }

  /** Recompute all summary tables for one tenant (must run inside its context). */
  async refreshTenant(
    tenantId: string,
    trigger: string,
    views: readonly RefreshableView[] = REFRESHABLE_VIEWS,
  ): Promise<void> {
    const start = Date.now();
    if (views.includes('spend_monthly')) await this.refreshSpendMonthly(tenantId);
    if (views.includes('vendor_monthly')) await this.refreshVendorMonthly(tenantId);
    if (views.includes('msme_monthly')) await this.refreshMsmeMonthly(tenantId);
    this.lastRefresh.set(tenantId, Date.now());
    const durationMs = Date.now() - start;
    for (const v of views) {
      await this.stampRefresh(tenantId, v, trigger, durationMs);
    }
  }

  private async stampRefresh(
    tenantId: string,
    viewName: string,
    trigger: string,
    durationMs: number,
  ): Promise<void> {
    const now = new Date();
    await this.prisma.client.analyticsRefreshLog.upsert({
      where: { tenantId_viewName: { tenantId, viewName } },
      create: {
        id: newId('analyticsRefreshLog'),
        tenantId,
        viewName,
        refreshedAt: now,
        trigger,
        durationMs,
        status: 'OK',
      },
      update: { refreshedAt: now, trigger, durationMs, status: 'OK' },
    });
  }

  /** Spend excludes rejected + pre-recognition (RECEIVED/OCR) invoices. */
  private async refreshSpendMonthly(tenantId: string): Promise<void> {
    const rows = await this.prisma.client.$queryRawUnsafe<SpendRow[]>(
      `SELECT to_char("invoiceDate",'YYYY-MM') AS month,
              COALESCE(SUM("grossAmount"),0)::text AS gross,
              COALESCE(SUM("taxAmount"),0)::text AS tax,
              COALESCE(SUM("netAmount"),0)::text AS net,
              COUNT(*)::int AS cnt
       FROM "Invoice"
       WHERE status NOT IN ('REJECTED','RECEIVED','OCR_PENDING','OCR_DONE')
       GROUP BY 1`,
    );
    const now = new Date();
    await this.prisma.client.analyticsSpendMonthly.deleteMany({});
    if (rows.length) {
      await this.prisma.client.analyticsSpendMonthly.createMany({
        data: rows.map((r) => ({
          id: newId('analyticsSpendMonthly'),
          tenantId,
          month: r.month,
          grossSpend: r.gross,
          taxSpend: r.tax,
          netSpend: r.net,
          txnCount: Number(r.cnt),
          refreshedAt: now,
        })),
      });
    }
  }

  private async refreshVendorMonthly(tenantId: string): Promise<void> {
    const rows = await this.prisma.client.$queryRawUnsafe<VendorRow[]>(
      `SELECT vendor_id AS "vendorId", to_char("invoiceDate",'YYYY-MM') AS month,
              COALESCE(SUM("grossAmount"),0)::text AS gross,
              COALESCE(SUM("netAmount"),0)::text AS net,
              COUNT(*)::int AS cnt
       FROM "Invoice"
       WHERE status NOT IN ('REJECTED','RECEIVED','OCR_PENDING','OCR_DONE')
       GROUP BY 1, 2`,
    );
    const now = new Date();
    await this.prisma.client.analyticsVendorMonthly.deleteMany({});
    if (rows.length) {
      await this.prisma.client.analyticsVendorMonthly.createMany({
        data: rows.map((r) => ({
          id: newId('analyticsVendorMonthly'),
          tenantId,
          vendorId: r.vendorId,
          month: r.month,
          grossSpend: r.gross,
          netSpend: r.net,
          txnCount: Number(r.cnt),
          refreshedAt: now,
        })),
      });
    }
  }

  /** MSME breach trend: currently-unpaid MSME invoices past their due date,
   *  bucketed by the invoice month. Interest exposure = net × (rbi×3) × daysLate/365. */
  private async refreshMsmeMonthly(tenantId: string): Promise<void> {
    const cfg = await this.prisma.client.tenantComplianceConfig.findUnique({
      where: { tenantId },
    });
    const rbiPct = cfg ? Number(cfg.rbiReferenceRatePct) : 6.5;
    const annualRate = (rbiPct * 3) / 100;
    const rows = await this.prisma.client.$queryRawUnsafe<MsmeRow[]>(
      `SELECT to_char(i."invoiceDate",'YYYY-MM') AS month,
              COUNT(*)::int AS breach_count,
              COALESCE(SUM(
                i."netAmount" * ${annualRate}
                * GREATEST(0, (CURRENT_DATE - i."msmeDueDate"::date)) / 365.0
              ),0)::text AS breach_exposure
       FROM "Invoice" i
       JOIN "Vendor" v ON v.id = i.vendor_id AND v."isMsme" = true
       WHERE i.status <> 'PAID' AND i."msmeDueDate" IS NOT NULL
             AND i."msmeDueDate"::date < CURRENT_DATE
       GROUP BY 1`,
    );
    const now = new Date();
    await this.prisma.client.analyticsMsmeMonthly.deleteMany({});
    if (rows.length) {
      await this.prisma.client.analyticsMsmeMonthly.createMany({
        data: rows.map((r) => ({
          id: newId('analyticsMsmeMonthly'),
          tenantId,
          month: r.month,
          breachCount: Number(r.breach_count),
          breachExposure: r.breach_exposure,
          refreshedAt: now,
        })),
      });
    }
  }
}
