import { BadRequestException, UnauthorizedException } from '@nestjs/common';
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

import { hash as argonHash, verify as argonVerify } from 'argon2';

import type { AuditLogService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { passwordFingerprint, type TokenService } from './token.service';

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

/** The stored user as the reset path reads it back inside the tenant context. */
const USER_RECORD = {
  id: USER_ROW.id,
  tenantId: USER_ROW.tenant_id,
  email: USER_ROW.email,
  name: USER_ROW.name,
  argonHash: USER_ROW.argon_hash,
  isActive: true,
};

function build(
  rows: (typeof USER_ROW)[],
  roleNames: string[] = ['FINANCE_OFFICER'],
  stored: typeof USER_RECORD | null = USER_RECORD,
) {
  const sessionCreate = vi.fn().mockResolvedValue(undefined);
  const userUpdate = vi.fn().mockResolvedValue(undefined);
  const sessionRevoke = vi.fn().mockResolvedValue({ count: 2 });
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
          user: {
            findUnique: vi.fn().mockResolvedValue(stored),
            update: userUpdate,
          },
          session: { updateMany: sessionRevoke },
        }),
    ),
  } as unknown as PrismaService;

  const tokens = {
    issueAccess: vi.fn().mockResolvedValue({ token: 'access-tok', expiresIn: 900 }),
    issueRefresh: vi.fn().mockResolvedValue('refresh-tok'),
    issuePasswordReset: vi.fn().mockResolvedValue('reset-tok'),
    verifyPasswordReset: vi.fn().mockResolvedValue({
      userId: USER_ROW.id,
      tenantId: USER_ROW.tenant_id,
      portal: 'buyer',
      passwordFingerprint: passwordFingerprint(USER_ROW.argon_hash),
    }),
    verify: vi.fn(),
  } as unknown as TokenService;

  const audit = {
    record: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuditLogService;
  const config = { get: vi.fn().mockReturnValue('http://localhost:3000') };
  const mail = { send: vi.fn().mockResolvedValue(undefined) };

  const service = new AuthService(
    prisma,
    tokens,
    audit,
    config as unknown as ConstructorParameters<typeof AuthService>[3],
    mail as unknown as ConstructorParameters<typeof AuthService>[4],
  );
  return {
    service,
    prisma,
    tokens,
    audit,
    mail,
    sessionCreate,
    userUpdate,
    sessionRevoke,
  };
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

describe('AuthService.requestPasswordReset', () => {
  it('emails a portal-specific link to an eligible user', async () => {
    const { service, mail, audit } = build([USER_ROW]);
    await service.requestPasswordReset(USER_ROW.email, 'buyer', {});

    expect(mail.send).toHaveBeenCalledOnce();
    const sent = mail.send.mock.calls[0]?.[0] as { to: string; text: string };
    expect(sent.to).toBe(USER_ROW.email);
    expect(sent.text).toContain('http://localhost:3000/reset-password?token=reset-tok');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.password_reset_requested' }),
    );
  });

  it('sends the vendor link when the request comes from the vendor portal', async () => {
    const { service, mail } = build([USER_ROW], ['VENDOR_USER']);
    await service.requestPasswordReset(USER_ROW.email, 'vendor', {});
    const sent = mail.send.mock.calls[0]?.[0] as { text: string };
    expect(sent.text).toContain('/vendor/reset-password?token=');
  });

  it('stays silent for an unknown address — no mail, no error', async () => {
    const { service, mail } = build([]);
    await expect(
      service.requestPasswordReset('nobody@x.com', 'buyer', {}),
    ).resolves.toBeUndefined();
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('sends nothing when the account cannot sign in to that portal', async () => {
    const { service, mail } = build([USER_ROW], ['VENDOR_USER']);
    await service.requestPasswordReset(USER_ROW.email, 'buyer', {});
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('sends nothing to a deactivated account', async () => {
    const { service, mail } = build([{ ...USER_ROW, is_active: false }]);
    await service.requestPasswordReset(USER_ROW.email, 'buyer', {});
    expect(mail.send).not.toHaveBeenCalled();
  });
});

describe('AuthService.resetPassword', () => {
  it('sets the new hash and revokes every session', async () => {
    vi.mocked(argonHash).mockResolvedValue('argon$new');
    const { service, userUpdate, sessionRevoke, audit } = build([USER_ROW]);

    const res = await service.resetPassword('reset-tok', 'brand-new-pass');

    expect(res.email).toBe(USER_ROW.email);
    expect(userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { argonHash: 'argon$new' } }),
    );
    expect(sessionRevoke).toHaveBeenCalledOnce();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.password_reset' }),
    );
  });

  it('rejects a link whose password has already changed since it was issued', async () => {
    const { service, userUpdate } = build([USER_ROW], ['FINANCE_OFFICER'], {
      ...USER_RECORD,
      argonHash: 'argon$already-rotated',
    });
    await expect(
      service.resetPassword('reset-tok', 'x'.repeat(10)),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it('rejects a link for a user that no longer exists', async () => {
    const { service } = build([USER_ROW], ['FINANCE_OFFICER'], null);
    await expect(
      service.resetPassword('reset-tok', 'x'.repeat(10)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
