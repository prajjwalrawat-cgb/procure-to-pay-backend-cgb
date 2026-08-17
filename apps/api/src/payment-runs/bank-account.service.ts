import { Injectable, NotFoundException } from '@nestjs/common';
import { newId } from '@procureflow/db';
import type { BankAccountInput, BankAccountView } from '@procureflow/shared';

import { AuditLogService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentRunStateError } from './payment-run.errors';

/**
 * The tenant's own disbursement accounts — the accounts a payment run debits.
 *
 * Maintained by finance (and admins) rather than seeded, since a real tenant
 * arrives with its own banking. Only the last four digits of the account number
 * are stored: the bank file is built from the format template plus the tenant
 * code, so holding the full number would put a payment credential in the
 * application database for no operational gain.
 */
@Injectable()
export class BankAccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /** Active accounts — what a payment run may debit. */
  async list(): Promise<BankAccountView[]> {
    const accounts = await this.prisma.client.bankAccount.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
    });
    return accounts.map((a) => this.toView(a));
  }

  /** Every account including retired ones, for the settings screen. */
  async listAll(): Promise<BankAccountView[]> {
    const accounts = await this.prisma.client.bankAccount.findMany({
      orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
    });
    return accounts.map((a) => this.toView(a));
  }

  async create(
    tenantId: string,
    input: BankAccountInput,
    actorId: string,
  ): Promise<BankAccountView[]> {
    const id = newId('bankAccount');
    await this.prisma.client.bankAccount.create({
      data: {
        id,
        tenantId,
        ...this.writable(input),
        isActive: input.isActive ?? true,
      },
    });
    await this.audit.record({
      action: 'bank_account.created',
      entityType: 'BankAccount',
      entityId: id,
      actorId,
      after: this.auditable(input),
    });
    return this.listAll();
  }

  async update(
    id: string,
    input: BankAccountInput,
    actorId: string,
  ): Promise<BankAccountView[]> {
    const before = await this.require(id);
    await this.prisma.client.bankAccount.update({
      where: { id },
      data: {
        ...this.writable(input),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    await this.audit.record({
      action: 'bank_account.updated',
      entityType: 'BankAccount',
      entityId: id,
      actorId,
      before: this.auditable(this.toView(before)),
      after: this.auditable(input),
    });
    return this.listAll();
  }

  /**
   * Retire an account rather than delete it — historic runs reference the row,
   * and an account with a run still in flight cannot be withdrawn from under it.
   */
  async setActive(
    id: string,
    isActive: boolean,
    actorId: string,
  ): Promise<BankAccountView[]> {
    await this.require(id);
    if (!isActive) {
      const inFlight = await this.prisma.client.paymentRun.findFirst({
        where: {
          bankAccountId: id,
          status: { in: ['DRAFT', 'AWAITING_APPROVAL', 'SUBMITTED_TO_BANK'] },
        },
        select: { number: true },
      });
      if (inFlight) {
        throw new PaymentRunStateError(
          `Payment run ${inFlight.number} is still open against this account.`,
          { bankAccountId: id, paymentRun: inFlight.number },
        );
      }
    }
    await this.prisma.client.bankAccount.update({ where: { id }, data: { isActive } });
    await this.audit.record({
      action: isActive ? 'bank_account.reactivated' : 'bank_account.retired',
      entityType: 'BankAccount',
      entityId: id,
      actorId,
      after: { isActive },
    });
    return this.listAll();
  }

  async require(
    id: string,
  ): Promise<
    Awaited<ReturnType<PrismaService['client']['bankAccount']['findUniqueOrThrow']>>
  > {
    const account = await this.prisma.client.bankAccount.findUnique({ where: { id } });
    if (!account) throw new NotFoundException('Bank account not found');
    return account;
  }

  /** Columns a caller may set. `uploadConfig` carries format-specific extras. */
  private writable(input: BankAccountInput) {
    return {
      bankName: input.bankName,
      accountNoLast4: input.accountNoLast4,
      ifsc: input.ifsc,
      holderName: input.holderName,
      formatKey: input.formatKey,
      dailyLimit: input.dailyLimit ?? null,
      uploadConfig: input.tenantCode ? { tenantCode: input.tenantCode } : undefined,
    };
  }

  /** Never log the account digits, even the last four. */
  private auditable(input: { bankName: string; ifsc: string; formatKey: string }) {
    return { bankName: input.bankName, ifsc: input.ifsc, formatKey: input.formatKey };
  }

  toView(a: {
    id: string;
    bankName: string;
    accountNoLast4: string;
    ifsc: string;
    holderName: string;
    formatKey: string;
    dailyLimit: { toString(): string } | null;
    uploadConfig?: unknown;
    isActive: boolean;
  }): BankAccountView {
    const config = (a.uploadConfig ?? {}) as { tenantCode?: string };
    return {
      id: a.id,
      bankName: a.bankName,
      accountNoLast4: a.accountNoLast4,
      ifsc: a.ifsc,
      holderName: a.holderName,
      formatKey: a.formatKey,
      dailyLimit: a.dailyLimit?.toString() ?? null,
      tenantCode: config.tenantCode ?? null,
      isActive: a.isActive,
    };
  }
}
