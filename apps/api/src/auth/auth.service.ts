import { createHash } from 'node:crypto';

import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
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
  type SessionTenant,
} from '@procureflow/shared';
import { hash as argonHash, verify as argonVerify } from 'argon2';
import { authenticator } from 'otplib';
import { toString as qrToString } from 'qrcode';

import { AuditLogService } from '../audit/audit.service';
import { MailService } from '../common/mail/mail.service';
import type { Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { TokenService, passwordFingerprint } from './token.service';

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
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly audit: AuditLogService,
    private readonly config: ConfigService<Env, true>,
    private readonly mail: MailService,
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
        tenant: await this.loadTenant(user.tenant_id),
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

  /**
   * Start a password reset. Resolves the same way for every address — sent,
   * unknown, inactive, or wrong portal — so this cannot be used to find out who
   * holds an account. The mail goes out unawaited (an SMTP round-trip takes
   * seconds and must not hold the request open, exactly as invites do).
   */
  async requestPasswordReset(
    email: string,
    portal: Portal,
    meta: RequestMeta,
  ): Promise<void> {
    const user = await this.findUserForAuth(email);
    if (!user || !user.is_active) return;

    // A vendor asking on the buyer page (or vice versa) gets no link: the reset
    // would land them on a portal their account cannot sign in to.
    const { roles } = await this.loadRolesAndPerms(user.tenant_id, user.id);
    if (!AuthService.isPortalAllowed(portal, roles)) return;

    const token = await this.tokens.issuePasswordReset({
      userId: user.id,
      tenantId: user.tenant_id,
      portal,
      passwordHash: user.argon_hash,
    });
    await this.auditAuth(user.tenant_id, user.id, 'auth.password_reset_requested', meta);
    this.dispatchResetEmail(user.email, user.name, portal, token);
  }

  /**
   * Finish a password reset. The token's fingerprint must still match the stored
   * hash, which makes a link single-use and kills any older outstanding links.
   * Every existing session is revoked: if the reset was prompted by someone else
   * having the old password, this is what actually removes their access.
   */
  async resetPassword(token: string, password: string): Promise<{ email: string }> {
    let claims;
    try {
      claims = await this.tokens.verifyPasswordReset(token);
    } catch {
      throw new BadRequestException('This reset link is invalid or has expired.');
    }

    // Reads of User are RLS-scoped, so open the tenant context the token names —
    // the same shape the public accept-invite endpoint uses.
    return this.prisma.runInTenantContext(claims.tenantId, async (tx) => {
      const user = await tx.user.findUnique({ where: { id: claims.userId } });
      if (!user || user.tenantId !== claims.tenantId || !user.isActive) {
        throw new BadRequestException('This reset link is invalid or has expired.');
      }
      if (passwordFingerprint(user.argonHash) !== claims.passwordFingerprint) {
        throw new BadRequestException(
          'This reset link has already been used. Request a new one.',
        );
      }

      const argon = await argonHash(password, { type: 2 /* argon2id */ });
      await tx.user.update({ where: { id: user.id }, data: { argonHash: argon } });
      await tx.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit.record({
        action: 'auth.password_reset',
        entityType: 'User',
        entityId: user.id,
        actorId: user.id,
        tenantId: user.tenantId,
      });
      return { email: user.email };
    });
  }

  /** Build the reset link and send it WITHOUT awaiting — the SMTP round-trip
   *  must not hold the request open, and a mail failure must not turn into a
   *  response that reveals whether the address exists. */
  private dispatchResetEmail(
    email: string,
    name: string,
    portal: Portal,
    token: string,
  ): void {
    const base = this.config.get('APP_BASE_URL', { infer: true });
    // The vendor portal is the same app under /vendor (one Next.js deployment).
    const path = portal === 'vendor' ? '/vendor/reset-password' : '/reset-password';
    const link = `${base}${path}?token=${encodeURIComponent(token)}`;
    const subject = 'Reset your ProcureFlow password';
    const text =
      `Hello ${name},\n\n` +
      `We received a request to reset your ProcureFlow password.\n\n` +
      `Choose a new password (link valid for 1 hour):\n${link}\n\n` +
      `If you didn't ask for this, ignore this email — your password stays as it is.`;
    const html =
      `<p>Hello ${escapeHtml(name)},</p>` +
      `<p>We received a request to reset your ProcureFlow password.</p>` +
      `<p><a href="${link}">Choose a new password</a> (link valid for 1 hour).</p>` +
      `<p>If you didn't ask for this, ignore this email — your password stays as ` +
      `it is.</p>`;
    void this.mail
      .send({ to: email, subject, html, text })
      .catch((err: unknown) =>
        this.logger.warn(
          `Password reset email to ${email} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
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

  /** The user's own organisation, for screens that display the buying org's
   *  name. `Tenant` carries no RLS policy (it is the anchor every policy keys
   *  off), so this is readable before a tenant context is established. */
  private async loadTenant(tenantId: string): Promise<SessionTenant> {
    const tenant = await this.prisma.client.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true },
    });
    return tenant ?? { id: tenantId, name: '' };
  }

  private async mfaChallengeResponse(user: AuthRow): Promise<LoginResponse> {
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        roles: [],
        mfaEnabled: true,
        tenant: await this.loadTenant(user.tenant_id),
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

/** The recipient's own name goes into the reset email's HTML body. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
