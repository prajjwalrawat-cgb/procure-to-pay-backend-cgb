import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AuditLogService } from '../audit/audit.service';
import type { TokenService } from '../auth/token.service';
import type { MailService } from '../common/mail/mail.service';
import type { PrismaService } from '../prisma/prisma.service';
import { UsersService } from './users.service';

/** Active rules in the tenant, each already shaped like the stored JSON. */
function makeService(opts: {
  matrices: { name: string; steps: { role: string; scope: string }[] }[];
  /** Holders of the role being granted, excluding the target user. */
  otherHolders: number;
}): UsersService {
  const prisma = {
    client: {
      approvalMatrix: { findMany: vi.fn().mockResolvedValue(opts.matrices) },
      userRole: {
        count: vi.fn().mockResolvedValue(opts.otherHolders),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn().mockResolvedValue({}),
      },
      role: { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'role_1' }) },
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'usr_target',
          tenantId: 'ten_1',
          email: 'jane@x.example',
          name: 'Jane',
          isActive: true,
          createdAt: new Date(),
          userRoles: [{ role: { name: 'REQUESTER' } }],
        }),
        count: vi.fn().mockResolvedValue(2),
      },
    },
  } as unknown as PrismaService;
  const audit = {
    record: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuditLogService;
  return new UsersService(
    prisma,
    audit,
    {} as TokenService,
    {} as MailService,
    { get: vi.fn() } as never,
  );
}

const ADMIN_RULE = {
  name: 'Admin approval — all purchase orders',
  steps: [{ role: 'TENANT_ADMIN', scope: 'tenant' }],
};

describe('UsersService.updateRoles — routed-role guard', () => {
  it('rejects a second holder of a role an active rule routes to', async () => {
    const service = makeService({ matrices: [ADMIN_RULE], otherHolders: 1 });
    await expect(
      service.updateRoles('ten_1', 'usr_target', ['TENANT_ADMIN'], 'usr_admin'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows the grant when nobody else holds the routed role', async () => {
    const service = makeService({ matrices: [ADMIN_RULE], otherHolders: 0 });
    const member = await service.updateRoles(
      'ten_1',
      'usr_target',
      ['TENANT_ADMIN'],
      'usr_admin',
    );
    expect(member.roles).toEqual(['TENANT_ADMIN']);
  });

  it('allows a second holder when no active rule routes to the role', async () => {
    const service = makeService({ matrices: [ADMIN_RULE], otherHolders: 3 });
    const member = await service.updateRoles(
      'ten_1',
      'usr_target',
      ['PROCUREMENT_OFFICER'],
      'usr_admin',
    );
    expect(member.roles).toEqual(['PROCUREMENT_OFFICER']);
  });

  it('ignores dept-scoped steps — the resolver narrows those by department', async () => {
    const service = makeService({
      matrices: [{ name: 'PR — dept', steps: [{ role: 'DEPT_HEAD', scope: 'dept' }] }],
      otherHolders: 2,
    });
    const member = await service.updateRoles(
      'ten_1',
      'usr_target',
      ['DEPT_HEAD'],
      'usr_admin',
    );
    expect(member.roles).toEqual(['DEPT_HEAD']);
  });
});
