import Decimal from 'decimal.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditLogService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentPostingService } from './payment-posting.service';
import { PaymentRecordInvalidError } from './payment-run.errors';

const D = (v: string) => new Decimal(v);

describe('PaymentPostingService.tdsShare', () => {
  it('splits TDS in proportion to the part paid', () => {
    expect(PaymentPostingService.tdsShare('100', '10000', '5000').toString()).toBe('50');
  });

  it('gives the payment that clears the balance all the TDS left', () => {
    // 33.33 + 33.33 withheld earlier; the last third takes the 33.34 remainder.
    expect(PaymentPostingService.tdsShare('33.34', '3333.33', '3333.33').toString()).toBe(
      '33.34',
    );
  });

  it('never withholds a negative amount', () => {
    expect(PaymentPostingService.tdsShare('-5', '1000', '500').toString()).toBe('0');
  });
});

function harness(
  invoice: Record<string, unknown>,
  opts: { inRun?: unknown; openExceptions?: number; pendingApprovals?: number } = {},
) {
  const records: Record<string, unknown>[] = [];
  const row = {
    id: 'inv_1',
    tenantId: 'ten_1',
    status: 'APPROVED',
    grossAmount: D('16520'),
    paidAmount: D('0'),
    tdsAmount: D('0'),
    paymentRecords: [] as { tds: Decimal; utr: string }[],
    ...invoice,
  };
  const client = {
    invoice: {
      findUnique: vi.fn(async () => row),
      update: vi.fn(
        async ({
          data,
        }: {
          data: { status?: string; paidAmount?: { increment: Decimal.Value } };
        }) => {
          if (data.paidAmount) {
            row.paidAmount = row.paidAmount.plus(data.paidAmount.increment.toString());
          }
          if (data.status) row.status = data.status;
          return row;
        },
      ),
    },
    paymentRunItem: { findFirst: vi.fn(async () => opts.inRun ?? null) },
    invoiceException: { count: vi.fn(async () => opts.openExceptions ?? 0) },
    approval: { count: vi.fn(async () => opts.pendingApprovals ?? 0) },
    paymentRecord: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        records.push(data);
        return data;
      }),
    },
  };
  const prisma = { client } as unknown as PrismaService;
  const audit = { record: vi.fn() } as unknown as AuditLogService;
  return { service: new PaymentPostingService(prisma, audit), row, records };
}

const input = {
  amount: '8260',
  paidAt: new Date('2026-09-17T00:00:00Z').toISOString(),
  mode: 'NEFT' as const,
  reference: 'UTR123',
};

describe('PaymentPostingService.recordManual', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records half of an invoice and leaves it PARTIALLY_PAID', async () => {
    const { service, row, records } = harness({});
    const res = await service.recordManual('inv_1', input, 'usr_fin');
    expect(res.status).toBe('PARTIALLY_PAID');
    expect(row.paidAmount.toString()).toBe('8260');
    expect(records[0]).toMatchObject({
      source: 'MANUAL',
      paymentRunId: null,
      utr: 'UTR123',
      mode: 'NEFT',
      recordedById: 'usr_fin',
    });
  });

  it('marks the invoice PAID once the second half is recorded', async () => {
    const { service, row } = harness({
      status: 'PARTIALLY_PAID',
      paidAmount: D('8260'),
      paymentRecords: [{ tds: D('0'), utr: 'UTR123' }],
    });
    const res = await service.recordManual(
      'inv_1',
      { ...input, reference: 'UTR456' },
      'usr_fin',
    );
    expect(res.status).toBe('PAID');
    expect(row.paidAmount.toString()).toBe('16520');
  });

  it('withholds the proportional TDS when none is given', async () => {
    const { service, records } = harness({ tdsAmount: D('20') });
    await service.recordManual('inv_1', input, 'usr_fin');
    expect(records[0]!.tds!.toString()).toBe('10');
    expect(records[0]!.net!.toString()).toBe('8250');
  });

  it('refuses more than is outstanding', async () => {
    const { service } = harness({ paidAmount: D('10000'), status: 'PARTIALLY_PAID' });
    await expect(service.recordManual('inv_1', input, 'usr_fin')).rejects.toBeInstanceOf(
      PaymentRecordInvalidError,
    );
  });

  it('refuses while a payment run still holds the invoice', async () => {
    const { service } = harness(
      {},
      { inRun: { paymentRunId: 'pay_1', paymentRun: { number: 'PR-1', status: 'DRAFT' } } },
    );
    await expect(service.recordManual('inv_1', input, 'usr_fin')).rejects.toThrow(
      /draft payment run PR-1/,
    );
  });

  it('refuses an invoice that is not approved', async () => {
    const { service } = harness({ status: 'AWAITING_APPROVAL' });
    await expect(service.recordManual('inv_1', input, 'usr_fin')).rejects.toBeInstanceOf(
      PaymentRecordInvalidError,
    );
  });

  it('refuses an invoice with an open exception, even if marked APPROVED', async () => {
    const { service } = harness({}, { openExceptions: 1 });
    await expect(service.recordManual('inv_1', input, 'usr_fin')).rejects.toThrow(
      /open exceptions/,
    );
  });

  it('refuses an invoice with an approval still pending', async () => {
    const { service } = harness({}, { pendingApprovals: 1 });
    await expect(service.recordManual('inv_1', input, 'usr_fin')).rejects.toThrow(
      /waiting for approval/,
    );
  });

  it('refuses the same reference twice on one invoice', async () => {
    const { service } = harness({
      status: 'PARTIALLY_PAID',
      paidAmount: D('100'),
      paymentRecords: [{ tds: D('0'), utr: 'UTR123' }],
    });
    await expect(service.recordManual('inv_1', input, 'usr_fin')).rejects.toThrow(
      /already recorded/,
    );
  });
});
