import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { PrismaService } from '../../prisma/prisma.service';
import { TdsService } from './tds.service';

/** Slice 3 — run-time TDS: cumulative ₹50L rollover + per-vendor report. */
describe('TdsService.applyToRun', () => {
  it('withholds nothing while the vendor stays under ₹50L', () => {
    const tds = TdsService.applyToRun([
      { vendorId: 'v1', base: '1000000', priorFytdBase: '0' },
      { vendorId: 'v1', base: '2000000', priorFytdBase: '0' },
    ]);
    expect(tds.map((d) => d.toString())).toEqual(['0', '0']);
  });

  it('withholds only on the portion above ₹50L when crossing mid-run', () => {
    // Prior 49L; two 6L lines. Line 1 total 55L → taxable 5L → 500. Wait: prior 49L
    // + 6L = 55L, over 50L by 5L → 5L * 0.001 = 5000... check exact below.
    const tds = TdsService.applyToRun([
      { vendorId: 'v1', base: '600000', priorFytdBase: '4900000' },
      { vendorId: 'v1', base: '600000', priorFytdBase: '4900000' },
    ]);
    // Line 1: prior 4.9M + 0.6M = 5.5M > 5M → taxable min(0.6M, 0.5M) = 0.5M → 500
    // Line 2: prior 5.5M + 0.6M = 6.1M → taxable min(0.6M, 1.1M) = 0.6M → 600
    expect(tds.map((d) => d.toString())).toEqual(['500', '600']);
  });

  it('crosses the threshold exactly on the second line', () => {
    const tds = TdsService.applyToRun([
      { vendorId: 'v1', base: '3000000', priorFytdBase: '0' },
      { vendorId: 'v1', base: '3000000', priorFytdBase: '0' },
    ]);
    // Line 1: 3M ≤ 5M → 0. Line 2: 3M+3M=6M → taxable min(3M, 1M)=1M → 1000.
    expect(tds.map((d) => d.toString())).toEqual(['0', '1000']);
  });

  it('tracks vendors independently', () => {
    const tds = TdsService.applyToRun([
      { vendorId: 'a', base: '6000000', priorFytdBase: '0' },
      { vendorId: 'b', base: '100000', priorFytdBase: '0' },
    ]);
    // a: 6M > 5M → taxable min(6M, 1M)=1M → 1000. b: 0.1M ≤ 5M → 0.
    expect(tds.map((d) => d.toString())).toEqual(['1000', '0']);
  });

  it('honours the prior FYTD base seeded from the first line of a vendor', () => {
    const [first] = TdsService.applyToRun([
      { vendorId: 'v1', base: '100000', priorFytdBase: '4990000' },
    ]);
    // 4.99M + 0.1M = 5.09M → taxable min(0.1M, 0.09M)=0.09M → 90.
    expect(first?.toString()).toBe('90');
  });
});

describe('TdsService.generateTdsReport', () => {
  it('aggregates gross/tds/net per vendor', async () => {
    const items = [
      {
        gross: new Decimal('1000000'),
        tds: new Decimal('100'),
        net: new Decimal('999900'),
        invoice: { vendor: { id: 'v1', name: 'Patel', gstin: 'G1' } },
      },
      {
        gross: new Decimal('500000'),
        tds: new Decimal('50'),
        net: new Decimal('499950'),
        invoice: { vendor: { id: 'v1', name: 'Patel', gstin: 'G1' } },
      },
      {
        gross: new Decimal('200000'),
        tds: new Decimal('0'),
        net: new Decimal('200000'),
        invoice: { vendor: { id: 'v2', name: 'Tata', gstin: 'G2' } },
      },
    ];
    const prisma = {
      client: { paymentRunItem: { findMany: async () => items } },
    } as unknown as PrismaService;

    const rows = await new TdsService(prisma).generateTdsReport('pay_1');
    expect(rows).toHaveLength(2);
    const patel = rows.find((r) => r.vendorName === 'Patel');
    expect(patel?.gross).toBe('1500000.0000');
    expect(patel?.tds).toBe('150.0000');
    expect(patel?.net).toBe('1499850.0000');
  });
});
