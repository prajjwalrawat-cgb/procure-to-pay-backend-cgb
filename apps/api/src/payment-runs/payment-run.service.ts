import { Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@procureflow/db';
import type { ApprovalDecisionAction, BankFileOutput } from '@procureflow/shared';
import Decimal from 'decimal.js';

import { ApprovalRoutingService } from '../approvals/approval-routing.service';
import { AuditLogService } from '../audit/audit.service';
import { DomainEventService } from '../common/events/domain-event.service';
import { StorageService } from '../common/storage/storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { BankFileService } from './bank-file.service';
import { BankSubmissionService } from './banking/bank-submission.service';
import { UtrReconciliationService } from './banking/utr-reconciliation.service';
import { PAYABLE_STATUSES, PaymentPostingService } from './payment-posting.service';
import {
  PaymentRunStateError,
  PaymentRunSubmissionBlockedError,
} from './payment-run.errors';

/**
 * PaymentRunService — orchestrates a run from draft to bank submission (Slice 3).
 * Bank submission itself is a stub: the file is generated + uploaded and each
 * invoice is posted with a `STUB-…` UTR (`is_stub = true`). Real bank API + real
 * UTRs land in Slice 10 (ADR-008).
 */
@Injectable()
export class PaymentRunService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly events: DomainEventService,
    private readonly routing: ApprovalRoutingService,
    private readonly bankFile: BankFileService,
    private readonly storage: StorageService,
    private readonly bankSubmission: BankSubmissionService,
    private readonly reconciliation: UtrReconciliationService,
  ) {}

  /** Run the bank submission when the approval engine fully approves the run. */
  onModuleInit(): void {
    this.routing.onApproved('PAYMENT_RUN', (runId, actorId) =>
      this.onFullyApproved(runId, actorId),
    );
  }

  /** Generated file bytes for the UI preview — not persisted. */
  async previewFile(runId: string): Promise<BankFileOutput> {
    await this.requireRun(runId);
    return this.bankFile.build(runId);
  }

  /** Validate, hash the file, and hand off to the approval engine. */
  async submitForApproval(runId: string, actorId: string): Promise<void> {
    const run = await this.prisma.client.paymentRun.findUnique({
      where: { id: runId },
      include: {
        bankAccount: true,
        items: {
          include: { invoice: { include: { vendor: { include: { banks: true } } } } },
        },
      },
    });
    if (!run) throw new NotFoundException('Payment run not found');
    if (run.status !== 'DRAFT') {
      throw new PaymentRunStateError('Only a draft run can be submitted.', {
        status: run.status,
      });
    }
    if (run.items.length === 0) {
      throw new PaymentRunSubmissionBlockedError('Add at least one invoice first.');
    }
    this.assertItemsValid(run.items);
    if (!run.bankAccount) {
      throw new PaymentRunSubmissionBlockedError('Select a bank account first.');
    }
    if (run.bankAccount.dailyLimit) {
      const net = new Decimal(run.netAmount.toString());
      if (net.greaterThan(run.bankAccount.dailyLimit.toString())) {
        throw new PaymentRunSubmissionBlockedError(
          'Run total exceeds the bank account daily limit.',
          { net: net.toFixed(4), limit: run.bankAccount.dailyLimit.toString() },
        );
      }
    }

    const file = await this.bankFile.build(runId);
    await this.prisma.client.paymentRun.update({
      where: { id: runId },
      data: { previewHash: file.checksum },
    });
    await this.audit.record({
      action: 'SUBMITTED_FOR_APPROVAL',
      entityType: 'PaymentRun',
      entityId: runId,
      actorId,
      after: { itemCount: run.items.length, previewHash: file.checksum },
    });
    // Routes, snapshots the matrix, sets status AWAITING_APPROVAL, notifies.
    await this.routing.submit('PAYMENT_RUN', runId, actorId);
    await this.markInvoicesScheduled(runId, run.items, actorId);
  }

  /** Thin wrapper on the engine so the decision route mirrors invoices. */
  async decide(
    approvalId: string,
    action: ApprovalDecisionAction,
    comment: string | null,
    actorId: string,
  ): Promise<void> {
    await this.routing.decide(approvalId, action, comment, actorId);
  }

  /**
   * Fires (via the approval hook) once the run is fully approved. Regenerates the
   * file — identical bytes are required, proven by re-hashing against the preview
   * hash — uploads it, posts every invoice as PAID with a stub UTR, and moves the
   * run to SUBMITTED_TO_BANK.
   */
  /**
   * Slice 10b — real bank submission (was a stub-UTR generator in Slice 3). The
   * batch is submitted idempotently and moves the run to
   * SUBMITTED_PENDING_BANK_CONFIRMATION; payment records + invoice→PAID are
   * finalised only on bank confirmation (UtrReconciliationService). Delegates to
   * BankSubmissionService (ADR-034); the hook contract is unchanged.
   */
  async onFullyApproved(runId: string, actorId: string): Promise<void> {
    await this.bankSubmission.submitRun(runId, actorId);
  }

  /** Bank confirmation (poll/webhook) — finalises accepted items to PAID. */
  async confirmBank(runId: string, actorId: string) {
    return this.reconciliation.confirmRun(runId, actorId);
  }

  /** Per-item bank reconciliation status for the finance dashboard. */
  async getReconciliation(runId: string) {
    return this.reconciliation.getReconciliation(runId);
  }

  /** Cancel a run before it reaches the bank (DRAFT or AWAITING_APPROVAL only). */
  async cancelBatch(runId: string, reason: string, actorId: string): Promise<void> {
    const run = await this.requireRun(runId);
    if (run.status !== 'DRAFT' && run.status !== 'AWAITING_APPROVAL') {
      throw new PaymentRunStateError(
        'Only draft or awaiting-approval runs can be cancelled.',
        {
          status: run.status,
        },
      );
    }
    // Drop any pending approvals so the run leaves everyone's inbox.
    await this.prisma.client.approval.deleteMany({
      where: { documentType: 'PAYMENT_RUN', documentId: runId },
    });
    await this.prisma.client.paymentRun.update({
      where: { id: runId },
      data: { status: 'CANCELLED' },
    });
    await this.releaseScheduledInvoices(runId, actorId);
    await this.audit.record({
      action: 'RUN_CANCELLED',
      entityType: 'PaymentRun',
      entityId: runId,
      actorId,
      before: { status: run.status },
      after: { reason },
    });
    await this.events.emit('PaymentRunCancelled', { paymentRunId: runId, reason });
  }

  /** Slice 10b — reset FAILED items so a corrected batch can be resubmitted. */
  async retryFailedItems(runId: string): Promise<{ retried: number }> {
    await this.requireRun(runId);
    return this.reconciliation.retryFailedItems(runId, 'system');
  }

  private assertItemsValid(
    items: Prisma.PaymentRunItemGetPayload<{
      include: { invoice: { include: { vendor: { include: { banks: true } } } } };
    }>[],
  ): void {
    const invalid = items.filter(
      (it) =>
        !(PAYABLE_STATUSES as readonly string[]).includes(it.invoice.status) ||
        !it.invoice.vendor.banks.some((b) => b.isVerified) ||
        // A payment recorded since the item was added can leave less owing.
        new Decimal(it.gross.toString()).greaterThan(
          PaymentPostingService.outstanding(it.invoice),
        ),
    );
    if (invalid.length > 0) {
      throw new PaymentRunSubmissionBlockedError(
        'Some invoices are no longer valid for payment.',
        { invoices: invalid.map((it) => it.invoice.number) },
      );
    }
  }

  /**
   * Commit a submitted batch's invoices to `SCHEDULED`.
   *
   * Nothing used to write this status, so an approved invoice still read
   * `APPROVED` from the approval decision all the way to the bank UTR: it
   * appeared in no AP inbox tab, and the "Scheduled" tab was permanently empty.
   *
   * Guarded on the payable statuses rather than written blind — if the run
   * auto-approved and the bank confirmed inside `routing.submit`, those invoices
   * are already `PAID` and must not be dragged backwards. A part-paid invoice
   * is scheduled too; its paidAmount still says how much was settled before.
   */
  private async markInvoicesScheduled(
    runId: string,
    items: { invoiceId: string }[],
    actorId: string,
  ): Promise<void> {
    for (const { invoiceId } of items) {
      const { count } = await this.prisma.client.invoice.updateMany({
        where: { id: invoiceId, status: { in: ['APPROVED', 'PARTIALLY_PAID'] } },
        data: { status: 'SCHEDULED' },
      });
      if (count === 0) continue;
      await this.audit.record({
        action: 'PAYMENT_SCHEDULED',
        entityType: 'Invoice',
        entityId: invoiceId,
        actorId,
        after: { paymentRunId: runId },
      });
    }
  }

  /**
   * Cancelling a run puts its invoices back on the payable pile — as
   * PARTIALLY_PAID where an earlier payment already settled part of one.
   */
  private async releaseScheduledInvoices(runId: string, actorId: string): Promise<void> {
    const items = await this.prisma.client.paymentRunItem.findMany({
      where: { paymentRunId: runId },
      select: { invoiceId: true, invoice: { select: { paidAmount: true } } },
    });
    for (const { invoiceId, invoice } of items) {
      const partlyPaid = new Decimal(invoice.paidAmount.toString()).greaterThan(0);
      const { count } = await this.prisma.client.invoice.updateMany({
        where: { id: invoiceId, status: 'SCHEDULED' },
        data: { status: partlyPaid ? 'PARTIALLY_PAID' : 'APPROVED' },
      });
      if (count === 0) continue;
      await this.audit.record({
        action: 'PAYMENT_UNSCHEDULED',
        entityType: 'Invoice',
        entityId: invoiceId,
        actorId,
        after: { paymentRunId: runId },
      });
    }
  }

  private async requireRun(runId: string) {
    const run = await this.prisma.client.paymentRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException('Payment run not found');
    return run;
  }
}
