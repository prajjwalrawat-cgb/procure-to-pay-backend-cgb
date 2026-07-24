import { UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Keep the unit hermetic: no generated Prisma client, no native crypto deps.
vi.mock('@procureflow/db', () => ({
  Prisma: {
    sql: (strings: TemplateStringsArray, ...vals: unknown[]) => ({ strings, vals }),
  },
  // PrismaService extends PrismaClient; provide a stub so the module loads.
  PrismaClient: class {},
  newId: (kind: string) => `${kind}_test`,
}));
vi.mock('argon2', () => ({ verify: vi.fn(), hash: vi.fn() }));
vi.mock('otplib', () => ({
  authenticator: { verify: vi.fn(), generateSecret: vi.fn(), keyuri: vi.fn() },
}));
vi.mock('qrcode', () => ({ toString: vi.fn() }));

import { verify as argonVerify } from 'argon2';

import type { AuditLogService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import type { TokenService } from './token.service';

const argonMock = vi.mocked(argonVerify);

const USER_ROW = {
  id: 'usr_1',
  tenant_id: 'ten_1',
  email: 'harpreet@star-cement.example',
  name: 'Harpreet Singh',
  argon_hash: 'argon$hash',
  mfa_secret: null,
  mfa_enabled: false,
  is_active: true,
};

function build(rows: (typeof USER_ROW)[], roleNames: string[] = ['FINANCE_OFFICER']) {
  const sessionCreate = vi.fn().mockResolvedValue(undefined);
  const prisma = {
    $queryRaw: vi.fn().mockResolvedValue(rows),
    session: { create: sessionCreate },
    runInTenantContext: vi.fn(
      async (_tid: string, fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          userRole: {
            findMany: vi
              .fn()
              .mockResolvedValue(roleNames.map((name) => ({ role: { name } }))),
          },
        }),
    ),
  } as unknown as PrismaService;

  const tokens = {
    issueAccess: vi.fn().mockResolvedValue({ token: 'access-tok', expiresIn: 900 }),
    issueRefresh: vi.fn().mockResolvedValue('refresh-tok'),
    verify: vi.fn(),
  } as unknown as TokenService;

  const audit = {
    record: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuditLogService;
  const config = { get: vi.fn() } as unknown as ConstructorParameters<
    typeof AuthService
  >[3];

  const service = new AuthService(prisma, tokens, audit, config);
  return { service, prisma, tokens, audit, sessionCreate };
}

describe('AuthService.login', () => {
  beforeEach(() => argonMock.mockReset());

  it('issues tokens and audits a successful login', async () => {
    argonMock.mockResolvedValue(true);
    const { service, tokens, audit, sessionCreate } = build([USER_ROW]);

    const res = await service.login(
      { email: USER_ROW.email, password: 'Slice0!Demo' },
      'buyer',
      { ipAddress: '127.0.0.1', userAgent: 'vitest' },
    );

    expect(res.tokens.accessToken).toBe('access-tok');
    expect(res.tokens.refreshToken).toBe('refresh-tok');
    expect(res.user.roles).toContain('FINANCE_OFFICER');
    expect(tokens.issueAccess).toHaveBeenCalledOnce();
    expect(sessionCreate).toHaveBeenCalledOnce();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.login_success' }),
    );
  });

  it('rejects an unknown email with a generic error and no user enumeration', async () => {
    const { service } = build([]);
    await expect(
      service.login({ email: 'nobody@x.com', password: 'x' }, 'buyer', {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a wrong password and audits the failure', async () => {
    argonMock.mockResolvedValue(false);
    const { service, audit } = build([USER_ROW]);
    await expect(
      service.login({ email: USER_ROW.email, password: 'wrong' }, 'buyer', {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.login_failed' }),
    );
  });

  it('rejects a VENDOR_USER signing in on the buyer portal', async () => {
    argonMock.mockResolvedValue(true);
    const { service, audit } = build([USER_ROW], ['VENDOR_USER']);
    await expect(
      service.login({ email: USER_ROW.email, password: 'Slice0!Vendor' }, 'buyer', {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.portal_denied' }),
    );
  });

  it('rejects an internal user signing in on the vendor portal', async () => {
    argonMock.mockResolvedValue(true);
    const { service } = build([USER_ROW], ['FINANCE_OFFICER']);
    await expect(
      service.login({ email: USER_ROW.email, password: 'Slice0!Demo' }, 'vendor', {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('allows a VENDOR_USER on the vendor portal', async () => {
    argonMock.mockResolvedValue(true);
    const { service } = build([USER_ROW], ['VENDOR_USER']);
    const res = await service.login(
      { email: USER_ROW.email, password: 'Slice0!Vendor' },
      'vendor',
      {},
    );
    expect(res.tokens.accessToken).toBe('access-tok');
    expect(res.user.roles).toContain('VENDOR_USER');
  });

  it('returns an MFA challenge when MFA is enabled and no code is supplied', async () => {
    argonMock.mockResolvedValue(true);
    const { service } = build([{ ...USER_ROW, mfa_enabled: true, mfa_secret: 'SECRET' }]);
    const res = await service.login(
      { email: USER_ROW.email, password: 'Slice0!Demo' },
      'buyer',
      {},
    );
    expect(res.mfaRequired).toBe(true);
    expect(res.tokens.accessToken).toBe('');
  });
});
