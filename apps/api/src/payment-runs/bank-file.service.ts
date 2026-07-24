import { Injectable } from '@nestjs/common';
import {
  getBankFormatter,
  type BankFileInput,
  type BankFileOutput,
  type BankFilePayee,
} from '@procureflow/shared';

import { PrismaService } from '../prisma/prisma.service';
import { BankAccountService } from './bank-account.service';
import { PaymentRunSubmissionBlockedError } from './payment-run.errors';

/**
 * Builds the bank file for a run by mapping (run, items, bank account) onto the
 * pure `@procureflow/shared` formatter for the account's format. The mapping is
 * deterministic, so a preview and a later regeneration produce identical bytes
 * (ADR-007) — the hash proves nothing changed between approval and submission.
 */
@Injectable()
export class BankFileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bankAccounts: BankAccountService,
  ) {}

  async build(runId: string): Promise<BankFileOutput> {
    const run = await this.prisma.client.paymentRun.findUniqueOrThrow({
      where: { id: runId },
      include: {
        bankAccount: true,
        items: {
          orderBy: { orderInBatch: 'asc' },
          include: { invoice: { include: { vendor: { include: { banks: true } } } } },
        },
      },
    });
    if (!run.bankAccount) {
      throw new PaymentRunSubmissionBlockedError('Payment run has no bank account.');
    }
    const tenant = await this.prisma.client.tenant.findUniqueOrThrow({
      where: { id: run.tenantId },
    });

    const payees: BankFilePayee[] = run.items.map((item) => {
      const vendor = item.invoice.vendor;
      // Primary (or first) verified bank; the composer already blocked unverified.
      const bank = vendor.banks.find((b) => b.isVerified) ?? vendor.banks[0] ?? null;
      return {
        beneficiaryName: vendor.name,
        // Demo: the stored account value is used directly (prod decrypts here).
        beneficiaryAccount: bank?.accountNoEncrypted ?? 'NA',
        ifsc: bank?.ifsc ?? 'NA',
        amount: item.net.toString(),
        ref: item.invoice.number,
        narration: `${run.number} ${vendor.name}`,
      };
    });

    const uploadConfig = (run.bankAccount.uploadConfig ?? {}) as { tenantCode?: string };
    const input: BankFileInput = {
      meta: {
        runNumber: run.number,
        cycleDate: run.cycleDate.toISOString(),
        tenantCode: uploadConfig.tenantCode ?? tenantCode(tenant.name),
        debitAccountLast4: run.bankAccount.accountNoLast4,
        debitIfsc: run.bankAccount.ifsc,
        holderName: run.bankAccount.holderName,
      },
      payees,
    };

    return getBankFormatter(run.bankAccount.formatKey).format(input);
  }
}

/** Short onboarding code derived from the tenant name (fallback only). */
function tenantCode(name: string): string {
  return (
    name
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 6)
      .toUpperCase() || 'TENANT'
  );
}
