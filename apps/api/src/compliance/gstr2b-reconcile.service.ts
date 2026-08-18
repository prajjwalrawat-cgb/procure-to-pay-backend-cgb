import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, newId } from '@procureflow/db';
import type { Gstr2bReconResult, Gstr2bStatusValue } from '@procureflow/shared';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';

import { AuditLogService } from '../audit/audit.service';
import { DomainEventService } from '../common/events/domain-event.service';
import {
  SCHEDULER_DRAIN_DELAY_SECONDS,
  guardBullMq,
  scheduleRepeatable,
  schedulersDisabled,
} from '../common/queue/queue-guard';
import type { Env } from '../config/env';
import { GspClient, type Gstr2bEntry } from '../integrations/gsp/gsp-client';
import { PrismaService } from '../prisma/prisma.service';
import { classifyGstr2b } from './gstr2b-logic';

export const GSTR2B_RECONCILE_QUEUE = 'gstr2b-reconcile';

const RECONCILABLE_STATUSES = [
  'OCR_DONE',
  'MATCH_EXCEPTION',
  'AWAITING_APPROVAL',
  'APPROVED',
  'SCHEDULED',
  'PAID',
  'HELD',
];

/**
 * Gstr2bReconciliationService (Slice 10a). Nightly job that fetches the tenant's
 * GSTR-2B via the GSP and reconciles it against open invoices on
 * GSTIN + invoice ref + amount (§9), assigning one of the four existing statuses
 * — MATCHED / MISMATCH_AMOUNT / MISMATCH_DATE / NOT_FOUND — and raising a
 * GSTR2B_MISMATCH exception on genuine discrepancies. Per-tenant loop so one
 * tenant's GSP outage never blocks another's reconciliation.
 */
@Injectable()
export class Gstr2bReconciliationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(Gstr2bReconciliationService.name);
  private queue?: Queue;
  private worker?: Worker;
  private connection?: IORedis;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gsp: GspClient,
    private readonly audit: AuditLogService,
    private readonly events: DomainEventService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void {
    if (schedulersDisabled(this.config)) return;
    this.connection = new IORedis(this.config.get('REDIS_URL', { infer: true }), {
      maxRetriesPerRequest: null,
    });
    const conn = this.connection as unknown as ConnectionOptions;
    this.queue = new Queue(GSTR2B_RECONCILE_QUEUE, { connection: conn });
    scheduleRepeatable(
      GSTR2B_RECONCILE_QUEUE,
      this.queue,
      'nightly',
      { repeat: { pattern: '0 4 * * *' }, removeOnComplete: true, removeOnFail: 50 },
      (m) => this.logger.error(m),
    );
    this.worker = new Worker(
      GSTR2B_RECONCILE_QUEUE,
      async () => {
        await this.reconcileAllTenants();
      },
      { connection: conn, drainDelay: SCHEDULER_DRAIN_DELAY_SECONDS },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error(`GSTR-2B recon job ${job?.id} failed: ${err.message}`);
    });
    guardBullMq(
      GSTR2B_RECONCILE_QUEUE,
      { connection: this.connection, queue: this.queue, worker: this.worker },
      (m) => this.logger.error(m),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    this.connection?.disconnect();
  }

  /** Nightly sweep — every tenant in its own RLS context; failures isolated. */
  async reconcileAllTenants(): Promise<{ tenants: number }> {
    const tenants = await this.prisma.tenant.findMany({ select: { id: true } });
    for (const t of tenants) {
      try {
        await this.prisma.runInTenantContext(t.id, () => this.reconcileTenant(t.id));
      } catch (err) {
        this.logger.warn(`GSTR-2B recon failed for tenant ${t.id}: ${String(err)}`);
      }
    }
    return { tenants: tenants.length };
  }

  /** Reconcile the current tenant (must be called inside a tenant context). */
  async reconcileTenant(tenantId: string): Promise<Gstr2bReconResult> {
    const { entries, simulated } = await this.gsp.fetchGstr2b(tenantId);
    const byKey = new Map<string, Gstr2bEntry>();
    for (const e of entries) byKey.set(`${e.supplierGstin}|${e.docNo}`, e);

    const invoices = await this.prisma.client.invoice.findMany({
      where: {
        status: { in: RECONCILABLE_STATUSES as never },
        vendorInvoiceRef: { not: '' },
      },
      include: { vendor: { select: { gstin: true } } },
      take: 1000,
    });

    const counts = { matched: 0, mismatchAmount: 0, mismatchDate: 0, notFound: 0 };
    for (const inv of invoices) {
      const gstin = inv.vendor?.gstin;
      if (!gstin || !inv.vendorInvoiceRef) continue;
      const entry = byKey.get(`${gstin}|${inv.vendorInvoiceRef}`);
      const status = this.classify(inv, entry);
      if (status === 'MATCHED') counts.matched += 1;
      else if (status === 'MISMATCH_AMOUNT') counts.mismatchAmount += 1;
      else if (status === 'MISMATCH_DATE') counts.mismatchDate += 1;
      else counts.notFound += 1;

      if (inv.gstr2bStatus !== status || inv.gstr2bMatchedAt === null) {
        await this.applyStatus(inv.id, tenantId, status);
      }
    }

    await this.audit.record({
      action: 'gstr2b.reconciled',
      entityType: 'Tenant',
      entityId: tenantId,
      actorType: 'SYSTEM',
      after: { ...counts, invoicesScanned: invoices.length, simulated },
      tenantId,
    });

    return {
      invoicesScanned: invoices.length,
      matched: counts.matched,
      mismatchAmount: counts.mismatchAmount,
      mismatchDate: counts.mismatchDate,
      notFound: counts.notFound,
      ranAt: new Date().toISOString(),
      simulated,
    };
  }

  private classify(
    inv: { grossAmount: Prisma.Decimal; invoiceDate: Date },
    entry: Gstr2bEntry | undefined,
  ): Gstr2bStatusValue {
    return classifyGstr2b({
      invoiceGross: inv.grossAmount.toString(),
      invoiceDay: inv.invoiceDate.toISOString().slice(0, 10),
      entry: entry
        ? { invoiceValue: entry.invoiceValue, docDate: entry.docDate }
        : undefined,
    });
  }

  private async applyStatus(
    invoiceId: string,
    tenantId: string,
    status: Gstr2bStatusValue,
  ): Promise<void> {
    await this.prisma.client.invoice.update({
      where: { id: invoiceId },
      data: { gstr2bStatus: status, gstr2bMatchedAt: new Date() },
    });
    // Genuine discrepancies (not a not-yet-filed vendor) raise a resolvable
    // exception; NOT_FOUND is informational (vendor may file next period).
    if (status === 'MISMATCH_AMOUNT' || status === 'MISMATCH_DATE') {
      const existing = await this.prisma.client.invoiceException.findFirst({
        where: { invoiceId, exceptionType: 'GSTR2B_MISMATCH', resolvedAt: null },
      });
      if (!existing) {
        await this.prisma.client.invoiceException.create({
          data: {
            id: newId('invoiceException'),
            tenantId,
            invoiceId,
            exceptionType: 'GSTR2B_MISMATCH',
            severity: 'MEDIUM',
            details: { status } as unknown as Prisma.InputJsonValue,
            raisedBy: 'system',
          },
        });
      }
    }
    await this.audit.record({
      action: 'invoice.gstr2b_status_set',
      entityType: 'Invoice',
      entityId: invoiceId,
      actorType: 'SYSTEM',
      after: { gstr2bStatus: status },
      tenantId,
    });
    await this.events.emit('Gstr2bReconciled', { invoiceId, status }, tenantId);
  }
}
