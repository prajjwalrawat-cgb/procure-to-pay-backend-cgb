import Decimal from 'decimal.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApprovalRoutingService } from '../approvals/approval-routing.service';
import { AuditLogService } from '../audit/audit.service';
import { CircuitBreaker } from '../common/integrations/circuit-breaker';
import { DomainEventService } from '../common/events/domain-event.service';
import { StorageService } from '../common/storage/storage.service';
import { IntegrationUsageService } from '../integrations/integration-usage.service';
import { PrismaService } from '../prisma/prisma.service';
import { BankFileService } from './bank-file.service';
import { BankSubmissionService } from './banking/bank-submission.service';
import { SandboxBankGateway } from './banking/bank-gateway';
import { UtrReconciliationService } from './banking/utr-reconciliation.service';
import { PaymentPostingService } from './payment-posting.service';
import { PaymentRunSubmissionBlockedError } from './payment-run.errors';
import { PaymentRunService } from './payment-run.service';

/**
 * End-to-end lifecycle: submitForApproval → (engine fires hook) → onFullyApproved
 * → SUBMITTED_PENDING_BANK_CONFIRMATION → confirmBank → COMPLETED with REAL UTRs
 * and invoices PAID (Slice 10b two-phase flow). Uses the real BankSubmission +
 * UtrReconciliation services with the sandbox bank gateway (not re-mocked).
 */
const FILE = {
  filename: 'HDFC_NEFT_PR.csv',
  content: 'H,STAR01\r\n',
  contentBytes: new TextEncoder().encode('H,STAR01\r\n'),
  checksum: 'abc123',
  rowCount: 2,
};

function item(id: string, status = 'APPROVED', verified = true, ifsc = 'HDFC0001234') {
  return {
    id: `payi_${id}`,
    invoiceId: `inv_${id}`,
    orderInBatch: Number(id),
    gross: new Decimal('100000'),
    tds: new Decimal('0'),
    net: new Decimal('100000'),
    bankStatus: 'PENDING',
    invoice: {
      id: `inv_${id}`,
      number: `INV-${id}`,
      status,
      grossAmount: new Decimal('100000'),
      paidAmount: new Decimal('0'),
      vendor: {
        name: 'Vendor',
        banks: [{ isVerified: verified, ifsc, holderName: 'Vendor Ltd' }],
      },
    },
  };
}

function harness(
  opts: { items?: ReturnType<typeof item>[]; buildFn?: () => unknown } = {},
) {
  const items = opts.items ?? [item('1'), item('2')];
  const run: Record<string, unknown> & { status: string; previewHash: string | null } = {
    id: 'pay_1',
    tenantId: 'ten_1',
    number: 'PR-1',
    status: 'DRAFT',
    previewHash: null,
    netAmount: new Decimal('200000'),
    bankAccount: {
      id: 'ba_1',
      bankName: 'HDFC',
      dailyLimit: null,
      formatKey: 'NEFT_BULK',
    },
    items,
  };
  const records: { utr: string; isStub: boolean }[] = [];
  const intents: Record<string, unknown>[] = [];

  const client = {
    paymentRun: {
      findUnique: vi.fn(async () => run),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return run;
      }),
    },
    paymentSubmissionIntent: {
      findFirst: vi.fn(async ({ where }: { where: { status?: unknown } }) => {
        const s = where.status;
        if (s && typeof s === 'object')
          return (
            intents.find((i) =>
              (s as { in: string[] }).in.includes(i.status as string),
            ) ?? null
          );
        if (s === 'INTENT') return intents.find((i) => i.status === 'INTENT') ?? null;
        if (s === 'SUBMITTED')
          return [...intents].reverse().find((i) => i.status === 'SUBMITTED') ?? null;
        return intents[0] ?? null;
      }),
      aggregate: vi.fn(async () => ({
        _max: {
          attemptNo: intents.reduce((m, i) => Math.max(m, i.attemptNo as number), 0),
        },
      })),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        intents.push(data);
        return data;
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const i = intents.find((x) => x.id === where.id);
          if (i) Object.assign(i, data);
          return i;
        },
      ),
    },
    paymentRunItem: {
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const it = items.find((x) => x.id === where.id);
          if (it) Object.assign(it, data);
          return it;
        },
      ),
    },
    paymentRecord: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: { utr: string; isStub: boolean } }) => {
        records.push(data);
        return data;
      }),
    },
    invoice: {
      // Posting first increments paidAmount (reading the row back), then sets
      // the status that follows from it.
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { status?: string; paidAmount?: { increment: Decimal.Value } };
        }) => {
          const it = items.find((i) => i.invoiceId === where.id);
          if (!it) return {};
          if (data.paidAmount) {
            it.invoice.paidAmount = it.invoice.paidAmount.plus(
              data.paidAmount.increment.toString(),
            );
          }
          if (data.status) it.invoice.status = data.status;
          return it.invoice;
        },
      ),
      // Status-guarded, like the real updateMany: the service relies on the
      // guard to leave an already-PAID invoice alone.
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; status: string | { in: string[] } };
          data: { status: string };
        }) => {
          const it = items.find((i) => i.invoiceId === where.id);
          const allowed =
            typeof where.status === 'string' ? [where.status] : where.status.in;
          if (!it || !allowed.includes(it.invoice.status)) return { count: 0 };
          it.invoice.status = data.status;
          return { count: 1 };
        },
      ),
    },
  };
  const prisma = { client } as unknown as PrismaService;
  const audit = { record: vi.fn() } as unknown as AuditLogService;
  const events = { emit: vi.fn() } as unknown as DomainEventService;
  const routing = {
    submit: vi.fn(async () => {
      run.status = 'AWAITING_APPROVAL';
    }),
    onApproved: vi.fn(),
    decide: vi.fn(),
  } as unknown as ApprovalRoutingService;
  const bankFile = {
    build: vi.fn(opts.buildFn ?? (async () => FILE)),
  } as unknown as BankFileService;
  const storage = { put: vi.fn().mockResolvedValue('key') } as unknown as StorageService;
  const usage = { log: vi.fn() } as unknown as IntegrationUsageService;
  const gateway = new SandboxBankGateway(new CircuitBreaker(), usage);
  const submission = new BankSubmissionService(
    prisma,
    audit,
    events,
    bankFile,
    storage,
    gateway,
  );
  const reconciliation = new UtrReconciliationService(
    prisma,
    audit,
    events,
    submission,
    new PaymentPostingService(prisma, audit),
    gateway,
  );
  const service = new PaymentRunService(
    prisma,
    audit,
    events,
    routing,
    bankFile,
    storage,
    submission,
    reconciliation,
  );
  return { service, run, records, client, routing };
}

describe('PaymentRunService — full lifecycle (submit → approve → confirm → PAID)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('submits on approval, awaits bank confirmation, then confirms to REAL UTRs + PAID', async () => {
    const { service, run, records, routing } = harness();

    await service.submitForApproval('pay_1', 'usr_iyer');
    expect(run.previewHash).toBe('abc123');
    expect(routing.submit).toHaveBeenCalledWith('PAYMENT_RUN', 'pay_1', 'usr_iyer');
    // Submitting commits the batch: the invoices leave APPROVED for SCHEDULED,
    // so the AP inbox stops showing them as still awaiting a payment run.
    expect(run.items.every((i) => i.invoice.status === 'SCHEDULED')).toBe(true);

    // Approval hook → real submission → pending bank confirmation (NOT yet paid).
    await service.onFullyApproved('pay_1', 'usr_das');
    expect(run.status).toBe('SUBMITTED_PENDING_BANK_CONFIRMATION');
    expect(run.items.every((i) => i.invoice.status !== 'PAID')).toBe(true);
    expect(records).toHaveLength(0);

    // Bank confirmation → real UTRs, isStub=false, invoices PAID, run COMPLETED.
    const res = await service.confirmBank('pay_1', 'usr_das');
    expect(res.status).toBe('COMPLETED');
    expect(run.status).toBe('COMPLETED');
    expect(run.items.every((i) => i.invoice.status === 'PAID')).toBe(true);
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.isStub === false)).toBe(true);
    expect(records.every((r) => !r.utr.startsWith('STUB'))).toBe(true);
  });

  it('leaves an invoice PARTIALLY_PAID when the run paid only part of it', async () => {
    const half = item('1');
    half.gross = new Decimal('50000');
    half.net = new Decimal('50000');
    const { service, run, records } = harness({ items: [half, item('2')] });

    await service.submitForApproval('pay_1', 'usr_iyer');
    await service.onFullyApproved('pay_1', 'usr_das');
    await service.confirmBank('pay_1', 'usr_das');

    const [first, second] = run.items;
    expect(first!.invoice.status).toBe('PARTIALLY_PAID');
    expect(first!.invoice.paidAmount.toString()).toBe('50000');
    expect(second!.invoice.status).toBe('PAID');
    expect(records).toHaveLength(2);
  });

  it('refuses to submit an item worth more than is still owed on its invoice', async () => {
    // Half was paid by hand after the item was added at the full amount.
    const stale = item('1');
    stale.invoice.paidAmount = new Decimal('50000');
    stale.invoice.status = 'PARTIALLY_PAID';
    const { service } = harness({ items: [stale] });
    await expect(service.submitForApproval('pay_1', 'usr_iyer')).rejects.toBeInstanceOf(
      PaymentRunSubmissionBlockedError,
    );
  });

  it('blocks the bank submission if the file changed between submit and approval', async () => {
    const build = vi
      .fn()
      .mockResolvedValueOnce(FILE)
      .mockResolvedValueOnce({ ...FILE, checksum: 'DRIFTED' });
    const { service, run, records } = harness({
      buildFn: build as unknown as () => unknown,
    });

    await service.submitForApproval('pay_1', 'usr_iyer');
    await expect(service.onFullyApproved('pay_1', 'usr_das')).rejects.toBeInstanceOf(
      PaymentRunSubmissionBlockedError,
    );
    expect(run.status).not.toBe('SUBMITTED_PENDING_BANK_CONFIRMATION');
    expect(records).toHaveLength(0);
  });

  it('refuses to submit a run whose item has an unverified vendor bank', async () => {
    const { service } = harness({ items: [item('1'), item('2', 'APPROVED', false)] });
    await expect(service.submitForApproval('pay_1', 'usr_iyer')).rejects.toBeInstanceOf(
      PaymentRunSubmissionBlockedError,
    );
  });
});
