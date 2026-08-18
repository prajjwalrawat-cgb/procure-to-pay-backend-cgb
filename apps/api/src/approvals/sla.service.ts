import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { newId } from '@procureflow/db';
import type { ApprovalContext, ApprovalStep, DocumentType } from '@procureflow/shared';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';
import { PinoLogger } from 'nestjs-pino';

import { AuditLogService } from '../audit/audit.service';
import { DomainEventService } from '../common/events/domain-event.service';
import {
  SCHEDULER_DRAIN_DELAY_SECONDS,
  guardBullMq,
  scheduleRepeatable,
  schedulersDisabled,
} from '../common/queue/queue-guard';
import type { Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { ApprovalContextService } from './approval-context.service';
import { ApproverResolver } from './approver-resolver.service';
import { NotificationService } from './notification.service';

export const SLA_QUEUE = 'approval-sla';

interface Snapshot {
  steps: ApprovalStep[];
}

/**
 * SlaService (Slice 2). A BullMQ repeatable job runs the sweep every 5 minutes.
 * For each pending approval past its SLA with an `escalate_to` target, it adds an
 * escalation approver (never auto-decides, never removes the original). The
 * sweep methods are pure enough to unit-test without Redis.
 */
@Injectable()
export class SlaService implements OnModuleInit, OnModuleDestroy {
  private connection?: IORedis;
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly resolver: ApproverResolver,
    private readonly context: ApprovalContextService,
    private readonly audit: AuditLogService,
    private readonly events: DomainEventService,
    private readonly notifications: NotificationService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SlaService.name);
  }

  onModuleInit(): void {
    if (schedulersDisabled(this.config)) return;
    this.connection = new IORedis(this.config.get('REDIS_URL', { infer: true }), {
      maxRetriesPerRequest: null,
    });
    const conn = this.connection as unknown as ConnectionOptions;
    this.queue = new Queue(SLA_QUEUE, { connection: conn });
    scheduleRepeatable(
      SLA_QUEUE,
      this.queue,
      'sweep',
      { repeat: { every: 5 * 60 * 1000 }, removeOnComplete: true, removeOnFail: 50 },
      (m) => this.logger.error(m),
    );
    this.worker = new Worker(
      SLA_QUEUE,
      async () => {
        await this.sweepAll();
      },
      { connection: conn, drainDelay: SCHEDULER_DRAIN_DELAY_SECONDS },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error({ jobId: job?.id, err: err.message }, 'SLA sweep failed');
    });
    guardBullMq(
      SLA_QUEUE,
      { connection: this.connection, queue: this.queue, worker: this.worker },
      (m) => this.logger.error(m),
    );
  }

  /** Sweep every tenant. Each tenant runs in its own RLS context. */
  async sweepAll(): Promise<number> {
    const tenants = await this.prisma.tenant.findMany({ select: { id: true } });
    let escalations = 0;
    for (const t of tenants) {
      escalations += await this.prisma.runInTenantContext(t.id, () =>
        this.sweepTenant(t.id),
      );
    }
    return escalations;
  }

  /** Sweep one tenant (must run inside its tenant context). */
  async sweepTenant(tenantId: string): Promise<number> {
    const now = new Date();
    const breached = await this.prisma.client.approval.findMany({
      where: {
        decision: 'PENDING',
        isEscalation: false,
        escalatedAt: null,
        slaDueAt: { lt: now },
      },
    });

    let count = 0;
    for (const appr of breached) {
      const escalated = await this.escalate(tenantId, appr);
      await this.events.emit('SlaBreached', {
        approvalId: appr.id,
        documentType: appr.documentType,
        documentId: appr.documentId,
        escalated,
      });
      if (escalated) count += 1;
    }
    return count;
  }

  private async escalate(
    tenantId: string,
    appr: {
      id: string;
      documentType: DocumentType;
      documentId: string;
      stepNo: number;
      matrixSnapshotId: string;
    },
  ): Promise<boolean> {
    const snapshot = await this.readSnapshot(appr.documentType, appr.documentId);
    const step = snapshot?.steps.find((s) => s.step_no === appr.stepNo);
    // Mark the original escalated so the same breach isn't processed twice.
    await this.prisma.client.approval.update({
      where: { id: appr.id },
      data: { escalatedAt: new Date() },
    });
    if (!step?.escalate_to) return false;

    const ctx = await this.context
      .build(appr.documentType, appr.documentId)
      .catch(() => null);
    if (!ctx) return false;
    const candidates = await this.resolver.candidatesForRole(
      step.escalate_to.role,
      'tenant',
      ctx as ApprovalContext,
    );
    if (candidates.length !== 1) return false;
    const target = candidates[0] as string;

    await this.prisma.client.approval.create({
      data: {
        id: newId('approval'),
        tenantId,
        documentType: appr.documentType,
        documentId: appr.documentId,
        stepNo: appr.stepNo,
        stepName: `${step.name} (escalation)`,
        scope: 'tenant',
        parallelGroup: appr.stepNo ? `escalation-${appr.stepNo}` : null,
        approverId: target,
        isEscalation: true,
        slaHours: step.escalate_to.sla_hours,
        slaDueAt: new Date(Date.now() + step.escalate_to.sla_hours * 60 * 60 * 1000),
        matrixSnapshotId: appr.matrixSnapshotId,
      },
    });
    await this.audit.record({
      action: 'SLA_ESCALATED',
      entityType: entityType(appr.documentType),
      entityId: appr.documentId,
      actorType: 'SYSTEM',
      after: { approvalId: appr.id, escalatedTo: target, stepNo: appr.stepNo },
    });
    await this.notifications.notify({
      userId: target,
      tenantId,
      type: 'SLA_ESCALATION',
      title: `Escalated approval awaiting you`,
      entityType: entityType(appr.documentType),
      entityId: appr.documentId,
    });
    return true;
  }

  private async readSnapshot(
    documentType: DocumentType,
    documentId: string,
  ): Promise<Snapshot | null> {
    if (documentType === 'INVOICE') {
      const inv = await this.prisma.client.invoice.findUnique({
        where: { id: documentId },
        select: { approvalMatrixSnapshot: true },
      });
      return (inv?.approvalMatrixSnapshot as unknown as Snapshot | null) ?? null;
    }
    if (documentType === 'PAYMENT_RUN') {
      const run = await this.prisma.client.paymentRun.findUnique({
        where: { id: documentId },
        select: { approvals: true },
      });
      return (run?.approvals as unknown as Snapshot | null) ?? null;
    }
    return null;
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    this.connection?.disconnect();
  }
}

function entityType(documentType: DocumentType): string {
  return documentType === 'INVOICE'
    ? 'Invoice'
    : documentType === 'PAYMENT_RUN'
      ? 'PaymentRun'
      : documentType;
}
