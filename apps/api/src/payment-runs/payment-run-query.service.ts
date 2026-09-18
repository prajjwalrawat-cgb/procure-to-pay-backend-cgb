import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  BankFilePreview,
  PaymentRunDetailResponse,
  PaymentRunItemView,
  PaymentRunKpis,
  PaymentRunListItem,
  PaymentRunListResponse,
  PaymentRunTabCounts,
} from '@procureflow/shared';
import Decimal from 'decimal.js';

import { ApprovalRoutingService } from '../approvals/approval-routing.service';
import { MsmeService } from '../invoices/domain/msme.service';
import { PrismaService } from '../prisma/prisma.service';
import { BankAccountService } from './bank-account.service';
import { BankFileService } from './bank-file.service';
import { PaymentRunMsmeService } from './payment-run-msme.service';

const TAB_STATUS: Record<string, string | null> = {
  draft: 'DRAFT',
  awaiting: 'AWAITING_APPROVAL',
  submitted: 'SUBMITTED_TO_BANK',
  completed: 'COMPLETED',
  failed: 'FAILED',
  all: null,
};

@Injectable()
export class PaymentRunQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly routing: ApprovalRoutingService,
    private readonly bankFile: BankFileService,
    private readonly bankAccounts: BankAccountService,
    private readonly msme: MsmeService,
    private readonly msmeAudit: PaymentRunMsmeService,
  ) {}

  async list(query: {
    limit: number;
    cursor?: string | null;
    tab: string;
  }): Promise<PaymentRunListResponse> {
    const status = TAB_STATUS[query.tab] ?? null;
    const where = status ? { status: status as never } : {};
    const runs = await this.prisma.client.paymentRun.findMany({
      where,
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ composedAt: 'desc' }, { id: 'desc' }],
      include: { bankAccount: true, _count: { select: { items: true } } },
    });
    const hasMore = runs.length > query.limit;
    const page = hasMore ? runs.slice(0, query.limit) : runs;

    const composerIds = [...new Set(page.map((r) => r.composedBy))];
    const composers = await this.prisma.client.user.findMany({
      where: { id: { in: composerIds } },
      select: { id: true, name: true },
    });
    const nameById = new Map(composers.map((u) => [u.id, u.name]));

    return {
      items: page.map((r): PaymentRunListItem => ({
        id: r.id,
        number: r.number,
        name: r.name,
        cycleDate: r.cycleDate.toISOString(),
        status: r.status,
        itemCount: r._count.items,
        gross: r.grossAmount.toString(),
        net: r.netAmount.toString(),
        currency: r.currency,
        bankName: r.bankAccount?.bankName ?? r.bankAccountRef ?? null,
        composedByName: nameById.get(r.composedBy) ?? null,
      })),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      totalEstimate: await this.prisma.client.paymentRun.count({ where }),
      counts: await this.tabCounts(),
    };
  }

  async tabCounts(): Promise<PaymentRunTabCounts> {
    const c = this.prisma.client.paymentRun;
    const [all, draft, awaiting, submitted, completed, failed] = await Promise.all([
      c.count(),
      c.count({ where: { status: 'DRAFT' } }),
      c.count({ where: { status: 'AWAITING_APPROVAL' } }),
      c.count({ where: { status: 'SUBMITTED_TO_BANK' } }),
      c.count({ where: { status: 'COMPLETED' } }),
      c.count({ where: { status: 'FAILED' } }),
    ]);
    return { all, draft, awaiting, submitted, completed, failed };
  }

  async detail(runId: string, viewerId?: string): Promise<PaymentRunDetailResponse> {
    const run = await this.prisma.client.paymentRun.findUnique({
      where: { id: runId },
      include: {
        bankAccount: true,
        items: {
          orderBy: { orderInBatch: 'asc' },
          include: {
            invoice: {
              include: { vendor: { include: { banks: true } } },
            },
          },
        },
        paymentRecords: { select: { invoiceId: true, gross: true } },
      },
    });
    if (!run) throw new NotFoundException('Payment run not found');

    const composer = await this.prisma.client.user.findUnique({
      where: { id: run.composedBy },
      select: { name: true },
    });

    // Once the bank confirms, the invoice's paidAmount includes this run's own
    // payment; take it back out so "paid before" means before this run.
    const postedHere = new Map(
      run.paymentRecords.map((r) => [r.invoiceId, new Decimal(r.gross.toString())]),
    );
    const items: PaymentRunItemView[] = run.items.map((it) => {
      const invoiceGross = new Decimal(it.invoice.grossAmount.toString());
      const paidBefore = new Decimal(it.invoice.paidAmount.toString()).minus(
        postedHere.get(it.invoiceId) ?? 0,
      );
      const outstanding = Decimal.max(invoiceGross.minus(paidBefore), 0);
      return {
        id: it.id,
        invoiceId: it.invoiceId,
        invoiceNumber: it.invoice.number,
        vendorName: it.invoice.vendor.name,
        isMsme: it.invoice.vendor.isMsme,
        msmeDaysRemaining: this.msme.daysRemaining(it.invoice.msmeDueDate),
        gross: it.gross.toString(),
        tds: it.tds.toString(),
        net: it.net.toString(),
        invoiceGross: invoiceGross.toFixed(4),
        paidBefore: paidBefore.toFixed(4),
        outstanding: outstanding.toFixed(4),
        isPartial: new Decimal(it.gross.toString()).lessThan(outstanding),
        bankVerified: it.invoice.vendor.banks.some((b) => b.isVerified),
        orderInBatch: it.orderInBatch,
      };
    });

    const kpis: PaymentRunKpis = {
      itemCount: items.length,
      gross: run.grossAmount.toString(),
      tdsTotal: run.tdsTotal.toString(),
      net: run.netAmount.toString(),
      msmePriorityCount: items.filter((i) => i.isMsme).length,
    };

    const liveChain = await this.routing.getLiveChain('PAYMENT_RUN', runId);
    const myApproval = viewerId
      ? liveChain.find(
          (s) => s.isCurrent && s.decision === 'PENDING' && s.approverId === viewerId,
        )
      : undefined;

    const submitted = run.status === 'SUBMITTED_TO_BANK';
    let bankFilePreview: BankFilePreview | null = null;
    if (run.bankAccount && items.length > 0) {
      const file = await this.bankFile.build(runId);
      bankFilePreview = {
        filename: file.filename,
        content: file.content,
        rowCount: file.rowCount,
        checksum: file.checksum,
        watermarked: !submitted,
      };
    }

    return {
      id: run.id,
      number: run.number,
      name: run.name,
      cycleDate: run.cycleDate.toISOString(),
      status: run.status,
      currency: run.currency,
      composedByName: composer?.name ?? null,
      composedAt: run.composedAt.toISOString(),
      submittedAt: run.submittedAt?.toISOString() ?? null,
      bankAccount: run.bankAccount ? this.bankAccounts.toView(run.bankAccount) : null,
      kpis,
      items,
      bankFilePreview,
      liveApprovalChain: liveChain,
      myApprovalId: myApproval?.approvalId ?? null,
      canDecide: Boolean(myApproval),
      msmeAudit: await this.msmeAudit.runMsmeAudit(runId),
      bankFileHash: run.bankFileHash,
      isStubMode: true,
    };
  }
}
