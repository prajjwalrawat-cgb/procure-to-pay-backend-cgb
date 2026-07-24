import { Injectable, NotFoundException } from '@nestjs/common';
import type { BankAccountView } from '@procureflow/shared';

import { PrismaService } from '../prisma/prisma.service';

/** Read side for the tenant's configured disbursement bank accounts (Slice 3). */
@Injectable()
export class BankAccountService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<BankAccountView[]> {
    const accounts = await this.prisma.client.bankAccount.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
    });
    return accounts.map((a) => this.toView(a));
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

  toView(a: {
    id: string;
    bankName: string;
    accountNoLast4: string;
    ifsc: string;
    holderName: string;
    formatKey: string;
    dailyLimit: { toString(): string } | null;
    isActive: boolean;
  }): BankAccountView {
    return {
      id: a.id,
      bankName: a.bankName,
      accountNoLast4: a.accountNoLast4,
      ifsc: a.ifsc,
      holderName: a.holderName,
      formatKey: a.formatKey,
      dailyLimit: a.dailyLimit?.toString() ?? null,
      isActive: a.isActive,
    };
  }
}
