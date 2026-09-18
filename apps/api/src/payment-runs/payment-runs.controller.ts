import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import type { Response } from 'express';
import {
  AddPaymentItemInputSchema,
  BankAccountInputSchema,
  CancelPaymentRunInputSchema,
  CreatePaymentRunInputSchema,
  PaymentRunDecisionInputSchema,
  PaymentRunListQuerySchema,
  PERMISSIONS,
  RecordManualPaymentInputSchema,
  ReorderPaymentItemsInputSchema,
  SetPaymentItemAmountInputSchema,
  SuggestInvoicesInputSchema,
  type AddPaymentItemInput,
  type BankAccountInput,
  type BankAccountView,
  type BankConfirmationResult,
  type BankReconciliationResponse,
  type CancelPaymentRunInput,
  type CreatePaymentRunInput,
  type MsmeAuditResult,
  type PaymentRunDecisionInput,
  type PaymentRunDetailResponse,
  type PaymentRunListQuery,
  type PaymentRunListResponse,
  type RecordManualPaymentInput,
  type ReorderPaymentItemsInput,
  type SetPaymentItemAmountInput,
  type SuggestInvoicesInput,
  type SuggestInvoicesResponse,
} from '@procureflow/shared';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { TdsService } from '../invoices/domain/tds.service';
import { BankAccountService } from './bank-account.service';
import { PaymentPostingService } from './payment-posting.service';
import { PaymentRunComposerService } from './payment-run-composer.service';
import { PaymentRunMsmeService } from './payment-run-msme.service';
import { PaymentRunQueryService } from './payment-run-query.service';
import { PaymentRunService } from './payment-run.service';
import { PaymentRunStateError } from './payment-run.errors';

// Payment/bank endpoints — stricter 30/min per user (Master Context §8).
@Throttle({ default: { limit: 30, ttl: 60_000 } })
@Controller()
export class PaymentRunsController {
  constructor(
    private readonly composer: PaymentRunComposerService,
    private readonly runs: PaymentRunService,
    private readonly query: PaymentRunQueryService,
    private readonly bankAccounts: BankAccountService,
    private readonly msmeAudit: PaymentRunMsmeService,
    private readonly tds: TdsService,
    private readonly posting: PaymentPostingService,
  ) {}

  /** Active accounts only — this feeds the "debit account" picker on a run. */
  @Get('bank-accounts')
  @RequirePermission(PERMISSIONS.INVOICE_READ_TENANT)
  async listBankAccounts(): Promise<{ items: BankAccountView[] }> {
    return { items: await this.bankAccounts.list() };
  }

  /**
   * Every account, retired ones included — the settings screen. Finance owns
   * these accounts, so the gate is `bank_account:*` rather than `settings:*`:
   * an AP head maintains the banking without holding admin rights over the
   * rest of the organisation's settings.
   */
  @Get('bank-accounts/all')
  @RequirePermission(PERMISSIONS.BANK_ACCOUNT_READ)
  async listAllBankAccounts(): Promise<{ items: BankAccountView[] }> {
    return { items: await this.bankAccounts.listAll() };
  }

  @Post('bank-accounts')
  @RequirePermission(PERMISSIONS.BANK_ACCOUNT_MANAGE)
  async createBankAccount(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(BankAccountInputSchema)) dto: BankAccountInput,
  ): Promise<{ items: BankAccountView[] }> {
    return { items: await this.bankAccounts.create(user.tenantId, dto, user.userId) };
  }

  @Put('bank-accounts/:id')
  @RequirePermission(PERMISSIONS.BANK_ACCOUNT_MANAGE)
  async updateBankAccount(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(BankAccountInputSchema)) dto: BankAccountInput,
  ): Promise<{ items: BankAccountView[] }> {
    return { items: await this.bankAccounts.update(id, dto, user.userId) };
  }

  /** Retire or restore. Blocked while a run is still open against it. */
  @Post('bank-accounts/:id/active')
  @RequirePermission(PERMISSIONS.BANK_ACCOUNT_MANAGE)
  async setBankAccountActive(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(z.object({ isActive: z.boolean() })))
    dto: { isActive: boolean },
  ): Promise<{ items: BankAccountView[] }> {
    return { items: await this.bankAccounts.setActive(id, dto.isActive, user.userId) };
  }

  @Get('payment-runs')
  @RequirePermission(PERMISSIONS.INVOICE_READ_TENANT)
  async list(
    @Query(new ZodValidationPipe(PaymentRunListQuerySchema)) q: PaymentRunListQuery,
  ): Promise<PaymentRunListResponse> {
    return this.query.list(q);
  }

  @Post('payment-runs')
  @RequirePermission(PERMISSIONS.PAYMENT_RUN_COMPOSE)
  async create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CreatePaymentRunInputSchema)) dto: CreatePaymentRunInput,
  ): Promise<{ id: string }> {
    const id = await this.composer.createDraft(dto, user.userId);
    return { id };
  }

  @Get('payment-runs/:id')
  @RequirePermission(PERMISSIONS.INVOICE_READ_TENANT)
  async detail(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<PaymentRunDetailResponse> {
    return this.query.detail(id, user.userId);
  }

  @Post('payment-runs/:id/suggest')
  @RequirePermission(PERMISSIONS.PAYMENT_RUN_COMPOSE)
  async suggest(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(SuggestInvoicesInputSchema)) dto: SuggestInvoicesInput,
  ): Promise<SuggestInvoicesResponse> {
    return this.composer.suggestInvoices(id, dto);
  }

  @Post('payment-runs/:id/items')
  @RequirePermission(PERMISSIONS.PAYMENT_RUN_COMPOSE)
  async addItem(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AddPaymentItemInputSchema)) dto: AddPaymentItemInput,
  ): Promise<{ ok: true }> {
    await this.composer.addInvoice(id, dto.invoiceId, user.userId);
    return { ok: true };
  }

  @Delete('payment-runs/:id/items/:invoiceId')
  @RequirePermission(PERMISSIONS.PAYMENT_RUN_COMPOSE)
  async removeItem(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('invoiceId') invoiceId: string,
  ): Promise<{ ok: true }> {
    await this.composer.removeInvoice(id, invoiceId, user.userId);
    return { ok: true };
  }

  /** Pay part of the invoice in this run; the rest stays payable. */
  @Put('payment-runs/:id/items/:invoiceId/amount')
  @RequirePermission(PERMISSIONS.PAYMENT_RUN_COMPOSE)
  async setItemAmount(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('invoiceId') invoiceId: string,
    @Body(new ZodValidationPipe(SetPaymentItemAmountInputSchema))
    dto: SetPaymentItemAmountInput,
  ): Promise<{ ok: true }> {
    await this.composer.setItemAmount(id, invoiceId, dto.amount, user.userId);
    return { ok: true };
  }

  /**
   * Record a payment made outside the app (direct transfer, cheque) against an
   * invoice — in full or in part. Lives here rather than on the invoices
   * controller because it posts through the same service bank confirmation does.
   */
  @Post('invoices/:id/payments')
  @RequirePermission(PERMISSIONS.INVOICE_PAY)
  async recordPayment(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RecordManualPaymentInputSchema))
    dto: RecordManualPaymentInput,
  ): Promise<{ status: 'PAID' | 'PARTIALLY_PAID' }> {
    return this.posting.recordManual(id, dto, user.userId);
  }

  @Post('payment-runs/:id/reorder')
  @RequirePermission(PERMISSIONS.PAYMENT_RUN_COMPOSE)
  async reorder(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ReorderPaymentItemsInputSchema))
    dto: ReorderPaymentItemsInput,
  ): Promise<{ ok: true }> {
    await this.composer.reorder(id, dto.itemIds, dto.reason ?? null, user.userId);
    return { ok: true };
  }

  @Get('payment-runs/:id/preview-file')
  @RequirePermission(PERMISSIONS.INVOICE_READ_TENANT)
  async previewFile(
    @Param('id') id: string,
  ): Promise<{ filename: string; content: string; checksum: string; rowCount: number }> {
    const file = await this.runs.previewFile(id);
    return {
      filename: file.filename,
      content: file.content,
      checksum: file.checksum,
      rowCount: file.rowCount,
    };
  }

  @Get('payment-runs/:id/msme-audit')
  @RequirePermission(PERMISSIONS.INVOICE_READ_TENANT)
  async msmeAuditResult(@Param('id') id: string): Promise<MsmeAuditResult> {
    return this.msmeAudit.runMsmeAudit(id);
  }

  @Post('payment-runs/:id/submit-for-approval')
  @RequirePermission(PERMISSIONS.PAYMENT_RUN_COMPOSE)
  async submitForApproval(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    await this.runs.submitForApproval(id, user.userId);
    return { ok: true };
  }

  @Post('payment-runs/:id/decide')
  @RequirePermission(PERMISSIONS.APPROVAL_DECIDE)
  async decide(
    @CurrentUser() user: AuthUser,
    @Param('id') _id: string,
    @Body(new ZodValidationPipe(PaymentRunDecisionInputSchema))
    dto: PaymentRunDecisionInput,
  ): Promise<{ ok: true }> {
    await this.runs.decide(
      dto.approvalId,
      dto.decision,
      dto.comment ?? null,
      user.userId,
    );
    return { ok: true };
  }

  @Post('payment-runs/:id/cancel')
  @RequirePermission(PERMISSIONS.PAYMENT_RUN_COMPOSE)
  async cancel(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CancelPaymentRunInputSchema)) dto: CancelPaymentRunInput,
  ): Promise<{ ok: true }> {
    await this.runs.cancelBatch(id, dto.reason, user.userId);
    return { ok: true };
  }

  @Post('payment-runs/:id/retry')
  @RequirePermission(PERMISSIONS.PAYMENT_RUN_COMPOSE)
  async retry(@Param('id') id: string): Promise<{ retried: number }> {
    return this.runs.retryFailedItems(id);
  }

  // ── Slice 10b — bank reconciliation ──────────────────────────────────────────

  @Get('payment-runs/:id/reconciliation')
  @RequirePermission(PERMISSIONS.INVOICE_READ_TENANT)
  async reconciliation(@Param('id') id: string): Promise<BankReconciliationResponse> {
    return this.runs.getReconciliation(id);
  }

  /** Bank confirmation poll/callback — finalises accepted items to PAID. */
  @Post('payment-runs/:id/confirm-bank')
  @RequirePermission(PERMISSIONS.PAYMENT_RUN_SUBMIT_BANK)
  async confirmBank(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<BankConfirmationResult> {
    return this.runs.confirmBank(id, user.userId);
  }

  @Get('payment-runs/:id/download')
  @RequirePermission(PERMISSIONS.INVOICE_READ_TENANT)
  async download(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const run = await this.query.detail(id);
    const submitted = [
      'SUBMITTED_TO_BANK',
      'SUBMITTED_PENDING_BANK_CONFIRMATION',
      'COMPLETED',
      'FAILED',
    ];
    if (!submitted.includes(run.status)) {
      throw new PaymentRunStateError('The final file is available after submission.', {
        status: run.status,
      });
    }
    const file = await this.runs.previewFile(id);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.send(file.content);
  }

  @Get('payment-runs/:id/tds-report')
  @RequirePermission(PERMISSIONS.INVOICE_READ_TENANT)
  async tdsReport(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const rows = await this.tds.generateTdsReport(id);
    const header = 'Vendor,GSTIN,Gross,TDS,Net';
    const body = rows
      .map((r) =>
        [csv(r.vendorName), csv(r.gstin ?? ''), r.gross, r.tds, r.net].join(','),
      )
      .join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="tds-report-${id}.csv"`);
    res.send(`${header}\n${body}\n`);
  }
}

function csv(value: string): string {
  return value.replace(/[,\r\n]+/g, ' ').trim();
}
