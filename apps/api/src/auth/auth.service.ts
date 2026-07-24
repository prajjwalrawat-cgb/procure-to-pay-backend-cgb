import { createHash } from 'node:crypto';

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, newId } from '@procureflow/db';
import {
  ROLES,
  ROLE_PERMISSIONS,
  addDaysUtc,
  type LoginInput,
  type LoginResponse,
  type Portal,
  type RoleName,
} from '@procureflow/shared';
import { verify as argonVerify } from 'argon2';
import { authenticator } from 'otplib';
import { toString as qrToString } from 'qrcode';

import { AuditLogService } from '../audit/audit.service';
import type { Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { TokenService } from './token.service';

interface AuthRow {
  id: string;
  tenant_id: string;
  email: string;
  name: string;
  argon_hash: string;
  mfa_secret: string | null;
  mfa_enabled: boolean;
  is_active: boolean;
}

interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly audit: AuditLogService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async login(
    input: LoginInput,
    portal: Portal,
    meta: RequestMeta,
  ): Promise<LoginResponse> {
    const user = await this.findUserForAuth(input.email);
    // Uniform failure — never reveal whether the email exists (§ Slice 0 auth).
    if (!user || !user.is_active) throw new UnauthorizedException('Invalid credentials');

    const passwordOk = await argonVerify(user.argon_hash, input.password);
    if (!passwordOk) {
      await this.auditAuth(user.tenant_id, user.id, 'auth.login_failed', meta);
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.mfa_enabled) {
      if (!input.mfaCode) {
        return this.mfaChallengeResponse(user);
      }
      const codeOk =
        user.mfa_secret != null &&
        authenticator.verify({ token: input.mfaCode, secret: user.mfa_secret });
      if (!codeOk) {
        await this.auditAuth(user.tenant_id, user.id, 'auth.mfa_failed', meta);
        throw new UnauthorizedException('Invalid credentials');
      }
    }

    const { roles, perms } = await this.loadRolesAndPerms(user.tenant_id, user.id);

    // Portal ↔ role eligibility (Master Context §3 rule #11, §5). The audience
    // is not just "whichever portal asked" — a VENDOR_USER may only obtain a
    // vendor-audience token, and only internal roles may obtain a buyer one.
    // Without this, a vendor could log in through the buyer portal and receive
    // a valid buyer token.
    if (!AuthService.isPortalAllowed(portal, roles)) {
      await this.auditAuth(user.tenant_id, user.id, 'auth.portal_denied', meta);
      throw new UnauthorizedException('This account cannot sign in to this portal');
    }

    const issue = {
      userId: user.id,
      tenantId: user.tenant_id,
      audience: portal,
      roles,
      perms,
    };
    const access = await this.tokens.issueAccess(issue);
    const refreshToken = await this.tokens.issueRefresh(issue);
    await this.persistSession(user.id, refreshToken, meta);
    await this.auditAuth(user.tenant_id, user.id, 'auth.login_success', meta);

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        roles,
        mfaEnabled: user.mfa_enabled,
      },
      tokens: {
        accessToken: access.token,
        refreshToken,
        tokenType: 'Bearer',
        expiresIn: access.expiresIn,
      },
    };
  }

  async refresh(refreshToken: string): Promise<LoginResponse['tokens']> {
    let payload;
    try {
      payload = await this.tokens.verify(refreshToken);
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (payload.type !== 'refresh')
      throw new UnauthorizedException('Not a refresh token');

    const hash = hashToken(refreshToken);
    const session = await this.prisma.session.findFirst({
      where: { refreshTokenHash: hash, userId: payload.sub, revokedAt: null },
    });
    if (!session || session.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token expired or revoked');
    }

    const { roles, perms } = await this.loadRolesAndPerms(payload.tid, payload.sub);

    // Re-check portal eligibility on every refresh (defense-in-depth): a token
    // issued for a portal the user is no longer entitled to — including a stale
    // buyer cookie held by a vendor user — is revoked rather than renewed.
    if (!AuthService.isPortalAllowed(payload.aud, roles)) {
      await this.prisma.session.update({
        where: { id: session.id },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException('This account cannot use this portal');
    }

    const issue = {
      userId: payload.sub,
      tenantId: payload.tid,
      audience: payload.aud,
      roles,
      perms,
    };
    const access = await this.tokens.issueAccess(issue);
    // Rotate refresh token.
    const newRefresh = await this.tokens.issueRefresh(issue);
    await this.prisma.session.update({
      where: { id: session.id },
      data: {
        refreshTokenHash: hashToken(newRefresh),
        expiresAt: addDaysUtc(new Date(), 7),
      },
    });

    return {
      accessToken: access.token,
      refreshToken: newRefresh,
      tokenType: 'Bearer',
      expiresIn: access.expiresIn,
    };
  }

  async logout(refreshToken: string): Promise<void> {
    const hash = hashToken(refreshToken);
    await this.prisma.session.updateMany({
      where: { refreshTokenHash: hash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // MFA routes are guarded, so the TenantInterceptor has already opened the
  // tenant transaction — use the ambient client (never nest $transaction).
  async setupMfa(
    userId: string,
    tenantId: string,
    email: string,
  ): Promise<{ provisioningUri: string; qrSvg: string }> {
    const secret = authenticator.generateSecret();
    const provisioningUri = authenticator.keyuri(email, 'ProcureFlow', secret);
    const qrSvg = await qrToString(provisioningUri, { type: 'svg' });
    await this.prisma.client.user.update({
      where: { id: userId },
      data: { mfaSecret: secret },
    });
    return { provisioningUri, qrSvg };
  }

  async verifyMfa(userId: string, tenantId: string, code: string): Promise<void> {
    const user = await this.prisma.client.user.findUnique({ where: { id: userId } });
    if (
      !user?.mfaSecret ||
      !authenticator.verify({ token: code, secret: user.mfaSecret })
    ) {
      throw new UnauthorizedException('Invalid MFA code');
    }
    await this.prisma.client.user.update({
      where: { id: userId },
      data: { mfaEnabled: true },
    });
    await this.audit.record({
      action: 'auth.mfa_enabled',
      entityType: 'User',
      entityId: userId,
      actorId: userId,
      tenantId,
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async findUserForAuth(email: string): Promise<AuthRow | null> {
    const rows = await this.prisma.$queryRaw<AuthRow[]>(
      Prisma.sql`SELECT * FROM auth_find_user(${email})`,
    );
    return rows[0] ?? null;
  }

  private async loadRolesAndPerms(
    tenantId: string,
    userId: string,
  ): Promise<{ roles: string[]; perms: string[] }> {
    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      const userRoles = await tx.userRole.findMany({
        where: { userId },
        include: { role: true },
      });
      const roles = userRoles.map((ur) => ur.role.name);
      const perms = new Set<string>();
      for (const role of roles) {
        for (const p of ROLE_PERMISSIONS[role as RoleName] ?? []) perms.add(p);
      }
      return { roles, perms: [...perms] };
    });
  }

  private async persistSession(
    userId: string,
    refreshToken: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.prisma.session.create({
      data: {
        id: newId('session'),
        userId,
        refreshTokenHash: hashToken(refreshToken),
        userAgent: meta.userAgent ?? null,
        ipAddress: meta.ipAddress ?? null,
        expiresAt: addDaysUtc(new Date(), 7),
      },
    });
  }

  private async auditAuth(
    tenantId: string,
    userId: string,
    action: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.prisma.runInTenantContext(tenantId, async () => {
      await this.audit.record({
        action,
        entityType: 'User',
        entityId: userId,
        actorId: userId,
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
        tenantId,
      });
    });
  }

  /**
   * A VENDOR_USER may sign in only on the vendor portal; any user holding an
   * internal (non-vendor) role may sign in on the buyer portal. A user with
   * both kinds of role could use either portal.
   */
  private static isPortalAllowed(portal: Portal, roles: string[]): boolean {
    const isVendorUser = roles.includes(ROLES.VENDOR_USER);
    if (portal === 'vendor') return isVendorUser;
    return roles.some((role) => role !== ROLES.VENDOR_USER);
  }

  private mfaChallengeResponse(user: AuthRow): LoginResponse {
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        roles: [],
        mfaEnabled: true,
      },
      tokens: { accessToken: '', refreshToken: '', tokenType: 'Bearer', expiresIn: 0 },
      mfaRequired: true,
    };
  }
}

/** Refresh tokens are stored only as a SHA-256 digest (never in plaintext). */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
