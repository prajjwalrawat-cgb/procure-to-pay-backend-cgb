import Decimal from 'decimal.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditLogService } from '../audit/audit.service';
import { DomainEventService } from '../common/events/domain-event.service';
import { PrismaService } from '../prisma/prisma.service';
import { BudgetService } from './budget.service';
import { BudgetMissingError, CurrencyMismatchError } from './budget.errors';

function budgetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bdg_1',
    tenantId: 'ten_1',
    costCenterId: 'cc_1',
    periodType: 'ANNUAL',
    periodStart: new Date('2026-04-01'),
    periodEnd: new Date('2027-03-31'),
    currency: 'INR',
    allocatedAmount: new Decimal('8000000'),
    committedAmount: new Decimal('4260000'),
    consumedAmount: new Decimal('0'),
    ...overrides,
  };
}

function build(budget: ReturnType<typeof budgetRow> | null) {
  const client = {
    budget: {
      findFirst: vi.fn().mockResolvedValue(budget),
      findUniqueOrThrow: vi.fn().mockResolvedValue(budget),
      update: vi.fn().mockResolvedValue(budget),
    },
    budgetCommitment: {
      create: vi.fn().mockResolvedValue({ id: 'bcm_1' }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
  };
  const prisma = {
    client,
    currentTenantId: 'ten_1',
  } as unknown as PrismaService;
  const audit = { record: vi.fn() } as unknown as AuditLogService;
  const events = { emit: vi.fn() } as unknown as DomainEventService;
  return { service: new BudgetService(prisma, audit, events), client };
}

describe('BudgetService.checkAvailability', () => {
  it('reports available within budget', async () => {
    const { service } = build(budgetRow());
    const r = await service.checkAvailability('cc_1', '1000000');
    expect(r.available).toBe(true);
    expect(r.remaining).toBe('3740000.0000'); // 8,000,000 − 4,260,000
    expect(r.wouldBreachBy).toBeNull();
  });

  it('is available at the exact-fit boundary', async () => {
    const { service } = build(budgetRow());
    const r = await service.checkAvailability('cc_1', '3740000');
    expect(r.available).toBe(true);
    expect(r.wouldBreachBy).toBeNull();
  });

  it('breaches by ₹1 just over the remaining', async () => {
    const { service } = build(budgetRow());
    const r = await service.checkAvailability('cc_1', '3740001');
    expect(r.available).toBe(false);
    expect(r.wouldBreachBy).toBe('1.0000');
  });

  it('returns unavailable when no budget exists for the period', async () => {
    const { service } = build(null);
    const r = await service.checkAvailability('cc_missing', '100');
    expect(r.available).toBe(false);
    expect(r.budgetId).toBeNull();
    expect(r.wouldBreachBy).toBe('100.0000');
  });

  it('treats a fully-committed budget as breaching', async () => {
    const { service } = build(budgetRow({ committedAmount: new Decimal('8000000') }));
    const r = await service.checkAvailability('cc_1', '1');
    expect(r.available).toBe(false);
    expect(r.remaining).toBe('0.0000');
  });

  it('accounts for consumed alongside committed', async () => {
    const { service } = build(
      budgetRow({
        committedAmount: new Decimal('2000000'),
        consumedAmount: new Decimal('1000000'),
      }),
    );
    const r = await service.checkAvailability('cc_1', '5000000');
    expect(r.remaining).toBe('5000000.0000'); // 8M − 2M − 1M
    expect(r.available).toBe(true);
  });
});

describe('BudgetService.commitAmount', () => {
  let svc: BudgetService;
  let client: ReturnType<typeof build>['client'];

  beforeEach(() => {
    const b = build(budgetRow());
    svc = b.service;
    client = b.client;
  });

  it('throws CurrencyMismatchError for a non-INR amount', async () => {
    await expect(
      svc.commitAmount('cc_1', 'pr_1', '1000', 'usr_1', 'USD'),
    ).rejects.toBeInstanceOf(CurrencyMismatchError);
  });

  it('throws BudgetMissingError when no budget covers the cost center', async () => {
    client.budget.findFirst.mockResolvedValue(null);
    await expect(
      svc.commitAmount('cc_x', 'pr_1', '1000', 'usr_1'),
    ).rejects.toBeInstanceOf(BudgetMissingError);
  });

  it('creates a COMMITTED commitment within budget', async () => {
    await svc.commitAmount('cc_1', 'pr_1', '1000000', 'usr_1');
    expect(client.budgetCommitment.create).toHaveBeenCalledOnce();
    const arg = client.budgetCommitment.create.mock.calls[0]![0] as {
      data: { status: string; sourceType: string };
    };
    expect(arg.data.status).toBe('COMMITTED');
    expect(arg.data.sourceType).toBe('PR');
  });

  it('refuses to commit above the remaining budget', async () => {
    await expect(svc.commitAmount('cc_1', 'pr_1', '9000000', 'usr_1')).rejects.toThrow(
      /exceeds the remaining budget/i,
    );
  });
});
