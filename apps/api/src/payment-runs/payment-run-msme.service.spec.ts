import { describe, expect, it } from 'vitest';

import { MsmeService } from '../invoices/domain/msme.service';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentRunMsmeService } from './payment-run-msme.service';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-06-14T00:00:00.000Z');

function inv(id: string, ageDays: number, status: string) {
  const invoiceDate = new Date(NOW.getTime() - ageDays * DAY);
  return {
    id,
    number: id.toUpperCase(),
    status,
    invoiceDate,
    msmeDueDate: new Date(invoiceDate.getTime() + 45 * DAY),
    vendor: { name: `Vendor ${id}` },
  };
}

function service(candidates: unknown[], inRunIds: string[]): PaymentRunMsmeService {
  const prisma = {
    client: {
      invoice: { findMany: async () => candidates },
      paymentRunItem: {
        findMany: async () => inRunIds.map((invoiceId) => ({ invoiceId })),
      },
    },
  } as unknown as PrismaService;
  return new PaymentRunMsmeService(prisma, new MsmeService());
}

describe('PaymentRunMsmeService.runMsmeAudit', () => {
  it('flags MSME invoices at day 40+ that are not in the run and undocumented', async () => {
    const svc = service(
      [
        inv('a', 42, 'APPROVED'), // at risk (not in run)
        inv('b', 41, 'APPROVED'), // in run → safe
        inv('c', 20, 'APPROVED'), // too young → not checked
      ],
      ['b'],
    );
    const result = await svc.runMsmeAudit('pay_1', NOW);
    expect(result.checkedCount).toBe(2); // a and b (c is under 40 days)
    expect(result.atRisk.map((r) => r.invoiceId)).toEqual(['a']);
  });

  it('does not flag HELD invoices (documented exclusion)', async () => {
    const svc = service([inv('h', 44, 'HELD')], []);
    const result = await svc.runMsmeAudit('pay_1', NOW);
    expect(result.atRisk).toHaveLength(0);
    expect(result.checkedCount).toBe(1);
  });

  it('returns an empty at-risk list when every candidate is in the run', async () => {
    const svc = service(
      [inv('a', 43, 'APPROVED'), inv('b', 41, 'SCHEDULED')],
      ['a', 'b'],
    );
    const result = await svc.runMsmeAudit('pay_1', NOW);
    expect(result.atRisk).toHaveLength(0);
  });
});
