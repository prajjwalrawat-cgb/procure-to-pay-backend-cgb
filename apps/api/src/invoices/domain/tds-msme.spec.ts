import Decimal from 'decimal.js';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../prisma/prisma.service';
import { MsmeService } from './msme.service';
import { TdsService } from './tds.service';

describe('TdsService.compute — 194Q ₹50L threshold', () => {
  it('is zero below the ₹50L cumulative threshold', () => {
    expect(TdsService.compute('4000000', '500000').toNumber()).toBe(0);
  });

  it('taxes only the portion above ₹50L on rollover', () => {
    // prior 49L + 2L = 51L → only 1L is above the 50L threshold → 0.1% = ₹100.
    expect(TdsService.compute('4900000', '200000').toString()).toBe('100');
  });

  it('taxes the full invoice once already past ₹50L', () => {
    expect(TdsService.compute('6000000', '100000').toString()).toBe('100');
  });

  it('computes TDS for a large-FYTD Patel invoice (base 183800)', () => {
    // Patel FYTD ₹1.52 Cr already exceeds ₹50L → whole base taxed at 0.1%.
    expect(TdsService.compute('15200000', '183800').toString()).toBe('183.8');
  });

  it('aggregates prior FYTD base and computes TDS for a vendor (DB-backed)', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { grossAmount: '4956000', taxAmount: '756000' }, // base 4,200,000
      { grossAmount: '826000', taxAmount: '126000' }, // base 700,000 → prior 4,900,000
    ]);
    const prisma = { client: { invoice: { findMany } } } as unknown as PrismaService;
    const svc = new TdsService(prisma);

    const prior = await svc.priorFytdBase('ven_1', new Date(Date.UTC(2026, 6, 9)));
    expect(prior.toString()).toBe('4900000');

    // prior 4.9M + this 200k = 5.1M → 100k above threshold → 0.1% = ₹100.
    const tds = await svc.computeFor(
      'ven_1',
      new Decimal('200000'),
      new Date(Date.UTC(2026, 6, 9)),
      new Decimal('0.001'),
    );
    expect(tds.toString()).toBe('100');
  });
});

describe('MsmeService', () => {
  const cap = 45;

  it('computes due date as invoice date + cap days', () => {
    const invoiceDate = new Date(Date.UTC(2026, 4, 29)); // 29 May 2026
    const due = MsmeService.computeDueDate(invoiceDate, cap);
    expect(due.toISOString().slice(0, 10)).toBe('2026-07-13');
  });

  it('INV-4471 on day 41 → APPROACHING with 4 days remaining', () => {
    const invoiceDate = new Date(Date.UTC(2026, 4, 29)); // 29 May
    const due = MsmeService.computeDueDate(invoiceDate, cap); // 13 Jul
    const now = new Date(Date.UTC(2026, 6, 9)); // 9 Jul = day 41
    expect(MsmeService.daysRemaining(due, now)).toBe(4);
    expect(MsmeService.agingBucket(due, now)).toBe('APPROACHING');
  });

  it('flags a past-due MSME invoice as BREACH', () => {
    const due = new Date(Date.UTC(2026, 6, 1));
    const now = new Date(Date.UTC(2026, 6, 9));
    expect(MsmeService.agingBucket(due, now)).toBe('BREACH');
  });

  it('flags a far-off due date as SAFE', () => {
    const due = new Date(Date.UTC(2026, 8, 1));
    const now = new Date(Date.UTC(2026, 6, 9));
    expect(MsmeService.agingBucket(due, now)).toBe('SAFE');
  });

  it('instance methods delegate for MSME vendors', () => {
    const svc = new MsmeService();
    const invoiceDate = new Date(Date.UTC(2026, 4, 29));
    const due = svc.computeDueDate(invoiceDate, cap);
    const now = new Date(Date.UTC(2026, 6, 9));
    expect(due.toISOString().slice(0, 10)).toBe('2026-07-13');
    expect(svc.daysRemaining(due, now)).toBe(4);
    expect(svc.agingBucket(due, true, now)).toBe('APPROACHING');
  });

  it('returns null aging/days for non-MSME or missing due date', () => {
    const svc = new MsmeService();
    expect(svc.agingBucket(new Date(), false)).toBeNull();
    expect(svc.agingBucket(null, true)).toBeNull();
    expect(svc.daysRemaining(null)).toBeNull();
  });
});
