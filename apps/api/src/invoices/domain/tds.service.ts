import { Injectable } from '@nestjs/common';
import { Prisma } from '@procureflow/db';
import { indianFinancialYear, type TdsReportRow } from '@procureflow/shared';
import Decimal from 'decimal.js';

import { PrismaService } from '../../prisma/prisma.service';

const DEFAULT_RATE = new Decimal('0.001'); // 0.1%
const THRESHOLD = new Decimal('5000000'); // ₹50L cumulative per vendor per FY

/** One payment-run line for run-time TDS recomputation. */
export interface TdsRunLine {
  vendorId: string;
  /** Taxable base for this invoice (gross − tax). */
  base: Decimal.Value;
  /** The vendor's FYTD taxable base BEFORE this run (shared across its lines). */
  priorFytdBase: Decimal.Value;
}

/**
 * TDS 194Q (Master Context §9): 0.1% on purchase value above ₹50L cumulative to
 * the same vendor within a financial year. Only the portion of THIS invoice that
 * pushes the running total past the threshold is taxed.
 */
@Injectable()
export class TdsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Pure calculation — unit tested for the ₹50L rollover. */
  static compute(
    priorFytdBase: Decimal.Value,
    invoiceBase: Decimal.Value,
    rate: Decimal.Value = DEFAULT_RATE,
    threshold: Decimal.Value = THRESHOLD,
  ): Decimal {
    const prior = new Decimal(priorFytdBase);
    const amount = new Decimal(invoiceBase);
    const total = prior.plus(amount);
    const thr = new Decimal(threshold);
    if (total.lessThanOrEqualTo(thr)) return new Decimal(0);
    // Portion of this invoice sitting above the threshold.
    const taxable = Decimal.min(amount, total.minus(thr));
    return taxable.times(rate);
  }

  /** Running FYTD taxable base (gross − tax) for a vendor, excluding one invoice. */
  async priorFytdBase(
    vendorId: string,
    at: Date,
    excludeInvoiceId?: string,
  ): Promise<Decimal> {
    const fy = indianFinancialYear(at);
    const fyStart = fyStartDate(fy);
    const rows = await this.prisma.client.invoice.findMany({
      where: {
        vendorId,
        invoiceDate: { gte: fyStart },
        ...(excludeInvoiceId ? { id: { not: excludeInvoiceId } } : {}),
      },
      select: { grossAmount: true, taxAmount: true },
    });
    return rows.reduce(
      (acc, r) =>
        acc.plus(new Decimal(r.grossAmount.toString())).minus(r.taxAmount.toString()),
      new Decimal(0),
    );
  }

  /** TDS amount for an invoice given its taxable base and prior FYTD. */
  async computeFor(
    vendorId: string,
    invoiceBase: Decimal,
    at: Date,
    rate: Decimal,
  ): Promise<Prisma.Decimal> {
    const prior = await this.priorFytdBase(vendorId, at);
    const tds = TdsService.compute(prior, invoiceBase, rate);
    return new Prisma.Decimal(tds.toFixed(4));
  }

  /**
   * Recompute per-line TDS at the moment of payment-run composition — this is
   * when withholding is actually effected (Slice 3). Lines are processed in
   * order; each vendor's running total carries the ₹50L threshold across the run,
   * so a vendor that crosses ₹50L *mid-run* is withheld correctly. Pure so it can
   * be unit-tested for the cumulative rollover.
   */
  static applyToRun(
    lines: TdsRunLine[],
    rate: Decimal.Value = DEFAULT_RATE,
    threshold: Decimal.Value = THRESHOLD,
  ): Decimal[] {
    const running = new Map<string, Decimal>();
    return lines.map((line) => {
      const base = new Decimal(line.base);
      const prior = running.get(line.vendorId) ?? new Decimal(line.priorFytdBase);
      const tds = TdsService.compute(prior, base, rate, threshold);
      running.set(line.vendorId, prior.plus(base));
      return tds;
    });
  }

  /** Per-vendor TDS captured in a run — the Form 26Q filing rows. */
  async generateTdsReport(runId: string): Promise<TdsReportRow[]> {
    const items = await this.prisma.client.paymentRunItem.findMany({
      where: { paymentRunId: runId },
      include: { invoice: { include: { vendor: true } } },
      orderBy: { orderInBatch: 'asc' },
    });
    const byVendor = new Map<string, TdsReportRow>();
    for (const it of items) {
      const v = it.invoice.vendor;
      const row = byVendor.get(v.id) ?? {
        vendorName: v.name,
        gstin: v.gstin,
        gross: '0',
        tds: '0',
        net: '0',
      };
      row.gross = new Decimal(row.gross).plus(it.gross.toString()).toFixed(4);
      row.tds = new Decimal(row.tds).plus(it.tds.toString()).toFixed(4);
      row.net = new Decimal(row.net).plus(it.net.toString()).toFixed(4);
      byVendor.set(v.id, row);
    }
    return [...byVendor.values()];
  }
}

/** 1 April of the FY labelled "FY2026-27". */
function fyStartDate(fyLabel: string): Date {
  const startYear = Number(fyLabel.slice(2, 6));
  return new Date(Date.UTC(startYear, 3, 1)); // April = month 3
}
