import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from './audit.service';

function makePrisma(currentTenantId: string | undefined) {
  const create = vi.fn().mockResolvedValue(undefined);
  const prisma = {
    currentTenantId,
    client: { auditLog: { create } },
  } as unknown as PrismaService;
  return { prisma, create };
}

describe('AuditLogService.record', () => {
  it('writes an audit row using the ambient tenant, with an empty hash placeholder', async () => {
    const { prisma, create } = makePrisma('tenant-1');
    const service = new AuditLogService(prisma);

    await service.record({
      action: 'user.created',
      entityType: 'User',
      entityId: 'usr_1',
      actorId: 'usr_admin',
      after: { email: 'a@b.com' },
    });

    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(arg.data.tenantId).toBe('tenant-1');
    expect(arg.data.action).toBe('user.created');
    expect(arg.data.actorType).toBe('USER');
    // The DB trigger sets the real hash; the app must send only a placeholder.
    expect(arg.data.hashCurrent).toBe('');
  });

  it('accepts an explicit tenantId when outside a request context', async () => {
    const { prisma, create } = makePrisma(undefined);
    const service = new AuditLogService(prisma);
    await service.record({
      action: 'auth.login_success',
      entityType: 'User',
      entityId: 'usr_1',
      tenantId: 'tenant-2',
    });
    const arg = create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(arg.data.tenantId).toBe('tenant-2');
    expect(arg.data.actorType).toBe('SYSTEM');
  });

  it('throws when no tenant can be resolved', async () => {
    const { prisma } = makePrisma(undefined);
    const service = new AuditLogService(prisma);
    await expect(
      service.record({ action: 'x', entityType: 'User', entityId: 'usr_1' }),
    ).rejects.toThrow(/tenant context/);
  });
});
