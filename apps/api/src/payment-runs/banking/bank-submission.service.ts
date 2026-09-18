import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { newId } from '@procureflow/db';
import { DOMAIN_EVENTS } from '@procureflow/shared';

import { AuditLogService } from '../../audit/audit.service';
import { DomainEventService } from '../../common/events/domain-event.service';
import { StorageService } from '../../common/storage/storage.service';
import { PrismaService } from '../../prisma/prisma.service';
import { BankFileService } from '../bank-file.service';
import { PAYABLE_STATUSES } from '../payment-posting.service';
import { PaymentRunSubmissionBlockedError } from '../payment-run.errors';
import { BANK_GATEWAY, type BankPayee, type IBankGateway } from './bank-gateway';

type RunWithItems = NonNullable<Awaited<ReturnType<BankSubmissionService['loadRun']>>>;

/**
 * BankSubmissionService (Slice 10b, ADR-034). Replaces Slice 3's stub-UTR
 * generation with a real (simulator-backed) bank submission that is **idempotent
 * and crash-recoverable**:
 *   1. Guard against double-submission — an already-SUBMITTED/CONFIRMED run is an
 *      idempotent no-op.
 *   2. Write a PaymentSubmissionIntent BEFORE the bank call — a crash mid-call is
 *      recoverable/auditable, never a silent double-pay.
 *   3. Submit with an Idempotency-Key (`runId:attemptNo`); handle partial-batch
 *      failures per item; move the run to SUBMITTED_PENDING_BANK_CONFIRMATION.
 * Payment records + invoice→PAID are deferred to UtrReconciliationService on bank
 * confirmation — so nothing is marked paid until the bank confirms.
 */
@Injectable()
export class BankSubmissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly events: DomainEventService,
    private readonly bankFile: BankFileService,
    private readonly storage: StorageService,
    @Inject(BANK_GATEWAY) private readonly gateway: IBankGateway,
  ) {}

  async submitRun(runId: string, actorId: string): Promise<void> {
    const run = await this.loadRun(runId);
    if (!run) throw new NotFoundException('Payment run not found');

    // Block submission if any item became invalid after approval (Slice 3 guard).
    const invalid = run.items.filter(
      (it) =>
        !(PAYABLE_STATUSES as readonly string[]).includes(it.invoice.status) ||
        !it.invoice.vendor.banks.some((b) => b.isVerified),
    );
    if (invalid.length > 0) {
      throw new PaymentRunSubmissionBlockedError(
        'Some invoices are no longer valid for payment.',
        { invoices: invalid.map((it) => it.invoice.number) },
      );
    }

    // Regenerate the file + re-hash against the approved preview (tamper guard).
    const file = await this.bankFile.build(runId);
    if (run.previewHash && run.previewHash !== file.checksum) {
      throw new PaymentRunSubmissionBlockedError(
        'The bank file changed after approval. Re-approval is required.',
        { previewHash: run.previewHash, current: file.checksum },
      );
    }
    const s3Key = `${run.tenantId}/payment-runs/${runId}/${file.filename}`;
    await this.storage
      .put(s3Key, Buffer.from(file.contentBytes), 'text/csv')
      .catch(() => s3Key);

    // (1) Idempotency — a run already submitted/confirmed is a no-op (no re-call).
    const done = await this.prisma.client.paymentSubmissionIntent.findFirst({
      where: { paymentRunId: runId, status: { in: ['SUBMITTED', 'CONFIRMED'] } },
    });
    if (done) {
      await this.audit.record({
        action: 'BANK_SUBMISSION_IDEMPOTENT_REPLAY',
        entityType: 'PaymentRun',
        entityId: runId,
        actorType: 'SYSTEM',
        after: { intentId: done.id, attemptNo: done.attemptNo },
      });
      return;
    }

    // A dangling INTENT means a prior attempt crashed after writing the intent but
    // before recording the bank result — the bank may or may not have received it.
    // NEVER auto-resubmit (double-pay risk): fail it for manual investigation.
    const dangling = await this.prisma.client.paymentSubmissionIntent.findFirst({
      where: { paymentRunId: runId, status: 'INTENT' },
    });
    if (dangling) {
      await this.prisma.client.paymentSubmissionIntent.update({
        where: { id: dangling.id },
        data: {
          status: 'FAILED',
          errorMessage:
            'Interrupted submission — manual investigation required before resubmit.',
        },
      });
      throw new PaymentRunSubmissionBlockedError(
        'A previous submission was interrupted; manual investigation is required before resubmitting.',
        { intentId: dangling.id },
      );
    }

    const maxAttempt = await this.prisma.client.paymentSubmissionIntent.aggregate({
      where: { paymentRunId: runId },
      _max: { attemptNo: true },
    });
    const attemptNo = (maxAttempt._max.attemptNo ?? 0) + 1;
    const idempotencyKey = `${runId}:${attemptNo}`;
    const payees = this.buildPayees(run);

    // (2) Write the intent BEFORE the bank call — the crash-recovery anchor.
    const intent = await this.prisma.client.paymentSubmissionIntent.create({
      data: {
        id: newId('paymentSubmissionIntent'),
        tenantId: run.tenantId,
        paymentRunId: runId,
        attemptNo,
        idempotencyKey,
        status: 'INTENT',
        fileHash: file.checksum,
        itemCount: run.items.length,
      },
    });

    // (3) Submit (idempotency-keyed). A hard failure leaves NO payment records —
    // the run is safely retryable; nothing was marked paid.
    let result;
    try {
      result = await this.gateway.submit(
        idempotencyKey,
        run.bankAccount?.formatKey ?? 'NEFT_BULK',
        payees,
      );
    } catch (err) {
      await this.prisma.client.paymentSubmissionIntent.update({
        where: { id: intent.id },
        data: { status: 'FAILED', errorMessage: String(err).slice(0, 300) },
      });
      await this.audit.record({
        action: 'BANK_SUBMISSION_FAILED',
        entityType: 'PaymentRun',
        entityId: runId,
        actorId,
        after: { attemptNo, error: String(err).slice(0, 200) },
      });
      throw new PaymentRunSubmissionBlockedError(
        'Bank submission failed; no payments were made. Retry when the bank is reachable.',
        { attemptNo },
      );
    }

    const accepted = result.items.filter((i) => i.accepted);
    const failed = result.items.filter((i) => !i.accepted);

    // Per-item outcome — partial batch failures are handled per item, not
    // all-or-nothing. Failed items surface for correction + next-run resubmission.
    for (const it of result.items) {
      const item = run.items.find((x) => x.invoiceId === it.invoiceId);
      if (!item) continue;
      await this.prisma.client.paymentRunItem.update({
        where: { id: item.id },
        data: {
          bankStatus: it.accepted ? 'SUBMITTED' : 'FAILED',
          bankErrorMessage: it.error,
          bankUtr: it.utr,
        },
      });
      if (!it.accepted) {
        await this.events.emit(
          DOMAIN_EVENTS.PAYMENT_ITEM_FAILED,
          { paymentRunId: runId, invoiceId: it.invoiceId, error: it.error },
          run.tenantId,
        );
      }
    }

    await this.prisma.client.paymentSubmissionIntent.update({
      where: { id: intent.id },
      data: {
        status: 'SUBMITTED',
        bankBatchRef: result.batchRef,
        simulated: result.simulated,
        acceptedCount: accepted.length,
        failedCount: failed.length,
        submittedAt: new Date(),
      },
    });
    await this.prisma.client.paymentRun.update({
      where: { id: runId },
      data: {
        status: 'SUBMITTED_PENDING_BANK_CONFIRMATION',
        bankFileS3Key: s3Key,
        bankFileHash: file.checksum,
        submittedAt: new Date(),
      },
    });
    await this.audit.record({
      action: 'BANK_BATCH_SUBMITTED',
      entityType: 'PaymentRun',
      entityId: runId,
      actorId,
      after: {
        batchRef: result.batchRef,
        accepted: accepted.length,
        failed: failed.length,
        simulated: result.simulated,
        attemptNo,
      },
    });
    await this.events.emit(
      DOMAIN_EVENTS.PAYMENT_BATCH_SUBMITTED,
      { paymentRunId: runId, accepted: accepted.length, failed: failed.length },
      run.tenantId,
    );
  }

  buildPayees(run: RunWithItems): BankPayee[] {
    return run.items.map((item) => {
      const banks = item.invoice.vendor.banks;
      const bank = banks.find((b) => b.isVerified) ?? banks[0];
      return {
        invoiceId: item.invoiceId,
        beneficiaryName: bank?.holderName ?? item.invoice.vendor.name,
        ifsc: bank?.ifsc ?? 'INVALID0000',
        amount: item.net.toString(),
      };
    });
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
