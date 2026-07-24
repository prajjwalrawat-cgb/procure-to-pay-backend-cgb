import { describe, expect, it, vi } from 'vitest';

import type { AuditLogService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import { CircularDelegationError } from './approval.errors';
import { DelegationService } from './delegation.service';

function makeService(reverseExists: boolean) {
  const create = vi.fn().mockResolvedValue(undefined);
  const prisma = {
    client: {
      delegation: {
        findFirst: vi.fn().mockResolvedValue(reverseExists ? { id: 'dlg_rev' } : null),
        create,
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: 'dlg_1',
          userId: 'usr_a',
          delegateUserId: 'usr_b',
          scope: 'ALL',
          documentTypes: [],
          reason: 'leave',
          fromDate: new Date('2026-01-01'),
          toDate: new Date('2026-02-01'),
          isActive: true,
          createdAt: new Date('2026-01-01'),
        }),
      },
      user: { findMany: vi.fn().mockResolvedValue([]) },
    },
  } as unknown as PrismaService;
  const audit = {
    record: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuditLogService;
  return { service: new DelegationService(prisma, audit), create };
}

const input = {
  delegateUserId: 'usr_b',
  scope: 'ALL' as const,
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-02-01T00:00:00.000Z',
  reason: 'leave',
};

describe('DelegationService.create', () => {
  it('creates a delegation when there is no reciprocal one', async () => {
    const { service, create } = makeService(false);
    await service.create('ten_1', 'usr_a', 'usr_a', input);
    expect(create).toHaveBeenCalled();
  });

  it('rejects a delegation that would form a loop', async () => {
    const { service } = makeService(true);
    await expect(service.create('ten_1', 'usr_a', 'usr_a', input)).rejects.toBeInstanceOf(
      CircularDelegationError,
    );
  });
});
