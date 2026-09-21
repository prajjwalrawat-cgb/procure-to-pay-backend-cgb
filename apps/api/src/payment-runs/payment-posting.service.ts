import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, newId } from '@procureflow/db';
import type { RecordManualPaymentInput } from '@procureflow/shared';
import Decimal from 'decimal.js';

import { AuditLogService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentRecordInvalidError } from './payment-run.errors';

/** Statuses an invoice can be paid from — by a run or by hand. */
export const PAYABLE_STATUSES = ['APPROVED', 'SCHEDULED', 'PARTIALLY_PAID'] as const;

/**
 * A run item still commits its invoice until the bank confirms it: a run in any
 * status but CANCELLED, whose item has not been CONFIRMED. Once confirmed, the
 * payment is posted and the invoice's paidAmount already accounts for it, so the
 * rest of the invoice is free to be paid again.
 */
export const ACTIVE_RUN_ITEM: Prisma.PaymentRunItemWhereInput = {
  paymentRun: { status: { not: 'CANCELLED' } },
  bankStatus: { not: 'CONFIRMED' },
};

/**
 * Why the balance of an invoice cannot be paid yet, or null when it can.
 *
 * A proforma is not a tax invoice: it carries no GST the buyer can claim and
 * books no liability. Suppliers who need an advance send one, and the advance
 * is paid against it — but once that has gone out, paying the rest before the
 * real invoice arrives is how the tax invoice never gets collected. So only the
 * first payment is allowed on a proforma; everything after waits for the tax
 * invoice to replace it on the same record.
 */
export function proformaPaymentBlock(inv: {
  documentKind: string;
  paidAmount: { toString(): string };
}): string | null {
  if (inv.documentKind !== 'PROFORMA') return null;
  if (new Decimal(inv.paidAmount.toString()).lessThanOrEqualTo(0)) return null;
  return (
    'The advance against this proforma has been paid. Upload the tax invoice ' +
    'before paying the balance.'
  );
}

export interface PostPaymentInput {
  tenantId: string;
  invoiceId: string;
  source: 'PAYMENT_RUN' | 'MANUAL';
  paymentRunId: string | null;
  gross: Decimal.Value;
  tds: Decimal.Value;
  utr: string;
  isStub: boolean;
  paidAt: Date;
  mode?: string | null;
  note?: string | null;
  recordedById?: string | null;
}

/**
 * PaymentPostingService — the one place a payment lands on an invoice.
 *
 * A payment record settles `gross` of the invoice. Posting one advances the
 * invoice's paidAmount by that much and sets its status from the result:
 * PAID once the records cover grossAmount, PARTIALLY_PAID before that. Bank
 * confirmation of a run and a payment finance records by hand both come through
 * here, so the two can be mixed on one invoice without either losing track of
 * the other.
 */
@Injectable()
export class PaymentPostingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /** What is left to settle, before TDS. Never negative. */
  static outstanding(inv: {
    grossAmount: Decimal.Value | { toString(): string };
    paidAmount: Decimal.Value | { toString(): string };
  }): Decimal {
    const left = new Decimal(inv.grossAmount.toString()).minus(inv.paidAmount.toString());
    return Decimal.max(left, 0);
  }

  /**
   * The TDS that belongs to one payment of `amount` against `outstanding`.
   *
   * `remainingTds` is the invoice's TDS not yet withheld by earlier payments. A
   * payment clearing the balance takes all of it, so rounding across several
   * part-payments can never leave a paisa behind or withhold one too many; a
   * smaller one takes its proportional share.
   */
  static tdsShare(
    remainingTds: Decimal.Value,
    outstanding: Decimal.Value,
    amount: Decimal.Value,
  ): Decimal {
    const remaining = Decimal.max(new Decimal(remainingTds), 0);
    const out = new Decimal(outstanding);
    const amt = new Decimal(amount);
    if (out.lessThanOrEqualTo(0) || amt.greaterThanOrEqualTo(out)) return remaining;
    return remaining.times(amt).dividedBy(out).toDecimalPlaces(2);
  }

  async post(input: PostPaymentInput): Promise<{ status: 'PAID' | 'PARTIALLY_PAID' }> {
    const gross = new Decimal(input.gross);
    const tds = new Decimal(input.tds);
    const record = await this.prisma.client.paymentRecord.create({
      data: {
        id: newId('paymentRecord'),
        tenantId: input.tenantId,
        invoiceId: input.invoiceId,
        paymentRunId: input.paymentRunId,
        source: input.source,
        gross: new Prisma.Decimal(gross.toFixed(4)),
        tds: new Prisma.Decimal(tds.toFixed(4)),
        net: new Prisma.Decimal(gross.minus(tds).toFixed(4)),
        utr: input.utr,
        isStub: input.isStub,
        mode: input.mode ?? null,
        note: input.note ?? null,
        recordedById: input.recordedById ?? null,
        paidAt: input.paidAt,
      },
    });

    const invoice = await this.prisma.client.invoice.update({
      where: { id: input.invoiceId },
      data: { paidAmount: { increment: new Prisma.Decimal(gross.toFixed(4)) } },
      select: { grossAmount: true, paidAmount: true, status: true },
    });
    const settled = PaymentPostingService.outstanding(invoice).isZero();
    const status = settled ? 'PAID' : 'PARTIALLY_PAID';
    await this.prisma.client.invoice.update({
      where: { id: input.invoiceId },
      data: { status, ...(settled ? { paidAt: input.paidAt } : {}) },
    });

    await this.audit.record({
      action: 'PAYMENT_RECORDED',
      entityType: 'Invoice',
      entityId: input.invoiceId,
      ...(input.recordedById
        ? { actorId: input.recordedById }
        : { actorType: 'SYSTEM' as const }),
      before: { status: invoice.status },
      after: {
        paymentRecordId: record.id,
        source: input.source,
        paymentRunId: input.paymentRunId,
        utr: input.utr,
        gross: gross.toFixed(2),
        net: gross.minus(tds).toFixed(2),
        paidAmount: invoice.paidAmount.toString(),
        status,
        isStub: input.isStub,
      },
    });
    return { status };
  }

  /**
   * Record a payment finance made outside the app — a direct transfer or a
   * cheque — so the invoice shows it and the next run pays only the rest.
   */
  async recordManual(
    invoiceId: string,
    input: RecordManualPaymentInput,
    actorId: string,
  ): Promise<{ status: 'PAID' | 'PARTIALLY_PAID' }> {
    const invoice = await this.prisma.client.invoice.findUnique({
      where: { id: invoiceId },
      include: { paymentRecords: { select: { tds: true, utr: true } } },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');

    if (invoice.status !== 'APPROVED' && invoice.status !== 'PARTIALLY_PAID') {
      throw new PaymentRecordInvalidError(
        invoice.status === 'PAID'
          ? 'This invoice is already paid in full.'
          : 'Only an approved invoice can have a payment recorded against it.',
        { invoiceId, status: invoice.status },
      );
    }
    const blocked = proformaPaymentBlock(invoice);
    if (blocked) {
      throw new PaymentRecordInvalidError(blocked, { invoiceId });
    }
    // The status alone is not proof the invoice cleared review: money only goes
    // out once nothing is left open against it and nobody is still to decide.
    const [openExceptions, pendingApprovals] = await Promise.all([
      this.prisma.client.invoiceException.count({
        where: { invoiceId, resolvedAt: null, supersededAt: null },
      }),
      this.prisma.client.approval.count({
        where: { documentType: 'INVOICE', documentId: invoiceId, decision: 'PENDING' },
      }),
    ]);
    if (openExceptions > 0) {
      throw new PaymentRecordInvalidError(
        'Resolve the open exceptions on this invoice before recording a payment.',
        { invoiceId, openExceptions },
      );
    }
    if (pendingApprovals > 0) {
      throw new PaymentRecordInvalidError(
        'This invoice is still waiting for approval.',
        { invoiceId, pendingApprovals },
      );
    }
    // A run already holding the invoice will pay the amount it was composed
    // with; recording a payment beside it would pay that part twice.
    const inRun = await this.prisma.client.paymentRunItem.findFirst({
      where: { invoiceId, ...ACTIVE_RUN_ITEM },
      include: { paymentRun: { select: { number: true, status: true } } },
    });
    if (inRun) {
      throw new PaymentRecordInvalidError(
        inRun.paymentRun.status === 'DRAFT'
          ? `This invoice is in draft payment run ${inRun.paymentRun.number}. Remove it from that run first, or pay the part there.`
          : `This invoice is in payment run ${inRun.paymentRun.number}, which has not been confirmed by the bank yet.`,
        { invoiceId, paymentRunId: inRun.paymentRunId },
      );
    }

    const outstanding = PaymentPostingService.outstanding(invoice);
    const amount = new Decimal(input.amount);
    if (amount.lessThanOrEqualTo(0)) {
      throw new PaymentRecordInvalidError('Enter an amount greater than zero.');
    }
    if (amount.greaterThan(outstanding)) {
      throw new PaymentRecordInvalidError(
        `That is more than the ₹${outstanding.toFixed(2)} still outstanding on this invoice.`,
        { amount: amount.toFixed(2), outstanding: outstanding.toFixed(2) },
      );
    }

    const reference = input.reference.trim();
    if (invoice.paymentRecords.some((r) => r.utr === reference)) {
      throw new PaymentRecordInvalidError(
        `A payment with reference ${reference} is already recorded on this invoice.`,
        { reference },
      );
    }

    const paidAt = new Date(input.paidAt);
    if (paidAt.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
      throw new PaymentRecordInvalidError('The payment date cannot be in the future.');
    }

    const withheld = invoice.paymentRecords.reduce(
      (acc, r) => acc.plus(r.tds.toString()),
      new Decimal(0),
    );
    const tds =
      input.tds != null
        ? new Decimal(input.tds)
        : PaymentPostingService.tdsShare(
            new Decimal(invoice.tdsAmount.toString()).minus(withheld),
            outstanding,
            amount,
          );
    if (tds.greaterThan(amount)) {
      throw new PaymentRecordInvalidError('TDS cannot be more than the amount paid.');
    }

    return this.post({
      tenantId: invoice.tenantId,
      invoiceId,
      source: 'MANUAL',
      paymentRunId: null,
      gross: amount,
      tds,
      utr: reference,
      isStub: false,
      paidAt,
      mode: input.mode,
      note: input.note ?? null,
      recordedById: actorId,
    });
  }
}
