import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';

import type { AuthUser } from '../auth.types';
import type { RequiredPermissionMeta } from '../decorators';
import { PermissionGuard } from './permission.guard';

function makeContext(user: AuthUser | undefined, params: Record<string, string> = {}) {
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ user, params }) }),
  } as unknown as ExecutionContext;
}

function makeReflector(meta: RequiredPermissionMeta | undefined): Reflector {
  return { getAllAndOverride: vi.fn().mockReturnValue(meta) } as unknown as Reflector;
}

const user: AuthUser = {
  userId: 'usr_1',
  tenantId: 't1',
  audience: 'buyer',
  roles: ['FINANCE_OFFICER'],
  perms: ['invoice:create', 'invoice:read:tenant'],
};

describe('PermissionGuard', () => {
  it('allows when no permission metadata is set', async () => {
    const guard = new PermissionGuard(makeReflector(undefined));
    await expect(guard.canActivate(makeContext(user))).resolves.toBe(true);
  });

  it('allows when the user holds the permission', async () => {
    const guard = new PermissionGuard(makeReflector({ permission: 'invoice:create' }));
    await expect(guard.canActivate(makeContext(user))).resolves.toBe(true);
  });

  it('forbids when the permission is missing', async () => {
    const guard = new PermissionGuard(
      makeReflector({ permission: 'payment_run:approve' }),
    );
    await expect(guard.canActivate(makeContext(user))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('forbids when there is no authenticated user', async () => {
    const guard = new PermissionGuard(makeReflector({ permission: 'invoice:create' }));
    await expect(guard.canActivate(makeContext(undefined))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('runs the ownership predicate for scoped permissions', async () => {
    const okGuard = new PermissionGuard(
      makeReflector({
        permission: 'invoice:read:own',
        predicate: (u, p) => p.ownerId === u.userId,
      }),
    );
    const perm = { ...user, perms: [...user.perms, 'invoice:read:own'] };
    await expect(
      okGuard.canActivate(makeContext(perm, { ownerId: 'usr_1' })),
    ).resolves.toBe(true);
    await expect(
      okGuard.canActivate(makeContext(perm, { ownerId: 'usr_2' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
