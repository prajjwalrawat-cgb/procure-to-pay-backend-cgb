import type { ApprovalStep } from '@procureflow/shared';
import { describe, expect, it, vi } from 'vitest';

import type { AuditLogService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ApprovalContextService } from './approval-context.service';
import { ApprovalMatrixService } from './approval-matrix.service';
import type { ApproverResolver } from './approver-resolver.service';

const STEPS: ApprovalStep[] = [
  {
    step_no: 1,
    name: 'Finance Head',
    role: 'FINANCE_HEAD',
    scope: 'tenant',
    sla_hours: 24,
  },
];

function makeService(overrides: {
  candidates?: string[];
  userFindUnique?: { name: string } | null;
  matrixRow?: Record<string, unknown>;
  aggregateMax?: number | null;
}) {
  const create = vi
    .fn()
    .mockImplementation((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ createdAt: new Date('2026-01-01'), ...args.data }),
    );
  const prisma = {
    client: {
      user: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi
          .fn()
          .mockResolvedValue(
            overrides.userFindUnique === undefined
              ? { name: 'R. Das' }
              : overrides.userFindUnique,
          ),
      },
      approvalMatrix: {
        findUnique: vi.fn().mockResolvedValue(overrides.matrixRow ?? null),
        aggregate: vi
          .fn()
          .mockResolvedValue({ _max: { version: overrides.aggregateMax ?? 1 } }),
        create,
      },
    },
  } as unknown as PrismaService;
  const audit = {
    record: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuditLogService;
  const context = {
    build: vi.fn(),
    submitterOf: vi.fn().mockResolvedValue(null),
  } as unknown as ApprovalContextService;
  const resolver = {
    candidatesForRole: vi.fn().mockResolvedValue(overrides.candidates ?? ['usr_das']),
  } as unknown as ApproverResolver;
  return { service: new ApprovalMatrixService(prisma, audit, context, resolver), create };
}

describe('ApprovalMatrixService.simulate', () => {
  it('matches and resolves the chain to a named approver', async () => {
    const { service } = makeService({ candidates: ['usr_das'] });
    const result = await service.simulate({
      documentType: 'INVOICE',
      conditions: { all: [{ field: 'total_amount', op: 'lte', value: '500000' }] },
      steps: STEPS,
      matrixId: 'amx_1',
      matrixName: 'Standard',
      sampleDocument: { documentType: 'INVOICE', total_amount: '216884' },
    });
    expect(result.matched).toBe(true);
    expect(result.chain[0]?.approverName).toBe('R. Das');
    expect(result.matchedMatrixId).toBe('amx_1');
  });

  it('does not match when the condition fails', async () => {
    const { service } = makeService({});
    const result = await service.simulate({
      documentType: 'INVOICE',
      conditions: { all: [{ field: 'total_amount', op: 'gt', value: '500000' }] },
      steps: STEPS,
      matrixId: 'amx_1',
      matrixName: 'Standard',
      sampleDocument: { documentType: 'INVOICE', total_amount: '216884' },
    });
    expect(result.matched).toBe(false);
    expect(result.chain).toHaveLength(0);
  });

  it('flags a step as unresolved when no candidate holds the role', async () => {
    const { service } = makeService({ candidates: [] });
    const result = await service.simulate({
      documentType: 'INVOICE',
      conditions: {},
      steps: STEPS,
      matrixId: 'amx_1',
      matrixName: 'Standard',
      sampleDocument: { documentType: 'INVOICE', total_amount: '1' },
    });
    expect(result.chain[0]?.unresolved).toBe(true);
  });
});

describe('ApprovalMatrixService.update', () => {
  it('creates a new version chained on the previous one instead of mutating', async () => {
    const { service, create } = makeService({
      matrixRow: {
        id: 'amx_1',
        name: 'Standard',
        documentType: 'INVOICE',
        priority: 1,
        version: 1,
        conditions: {},
        steps: STEPS,
      },
      aggregateMax: 1,
    });
    await service.update('ten_1', 'usr_admin', 'amx_1', { priority: 5 });
    const data = create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data.version).toBe(2);
    expect(data.previousVersionId).toBe('amx_1');
    expect(data.isActive).toBe(false);
    expect(data.priority).toBe(5);
  });
});
