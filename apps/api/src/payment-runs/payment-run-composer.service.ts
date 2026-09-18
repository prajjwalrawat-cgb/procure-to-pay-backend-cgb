import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, newId } from '@procureflow/db';
import {
  indianFinancialYear,
  type CreatePaymentRunInput,
  type SuggestInvoicesInput,
  type SuggestInvoicesResponse,
  type SuggestedInvoice,
} from '@procureflow/shared';
import Decimal from 'decimal.js';

import { AuditLogService } from '../audit/audit.service';
import { DomainEventService } from '../common/events/domain-event.service';
import { MsmeService } from '../invoices/domain/msme.service';
import { TdsService, type TdsRunLine } from '../invoices/domain/tds.service';
import { PrismaService } from '../prisma/prisma.service';
import { BankAccountService } from './bank-account.service';
import {
  ACTIVE_RUN_ITEM,
  PAYABLE_STATUSES,
  PaymentPostingService,
} from './payment-posting.service';
import { PaymentItemInvalidError, PaymentRunStateError } from './payment-run.errors';

// Dedup guard: see ACTIVE_RUN_ITEM. A run holds onto its invoice in every run
// status but CANCELLED — the old allow-list of active statuses omitted
// SUBMITTED_PENDING_BANK_CONFIRMATION and let an invoice already at the bank be
// paid twice — until the bank confirms that item, after which only the unpaid
// remainder of the invoice (if any) is up for a new run.
/** MSME "approaching the cap" window for auto-inclusion, in days remaining. */
const MSME_APPROACHING_DAYS = 7;

@Injectable()
export class PaymentRunComposerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly events: DomainEventService,
    private readonly msme: MsmeService,
    private readonly bankAccounts: BankAccountService,
  ) {}

  /** Create a DRAFT run for a cycle date + bank account. */
  async createDraft(input: CreatePaymentRunInput, actorId: string): Promise<string> {
    const bankAccount = await this.bankAccounts.require(input.bankAccountId);
    const cycleDate = new Date(input.cycleDate);
    const id = newId('paymentRun');
    const number = input.name ?? (await this.nextRunNumber(cycleDate));

    await this.prisma.client.paymentRun.create({
      data: {
        id,
        tenantId: this.tenantId(),
        number,
        name: input.name ?? null,
        cycleDate,
        status: 'DRAFT',
        currency: 'INR', // single-currency per run (Slice 3 §Ambiguities)
        bankAccountId: bankAccount.id,
        bankAccountRef: bankAccount.bankName,
        composedBy: actorId,
      },
    });
    await this.audit.record({
      action: 'DRAFT_CREATED',
      entityType: 'PaymentRun',
      entityId: id,
      actorId,
      after: {
        number,
        cycleDate: cycleDate.toISOString(),
        bankAccountId: bankAccount.id,
      },
    });
    await this.events.emit('PaymentRunCreated', { paymentRunId: id });
    return id;
  }

  /** Suggested invoices for composition, MSME-approaching ones always included. */
  async suggestInvoices(
    runId: string,
    filters: SuggestInvoicesInput,
  ): Promise<SuggestInvoicesResponse> {
    await this.requireRun(runId);
    const alreadyIn = await this.invoiceIdsInActiveRuns();

    const base = await this.prisma.client.invoice.findMany({
      where: { status: { in: [...PAYABLE_STATUSES] } },
      include: { vendor: { include: { banks: true } } },
      orderBy: { invoiceDate: 'asc' },
    });
    const now = new Date();

    const matchesFilter = (inv: (typeof base)[number]): boolean => {
      if (filters.msmeOnly && !inv.vendor.isMsme) return false;
      if (filters.vendorIds?.length && !filters.vendorIds.includes(inv.vendorId)) {
        return false;
      }
      if (filters.dueWithinDays != null) {
        const remaining = this.msme.daysRemaining(inv.msmeDueDate, now);
        if (remaining == null || remaining > filters.dueWithinDays) return false;
      }
      return true;
    };

    const isApproaching = (inv: (typeof base)[number]): boolean => {
      if (!inv.vendor.isMsme) return false;
      const remaining = this.msme.daysRemaining(inv.msmeDueDate, now);
      return remaining != null && remaining <= MSME_APPROACHING_DAYS;
    };

    let autoIncluded = 0;
    const chosen = base.filter((inv) => {
      // Exclude invoices already committed to any active run (incl. this one).
      if (alreadyIn.has(inv.id)) return false;
      const passes = matchesFilter(inv);
      const approaching = isApproaching(inv);
      if (!passes && approaching) autoIncluded += 1;
      return passes || approaching;
    });

    const items: SuggestedInvoice[] = chosen
      .map((inv) => this.toSuggested(inv, now))
      .sort(sortSuggested);

    return { items, msmeAutoIncludedCount: autoIncluded };
  }

  async addInvoice(runId: string, invoiceId: string, actorId: string): Promise<void> {
    const run = await this.requireRun(runId);
    this.assertDraft(run.status);

    const invoice = await this.prisma.client.invoice.findUnique({
      where: { id: invoiceId },
      include: { vendor: { include: { banks: true } } },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    if (!(PAYABLE_STATUSES as readonly string[]).includes(invoice.status)) {
      throw new PaymentItemInvalidError('Invoice is not approved for payment.', {
        invoiceId,
        status: invoice.status,
      });
    }
    const bankVerified = invoice.vendor.banks.some((b) => b.isVerified);
    if (!bankVerified) {
      throw new PaymentItemInvalidError(
        'Vendor bank not verified — verify before adding.',
        { invoiceId, vendorId: invoice.vendorId },
      );
    }
    const dupe = await this.prisma.client.paymentRunItem.findFirst({
      where: { invoiceId, ...ACTIVE_RUN_ITEM },
    });
    if (dupe) {
      throw new PaymentItemInvalidError('Invoice is already in an active payment run.', {
        invoiceId,
      });
    }
    // A part-paid invoice joins with only what is left on it.
    const outstanding = PaymentPostingService.outstanding(invoice);
    if (outstanding.isZero()) {
      throw new PaymentItemInvalidError('Nothing is left to pay on this invoice.', {
        invoiceId,
      });
    }

    const maxOrder = await this.prisma.client.paymentRunItem.aggregate({
      where: { paymentRunId: runId },
      _max: { orderInBatch: true },
    });
    await this.prisma.client.paymentRunItem.create({
      data: {
        id: newId('paymentRunItem'),
        tenantId: this.tenantId(),
        paymentRunId: runId,
        invoiceId,
        // TDS and net are placeholders until recompute() below sets them.
        gross: new Prisma.Decimal(outstanding.toFixed(4)),
        tds: new Prisma.Decimal(0),
        net: new Prisma.Decimal(outstanding.toFixed(4)),
        orderInBatch: (maxOrder._max.orderInBatch ?? 0) + 1,
      },
    });
    await this.recompute(runId, { resort: true });
    await this.audit.record({
      action: 'INVOICE_ADDED',
      entityType: 'PaymentRun',
      entityId: runId,
      actorId,
      after: { invoiceId, number: invoice.number, amount: outstanding.toFixed(2) },
    });
  }

  /**
   * Pay part of an invoice in this run instead of its whole outstanding balance.
   * The rest stays payable: once the bank confirms this run the invoice reads
   * PARTIALLY_PAID and a later run (or a recorded payment) settles the remainder.
   */
  async setItemAmount(
    runId: string,
    invoiceId: string,
    amount: string,
    actorId: string,
  ): Promise<void> {
    const run = await this.requireRun(runId);
    this.assertDraft(run.status);
    const item = await this.prisma.client.paymentRunItem.findFirst({
      where: { paymentRunId: runId, invoiceId },
      include: {
        invoice: { select: { number: true, grossAmount: true, paidAmount: true } },
      },
    });
    if (!item) throw new NotFoundException('Invoice is not in this run');

    const outstanding = PaymentPostingService.outstanding(item.invoice);
    const next = new Decimal(amount);
    if (next.lessThanOrEqualTo(0)) {
      throw new PaymentItemInvalidError('Enter an amount greater than zero.', {
        invoiceId,
      });
    }
    if (next.greaterThan(outstanding)) {
      throw new PaymentItemInvalidError(
        `That is more than the ₹${outstanding.toFixed(2)} outstanding on ${item.invoice.number}.`,
        { invoiceId, amount: next.toFixed(2), outstanding: outstanding.toFixed(2) },
      );
    }

    await this.prisma.client.paymentRunItem.update({
      where: { id: item.id },
      data: { gross: new Prisma.Decimal(next.toFixed(4)) },
    });
    await this.recompute(runId, { resort: false });
    await this.audit.record({
      action: 'ITEM_AMOUNT_CHANGED',
      entityType: 'PaymentRun',
      entityId: runId,
      actorId,
      before: { invoiceId, amount: new Decimal(item.gross.toString()).toFixed(2) },
      after: {
        invoiceId,
        number: item.invoice.number,
        amount: next.toFixed(2),
        outstanding: outstanding.toFixed(2),
      },
    });
  }

  async removeInvoice(runId: string, invoiceId: string, actorId: string): Promise<void> {
    const run = await this.requireRun(runId);
    this.assertDraft(run.status);
    const item = await this.prisma.client.paymentRunItem.findFirst({
      where: { paymentRunId: runId, invoiceId },
    });
    if (!item) throw new NotFoundException('Invoice is not in this run');
    await this.prisma.client.paymentRunItem.delete({ where: { id: item.id } });
    await this.recompute(runId, { resort: true });
    await this.audit.record({
      action: 'INVOICE_REMOVED',
      entityType: 'PaymentRun',
      entityId: runId,
      actorId,
      after: { invoiceId },
    });
  }

  /** Manual reorder; an MSME item forced below its fold requires a reason. */
  async reorder(
    runId: string,
    itemIds: string[],
    reason: string | null,
    actorId: string,
  ): Promise<void> {
    const run = await this.requireRun(runId);
    this.assertDraft(run.status);
    const items = await this.prisma.client.paymentRunItem.findMany({
      where: { paymentRunId: runId },
      include: { invoice: { include: { vendor: { select: { isMsme: true } } } } },
    });
    if (items.length !== itemIds.length) {
      throw new PaymentRunStateError('Reorder must list every item exactly once.');
    }
    const byId = new Map(items.map((i) => [i.id, i]));
    const ordered = itemIds.map((id) => {
      const it = byId.get(id);
      if (!it) throw new PaymentRunStateError('Unknown item in reorder.');
      return it;
    });

    // MSME items must not sink below a non-MSME item without a documented reason.
    let seenNonMsme = false;
    let msmeBelowFold = false;
    for (const it of ordered) {
      if (!it.invoice.vendor.isMsme) seenNonMsme = true;
      else if (seenNonMsme) msmeBelowFold = true;
    }
    if (msmeBelowFold && !reason) {
      throw new PaymentRunStateError(
        'Moving an MSME invoice below a non-MSME invoice requires a reason.',
      );
    }

    for (let i = 0; i < ordered.length; i += 1) {
      await this.prisma.client.paymentRunItem.update({
        where: { id: ordered[i]!.id },
        data: { orderInBatch: i + 1 },
      });
    }
    await this.recompute(runId, { resort: false });
    if (msmeBelowFold) {
      await this.audit.record({
        action: 'MSME_ORDER_OVERRIDE',
        entityType: 'PaymentRun',
        entityId: runId,
        actorId,
        after: { reason },
      });
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * Recompute item TDS at composition (running ₹50L rollover) + run totals.
   *
   * TDS is worked out on the whole invoice, as before; an item paying only part
   * of it withholds its proportional share of what earlier payments have not
   * already withheld (PaymentPostingService.tdsShare).
   */
  async recompute(runId: string, opts: { resort: boolean }): Promise<void> {
    const items = await this.prisma.client.paymentRunItem.findMany({
      where: { paymentRunId: runId },
      include: {
        invoice: {
          select: {
            id: true,
            vendorId: true,
            grossAmount: true,
            taxAmount: true,
            paidAmount: true,
            invoiceDate: true,
            vendor: { select: { isMsme: true, name: true } },
          },
        },
      },
    });
    if (items.length === 0) {
      await this.prisma.client.paymentRun.update({
        where: { id: runId },
        data: { grossAmount: '0', tdsTotal: '0', netAmount: '0' },
      });
      return;
    }

    const ordered = opts.resort ? [...items].sort(sortItems) : items;
    const runInvoiceIds = ordered.map((i) => i.invoiceId);

    // Per-vendor prior FYTD base, excluding this run's invoices.
    const priorByVendor = new Map<string, Decimal>();
    for (const it of ordered) {
      if (priorByVendor.has(it.invoice.vendorId)) continue;
      priorByVendor.set(
        it.invoice.vendorId,
        await this.priorBase(it.invoice.vendorId, it.invoice.invoiceDate, runInvoiceIds),
      );
    }

    const lines: TdsRunLine[] = ordered.map((it) => ({
      vendorId: it.invoice.vendorId,
      base: new Decimal(it.invoice.grossAmount.toString()).minus(
        it.invoice.taxAmount.toString(),
      ),
      priorFytdBase: priorByVendor.get(it.invoice.vendorId) ?? new Decimal(0),
    }));
    const tds = TdsService.applyToRun(lines);

    const withheld = await this.prisma.client.paymentRecord.groupBy({
      by: ['invoiceId'],
      where: { invoiceId: { in: runInvoiceIds } },
      _sum: { tds: true },
    });
    const withheldByInvoice = new Map(
      withheld.map((w) => [w.invoiceId, new Decimal(w._sum.tds?.toString() ?? '0')]),
    );

    let gross = new Decimal(0);
    let tdsTotal = new Decimal(0);
    let net = new Decimal(0);
    for (let i = 0; i < ordered.length; i += 1) {
      const it = ordered[i]!;
      const outstanding = PaymentPostingService.outstanding(it.invoice);
      // Never pay past the balance, even if it moved since the item was added.
      const itemGross = Decimal.min(new Decimal(it.gross.toString()), outstanding);
      const invoiceTds = tds[i] ?? new Decimal(0);
      const itemTds = PaymentPostingService.tdsShare(
        invoiceTds.minus(withheldByInvoice.get(it.invoiceId) ?? 0),
        outstanding,
        itemGross,
      );
      const itemNet = itemGross.minus(itemTds);
      await this.prisma.client.paymentRunItem.update({
        where: { id: it.id },
        data: {
          gross: new Prisma.Decimal(itemGross.toFixed(4)),
          tds: new Prisma.Decimal(itemTds.toFixed(4)),
          net: new Prisma.Decimal(itemNet.toFixed(4)),
          orderInBatch: opts.resort ? i + 1 : it.orderInBatch,
        },
      });
      gross = gross.plus(itemGross);
      tdsTotal = tdsTotal.plus(itemTds);
      net = net.plus(itemNet);
    }

    await this.prisma.client.paymentRun.update({
      where: { id: runId },
      data: {
        grossAmount: new Prisma.Decimal(gross.toFixed(4)),
        tdsTotal: new Prisma.Decimal(tdsTotal.toFixed(4)),
        netAmount: new Prisma.Decimal(net.toFixed(4)),
      },
    });
  }

  private async priorBase(
    vendorId: string,
    at: Date,
    excludeIds: string[],
  ): Promise<Decimal> {
    const fy = indianFinancialYear(at);
    const startYear = Number(fy.slice(2, 6));
    const fyStart = new Date(Date.UTC(startYear, 3, 1));
    const rows = await this.prisma.client.invoice.findMany({
      where: {
        vendorId,
        invoiceDate: { gte: fyStart },
        id: { notIn: excludeIds },
      },
      select: { grossAmount: true, taxAmount: true },
    });
    return rows.reduce(
      (acc, r) =>
        acc.plus(new Decimal(r.grossAmount.toString())).minus(r.taxAmount.toString()),
      new Decimal(0),
    );
  }

  private toSuggested(
    inv: Prisma.InvoiceGetPayload<{
      include: { vendor: { include: { banks: true } } };
    }>,
    now: Date,
  ): SuggestedInvoice {
    const outstanding = PaymentPostingService.outstanding(inv);
    const remaining = this.msme.daysRemaining(inv.msmeDueDate, now);
    const approaching =
      inv.vendor.isMsme && remaining != null && remaining <= MSME_APPROACHING_DAYS;
    return {
      invoiceId: inv.id,
      number: inv.number,
      vendorInvoiceRef: inv.vendorInvoiceRef,
      vendorName: inv.vendor.name,
      isMsme: inv.vendor.isMsme,
      msmeDaysRemaining: remaining,
      msmeApproaching: approaching,
      gross: inv.grossAmount.toString(),
      tds: inv.tdsAmount.toString(),
      net: inv.netAmount.toString(),
      paidAmount: inv.paidAmount.toString(),
      outstanding: outstanding.toFixed(4),
      agingDays: Math.max(
        0,
        Math.floor((now.getTime() - inv.receivedAt.getTime()) / (24 * 60 * 60 * 1000)),
      ),
      bankVerified: inv.vendor.banks.some((b) => b.isVerified),
      autoIncluded: approaching,
    };
  }

  private async invoiceIdsInActiveRuns(): Promise<Set<string>> {
    const items = await this.prisma.client.paymentRunItem.findMany({
      where: ACTIVE_RUN_ITEM,
      select: { invoiceId: true },
    });
    return new Set(items.map((i) => i.invoiceId));
  }

  private async nextRunNumber(cycleDate: Date): Promise<string> {
    const yy = String(cycleDate.getUTCFullYear()).slice(2);
    const mm = String(cycleDate.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(cycleDate.getUTCDate()).padStart(2, '0');
    const prefix = `PR-${yy}${mm}${dd}`;
    const sameDay = await this.prisma.client.paymentRun.count({
      where: { number: { startsWith: prefix } },
    });
    return `${prefix}-${String(sameDay + 1).padStart(2, '0')}`;
  }

  private async requireRun(runId: string) {
    const run = await this.prisma.client.paymentRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException('Payment run not found');
    return run;
  }

  private assertDraft(status: string): void {
    if (status !== 'DRAFT') {
      throw new PaymentRunStateError('The run can only be edited while in draft.', {
        status,
      });
    }
  }

  private tenantId(): string {
    const tid = this.prisma.currentTenantId;
    if (!tid) throw new Error('No tenant context');
    return tid;
  }
}

type ItemWithInvoice = Prisma.PaymentRunItemGetPayload<{
  include: {
    invoice: {
      select: {
        id: true;
        vendorId: true;
        grossAmount: true;
        taxAmount: true;
        paidAmount: true;
        invoiceDate: true;
        vendor: { select: { isMsme: true; name: true } };
      };
    };
  };
}>;

/** MSME-first, then aging desc (oldest first), then vendor name. */
function sortItems(a: ItemWithInvoice, b: ItemWithInvoice): number {
  if (a.invoice.vendor.isMsme !== b.invoice.vendor.isMsme) {
    return a.invoice.vendor.isMsme ? -1 : 1;
  }
  const dt = a.invoice.invoiceDate.getTime() - b.invoice.invoiceDate.getTime();
  if (dt !== 0) return dt;
  return a.invoice.vendor.name.localeCompare(b.invoice.vendor.name);
}

function sortSuggested(a: SuggestedInvoice, b: SuggestedInvoice): number {
  if (a.isMsme !== b.isMsme) return a.isMsme ? -1 : 1;
  if (a.agingDays !== b.agingDays) return b.agingDays - a.agingDays;
  return a.vendorName.localeCompare(b.vendorName);
}
