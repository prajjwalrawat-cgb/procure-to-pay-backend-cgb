import Decimal from 'decimal.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const D = (v: string) => new Decimal(v);
const FILE = {
  filename: 'HDFC_NEFT_PR.csv',
  content: 'H,STAR01\r\n',
  contentBytes: new TextEncoder().encode('H,STAR01\r\n'),
  checksum: 'abc123',
  rowCount: 2,
};

function item(id: string, status = 'APPROVED', ifsc = 'HDFC0001234') {
  return {
    id: `payi_${id}`,
    invoiceId: `inv_${id}`,
    gross: D('100000'),
    tds: D('0'),
    net: D('100000'),
    bankStatus: 'PENDING',
    invoice: {
      number: `INV-${id}`,
      status,
      vendor: {
        name: 'Vendor',
        banks: [{ isVerified: true, ifsc, holderName: 'Vendor Ltd' }],
      },
    },
  };
}

function gateway() {
  const usage = { log: vi.fn() } as unknown as IntegrationUsageService;
  return new SandboxBankGateway(new CircuitBreaker(), usage);
}

function commonDeps() {
  return {
    audit: { record: vi.fn() } as unknown as AuditLogService,
    events: { emit: vi.fn() } as unknown as DomainEventService,
    bankFile: { build: vi.fn().mockResolvedValue(FILE) } as unknown as BankFileService,
    storage: { put: vi.fn().mockResolvedValue('key') } as unknown as StorageService,
  };
}

// ── Submission ────────────────────────────────────────────────────────────────

function buildSubmit(
  items = [item('1'), item('2')],
  runOverrides: Record<string, unknown> = {},
  intent: { existing?: unknown; dangling?: unknown; maxAttempt?: number } = {},
) {
  const run = {
    id: 'pay_1',
    tenantId: 'ten_1',
    previewHash: 'abc123',
    bankAccount: { formatKey: 'NEFT_BULK' },
    items,
    ...runOverrides,
  };
  const created = {
    intents: [] as Record<string, unknown>[],
    items: [] as Record<string, unknown>[],
  };
  let runUpdate: Record<string, unknown> | null = null;
  const client = {
    paymentRun: {
      findUnique: vi.fn().mockResolvedValue(run),
      update: vi.fn((a: { data: Record<string, unknown> }) => {
        runUpdate = a.data;
        return Promise.resolve(a.data);
      }),
    },
    paymentSubmissionIntent: {
      findFirst: vi.fn(({ where }: { where: { status?: unknown } }) => {
        if (where.status && typeof where.status === 'object')
          return Promise.resolve(intent.existing ?? null); // {in:[SUBMITTED,CONFIRMED]}
        if (where.status === 'INTENT') return Promise.resolve(intent.dangling ?? null);
        return Promise.resolve(null);
      }),
      aggregate: vi
        .fn()
        .mockResolvedValue({ _max: { attemptNo: intent.maxAttempt ?? 0 } }),
      create: vi.fn((a: { data: Record<string, unknown> }) => {
        created.intents.push(a.data);
        return Promise.resolve(a.data);
      }),
      update: vi.fn((a: { data: Record<string, unknown> }) => Promise.resolve(a.data)),
    },
    paymentRunItem: {
      update: vi.fn((a: { data: Record<string, unknown> }) => {
        created.items.push(a.data);
        return Promise.resolve(a.data);
      }),
    },
    invoice: { update: vi.fn() },
  };
  const prisma = { client } as unknown as PrismaService;
  const d = commonDeps();
  const svc = new BankSubmissionService(
    prisma,
    d.audit,
    d.events,
    d.bankFile,
    d.storage,
    gateway(),
  );
  return {
    svc,
    client,
    created,
    get runUpdate() {
      return runUpdate;
    },
  };
}

describe('BankSubmissionService.submitRun (real bank submission, ADR-034)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('submits idempotently → SUBMITTED_PENDING_BANK_CONFIRMATION, no PAID until confirmed', async () => {
    const h = buildSubmit();
    await h.svc.submitRun('pay_1', 'usr_das');
    expect(h.created.intents).toHaveLength(1); // intent written BEFORE the bank call
    expect(h.runUpdate?.status).toBe('SUBMITTED_PENDING_BANK_CONFIRMATION');
    expect(h.created.items.every((u) => u.bankStatus === 'SUBMITTED')).toBe(true);
    // Nothing is marked paid at submission time.
    expect(h.client.invoice.update).not.toHaveBeenCalled();
  });

  it('is an idempotent no-op when the run is already submitted (no double-pay)', async () => {
    const h = buildSubmit([item('1')], {}, { existing: { id: 'psi_1', attemptNo: 1 } });
    await h.svc.submitRun('pay_1', 'usr');
    expect(h.client.paymentSubmissionIntent.create).not.toHaveBeenCalled();
    expect(h.client.paymentRun.update).not.toHaveBeenCalled();
  });

  it('refuses to auto-resubmit over a dangling INTENT (crash recovery — manual review)', async () => {
    const h = buildSubmit([item('1')], {}, { dangling: { id: 'psi_x' } });
    await expect(h.svc.submitRun('pay_1', 'usr')).rejects.toBeInstanceOf(
      PaymentRunSubmissionBlockedError,
    );
    expect(h.client.paymentSubmissionIntent.create).not.toHaveBeenCalled();
  });

  it('handles a partial batch — one bad IFSC fails, the rest submit', async () => {
    const h = buildSubmit([item('1'), item('2', 'APPROVED', 'INVALID0000')]);
    await h.svc.submitRun('pay_1', 'usr');
    const statuses = h.created.items.map((u) => u.bankStatus);
    expect(statuses).toContain('SUBMITTED');
    expect(statuses).toContain('FAILED');
    // The run still advances — the failed item does not block the batch.
    expect(h.runUpdate?.status).toBe('SUBMITTED_PENDING_BANK_CONFIRMATION');
  });

  it('blocks submission when the file changed after approval', async () => {
    const h = buildSubmit([item('1')], { previewHash: 'STALE' });
    await expect(h.svc.submitRun('pay_1', 'usr')).rejects.toBeInstanceOf(
      PaymentRunSubmissionBlockedError,
    );
    expect(h.client.paymentSubmissionIntent.create).not.toHaveBeenCalled();
  });

  it('blocks submission when an item is no longer approved', async () => {
    const h = buildSubmit([item('1'), item('2', 'REJECTED')]);
    await expect(h.svc.submitRun('pay_1', 'usr')).rejects.toBeInstanceOf(
      PaymentRunSubmissionBlockedError,
    );
    expect(h.client.paymentSubmissionIntent.create).not.toHaveBeenCalled();
  });
});

// ── Confirmation ──────────────────────────────────────────────────────────────

describe('UtrReconciliationService.confirmRun (real UTRs, never rewrites stubs)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('posts REAL (non-stub) UTRs, sets isStub=false, and marks invoices PAID', async () => {
    const items = [item('1'), item('2')];
    const run = {
      id: 'pay_1',
      tenantId: 'ten_1',
      number: 'PR-1',
      status: 'SUBMITTED_PENDING_BANK_CONFIRMATION',
      bankAccount: { formatKey: 'NEFT_BULK' },
      items,
    };
    const records: Record<string, unknown>[] = [];
    let runUpdate: Record<string, unknown> | null = null;
    const client = {
      paymentRun: {
        findUnique: vi.fn().mockResolvedValue(run),
        update: vi.fn((a: { data: Record<string, unknown> }) => {
          runUpdate = a.data;
          return Promise.resolve(a.data);
        }),
      },
      paymentSubmissionIntent: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'psi_1',
          attemptNo: 1,
          status: 'SUBMITTED',
          bankBatchRef: 'SIMBATCH-pay_1:1',
          simulated: true,
        }),
        update: vi.fn(),
      },
      paymentRecord: {
        findFirst: vi.fn().mockResolvedValue(null), // no existing record (idempotency)
        create: vi.fn((a: { data: Record<string, unknown> }) => {
          records.push(a.data);
          return Promise.resolve(a.data);
        }),
      },
      // The posting increments paidAmount and reads the row back: the whole
      // 100000 is now settled, so the invoice goes PAID.
      invoice: {
        update: vi.fn().mockResolvedValue({
          grossAmount: D('100000'),
          paidAmount: D('100000'),
          status: 'SCHEDULED',
        }),
      },
      paymentRunItem: { update: vi.fn() },
    };
    const prisma = { client } as unknown as PrismaService;
    const d = commonDeps();
    const submission = new BankSubmissionService(
      prisma,
      d.audit,
      d.events,
      d.bankFile,
      d.storage,
      gateway(),
    );
    const svc = new UtrReconciliationService(
      prisma,
      d.audit,
      d.events,
      submission,
      new PaymentPostingService(prisma, d.audit),
      gateway(),
    );

    const result = await svc.confirmRun('pay_1', 'usr');
    expect(result.status).toBe('COMPLETED');
    expect(result.confirmed).toBe(2);
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.isStub === false)).toBe(true);
    expect(records.every((r) => !String(r.utr).startsWith('STUB'))).toBe(true);
    expect(client.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PAID' }) }),
    );
    expect(runUpdate?.status).toBe('COMPLETED');
  });
});
