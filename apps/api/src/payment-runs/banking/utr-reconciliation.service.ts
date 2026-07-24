import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { newId } from '@procureflow/db';
import {
  DOMAIN_EVENTS,
  type BankConfirmationResult,
  type BankReconciliationResponse,
} from '@procureflow/shared';

import { AuditLogService } from '../../audit/audit.service';
import { DomainEventService } from '../../common/events/domain-event.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PaymentRunStateError } from '../payment-run.errors';
import { BankSubmissionService } from './bank-submission.service';
import { BANK_GATEWAY, type IBankGateway } from './bank-gateway';

/**
 * UtrReconciliationService (Slice 10b). Confirms a submitted batch (poll/webhook),
 * replacing every `STUB-…` UTR with a real bank-issued UTR going forward. On
 * confirmation it creates the immutable PaymentRecord with `is_stub = false` and
 * moves the invoice to PAID — nothing is marked paid until the bank confirms.
 * Historical `is_stub = true` records are NEVER rewritten (audit honesty). Failed
 * items surface for correction + resubmission; they don't block the successful ones.
 */
@Injectable()
export class UtrReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly events: DomainEventService,
    private readonly submission: BankSubmissionService,
    @Inject(BANK_GATEWAY) private readonly gateway: IBankGateway,
  ) {}

  /** Bank confirmation callback/poll — finalises accepted items to PAID. */
  async confirmRun(runId: string, actorId: string): Promise<BankConfirmationResult> {
    const run = await this.loadRun(runId);
    if (!run) throw new NotFoundException('Payment run not found');
    const intent = await this.prisma.client.paymentSubmissionIntent.findFirst({
      where: { paymentRunId: runId, status: 'SUBMITTED' },
      orderBy: { attemptNo: 'desc' },
    });
    if (!intent) {
      throw new PaymentRunStateError('No submitted batch is awaiting confirmation.', {
        status: run.status,
      });
    }

    const payees = this.submission.buildPayees(run);
    const result = await this.gateway.confirm(intent.bankBatchRef ?? '', payees);

    let confirmed = 0;
    let failed = 0;
    const now = new Date();
    for (const it of result.items) {
      const item = run.items.find((x) => x.invoiceId === it.invoiceId);
      if (!item) continue;
      if (it.accepted && it.utr) {
        // Idempotent: don't double-post if a record already exists for this run+invoice.
        const exists = await this.prisma.client.paymentRecord.findFirst({
          where: { paymentRunId: runId, invoiceId: it.invoiceId },
        });
        if (!exists) {
          await this.prisma.client.paymentRecord.create({
            data: {
              id: newId('paymentRecord'),
              tenantId: run.tenantId,
              invoiceId: it.invoiceId,
              paymentRunId: runId,
              gross: item.gross,
              tds: item.tds,
              net: item.net,
              utr: it.utr, // REAL bank UTR
              isStub: false, // no longer a stub — real transaction
              paidAt: now,
            },
          });
          await this.prisma.client.invoice.update({
            where: { id: it.invoiceId },
            data: { status: 'PAID', paidAt: now },
          });
          await this.audit.record({
            action: 'PAYMENT_RECORDED',
            entityType: 'Invoice',
            entityId: it.invoiceId,
            actorType: 'SYSTEM',
            after: {
              paymentRunId: runId,
              utr: it.utr,
              net: item.net.toString(),
              isStub: false,
            },
          });
        }
        await this.prisma.client.paymentRunItem.update({
          where: { id: item.id },
          data: { bankStatus: 'CONFIRMED', bankUtr: it.utr, bankErrorMessage: null },
        });
        confirmed += 1;
      } else {
        await this.prisma.client.paymentRunItem.update({
          where: { id: item.id },
          data: { bankStatus: 'FAILED', bankErrorMessage: it.error },
        });
        failed += 1;
      }
    }

    const nextStatus = confirmed === 0 ? 'FAILED' : 'COMPLETED';
    await this.prisma.client.paymentSubmissionIntent.update({
      where: { id: intent.id },
      data: {
        status: 'CONFIRMED',
        confirmedAt: now,
        acceptedCount: confirmed,
        failedCount: failed,
      },
    });
    await this.prisma.client.paymentRun.update({
      where: { id: runId },
      data: { status: nextStatus },
    });
    await this.audit.record({
      action: 'BANK_BATCH_CONFIRMED',
      entityType: 'PaymentRun',
      entityId: runId,
      actorId,
      after: { confirmed, failed, status: nextStatus, simulated: result.simulated },
    });
    await this.events.emit(
      DOMAIN_EVENTS.PAYMENT_BANK_CONFIRMED,
      { paymentRunId: runId, confirmed, failed },
      run.tenantId,
    );
    return {
      paymentRunId: runId,
      status: nextStatus,
      confirmed,
      failed,
      simulated: result.simulated,
    };
  }

  async getReconciliation(runId: string): Promise<BankReconciliationResponse> {
    const run = await this.prisma.client.paymentRun.findUnique({
      where: { id: runId },
      include: {
        items: {
          orderBy: { orderInBatch: 'asc' },
          include: { invoice: { include: { vendor: { select: { name: true } } } } },
        },
        paymentRecords: true,
      },
    });
    if (!run) throw new NotFoundException('Payment run not found');
    const intent = await this.prisma.client.paymentSubmissionIntent.findFirst({
      where: { paymentRunId: runId },
      orderBy: { attemptNo: 'desc' },
    });
    const hasFailed = run.items.some((i) => i.bankStatus === 'FAILED');
    return {
      paymentRunId: runId,
      runNumber: run.number,
      status: run.status,
      simulated: intent?.simulated ?? true,
      attemptNo: intent?.attemptNo ?? 0,
      itemCount: intent?.itemCount ?? run.items.length,
      acceptedCount: intent?.acceptedCount ?? 0,
      failedCount: intent?.failedCount ?? 0,
      submittedAt: intent?.submittedAt?.toISOString() ?? null,
      confirmedAt: intent?.confirmedAt?.toISOString() ?? null,
      items: run.items.map((i) => ({
        invoiceId: i.invoiceId,
        invoiceNumber: i.invoice.number,
        vendorName: i.invoice.vendor.name,
        net: i.net.toString(),
        bankStatus: i.bankStatus,
        bankUtr: i.bankUtr,
        bankErrorMessage: i.bankErrorMessage,
      })),
      records: run.paymentRecords.map((r) => ({
        invoiceId: r.invoiceId,
        utr: r.utr,
        isStub: r.isStub,
        net: r.net.toString(),
      })),
      canConfirm:
        run.status === 'SUBMITTED_PENDING_BANK_CONFIRMATION' &&
        intent?.status === 'SUBMITTED',
      canRetry: hasFailed,
    };
  }

  /** Resubmit only the FAILED items after correction (fresh attempt). */
  async retryFailedItems(runId: string, actorId: string): Promise<{ retried: number }> {
    const failedCount = await this.prisma.client.paymentRunItem.count({
      where: { paymentRunId: runId, bankStatus: 'FAILED' },
    });
    if (failedCount === 0) return { retried: 0 };
    // Reset the run so a fresh submission attempt can be made for the corrected items.
    await this.prisma.client.paymentRunItem.updateMany({
      where: { paymentRunId: runId, bankStatus: 'FAILED' },
      data: { bankStatus: 'PENDING', bankErrorMessage: null },
    });
    await this.audit.record({
      action: 'BANK_RETRY_REQUESTED',
      entityType: 'PaymentRun',
      entityId: runId,
      actorId,
      after: { retried: failedCount },
    });
    return { retried: failedCount };
  }

  private loadRun(runId: string) {
    return this.prisma.client.paymentRun.findUnique({
      where: { id: runId },
      include: {
        bankAccount: true,
        items: {
          orderBy: { orderInBatch: 'asc' },
          include: { invoice: { include: { vendor: { include: { banks: true } } } } },
        },
      },
    });
  }
}
