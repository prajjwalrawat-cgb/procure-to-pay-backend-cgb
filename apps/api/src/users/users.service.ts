import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';

import { newId } from '@procureflow/db';
import { ALL_ROLES, ROLES, type RoleName } from '@procureflow/shared';
import { hash as argonHash } from 'argon2';

import { AuditLogService } from '../audit/audit.service';
import { resolveEffectivePermissions } from '../auth/effective-permissions';
import { TokenService } from '../auth/token.service';
import { MailService } from '../common/mail/mail.service';
import type { Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';

/** Roles an admin may grant to an internal user. SYSADMIN is platform-internal
 *  and VENDOR_USER belongs to the vendor portal — neither is invitable here. */
export const INVITABLE_ROLES: RoleName[] = ALL_ROLES.filter(
  (r) => r !== ROLES.SYSADMIN && r !== ROLES.VENDOR_USER,
);

export interface CreateUserInput {
  email: string;
  name: string;
  password: string;
  roles: RoleName[];
}

export interface InviteUserInput {
  email: string;
  name: string;
  roles: RoleName[];
}

export interface UserProfile {
  id: string;
  email: string;
  name: string;
  roles: string[];
  mfaEnabled: boolean;
}

/** `/users/me` — the profile plus the caller's own organisation. The tenant
 *  travels with the session so no screen has to hardcode the org's name, and
 *  the effective permissions travel with it so the client hides exactly what
 *  the API would refuse — including authority the approval matrix confers. */
export interface MyProfile extends UserProfile {
  tenant: { id: string; name: string };
  perms: string[];
}

export interface TeamMember {
  id: string;
  email: string;
  name: string;
  roles: string[];
  isActive: boolean;
  createdAt: string;
}

export interface PendingInvite {
  id: string;
  email: string;
  name: string;
  roles: string[];
  invitedAt: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly tokens: TokenService,
    private readonly mail: MailService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Create a user in the current tenant context and audit it (§3 rules #2, #3). */
  async create(
    tenantId: string,
    input: CreateUserInput,
    actorId: string,
  ): Promise<UserProfile> {
    const argon = await argonHash(input.password, { type: 2 });
    const user = await this.prisma.client.user.create({
      data: {
        id: newId('user'),
        tenantId,
        email: input.email.toLowerCase(),
        name: input.name,
        argonHash: argon,
      },
    });

    for (const roleName of input.roles) {
      const role = await this.prisma.client.role.findUniqueOrThrow({
        where: { name: roleName },
      });
      await this.prisma.client.userRole.create({
        data: { id: newId('userRole'), tenantId, userId: user.id, roleId: role.id },
      });
    }

    await this.audit.record({
      action: 'user.created',
      entityType: 'User',
      entityId: user.id,
      actorId,
      after: { email: user.email, name: user.name, roles: input.roles },
    });

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      roles: input.roles,
      mfaEnabled: false,
    };
  }

  /** List internal users in the tenant (for the Team / Users admin page).
   *  Vendor-portal accounts (VENDOR_USER) are excluded — they belong to the
   *  vendor portal, not the internal team roster. */
  async list(tenantId: string): Promise<TeamMember[]> {
    const users = await this.prisma.client.user.findMany({
      where: {
        tenantId,
        isActive: true,
        userRoles: { none: { role: { name: ROLES.VENDOR_USER } } },
      },
      include: { userRoles: { include: { role: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      roles: u.userRoles.map((ur) => ur.role.name),
      isActive: u.isActive,
      createdAt: u.createdAt.toISOString(),
    }));
  }

  /** Pending (not-yet-accepted) invitations for the tenant. */
  async listPending(tenantId: string): Promise<PendingInvite[]> {
    const users = await this.prisma.client.user.findMany({
      where: {
        tenantId,
        isActive: false,
        invitedAt: { not: null },
        userRoles: { none: { role: { name: ROLES.VENDOR_USER } } },
      },
      include: { userRoles: { include: { role: true } } },
      orderBy: { invitedAt: 'desc' },
    });
    return users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      roles: u.userRoles.map((ur) => ur.role.name),
      invitedAt: (u.invitedAt ?? u.createdAt).toISOString(),
    }));
  }

  /**
   * Revoke a pending invitation: delete the (never-activated) placeholder user
   * so the emailed link stops working — accept-invite looks the user up by id
   * and now finds nothing. Only applies to genuine pending invites.
   */
  async revokeInvite(
    tenantId: string,
    invitedUserId: string,
    actorId: string,
  ): Promise<{ id: string }> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: invitedUserId },
    });
    if (!user || user.tenantId !== tenantId || user.isActive || user.invitedAt == null) {
      throw new NotFoundException('Pending invitation not found.');
    }
    await this.prisma.client.userRole.deleteMany({ where: { userId: invitedUserId } });
    await this.prisma.client.user.delete({ where: { id: invitedUserId } });
    await this.audit.record({
      action: 'user.invite_revoked',
      entityType: 'User',
      entityId: invitedUserId,
      actorId,
      after: { email: user.email },
    });
    return { id: invitedUserId };
  }

  /**
   * Invite an internal user: create the account inactive with an undisclosed
   * random password, assign roles, then email a magic set-password link. The
   * account cannot be used until the invitee accepts (login gates on isActive).
   */
  async invite(
    tenantId: string,
    input: InviteUserInput,
    actorId: string,
  ): Promise<UserProfile> {
    const invalid = input.roles.filter((r) => !INVITABLE_ROLES.includes(r));
    if (invalid.length > 0) {
      throw new BadRequestException(`Cannot assign role(s): ${invalid.join(', ')}`);
    }
    const email = input.email.toLowerCase();
    const existing = await this.prisma.client.user.findUnique({
      where: { tenantId_email: { tenantId, email } },
    });
    if (existing) {
      throw new BadRequestException('A user with this email already exists.');
    }
    await this.assertRoleIsGrantable(tenantId, input.roles, null);

    // Random, never-disclosed password — the emailed link is the only way in.
    const argon = await argonHash(randomBytes(24).toString('hex'), { type: 2 });
    const user = await this.prisma.client.user.create({
      data: {
        id: newId('user'),
        tenantId,
        email,
        name: input.name,
        argonHash: argon,
        isActive: false,
        invitedAt: new Date(),
      },
    });

    for (const roleName of input.roles) {
      const role = await this.prisma.client.role.findUniqueOrThrow({
        where: { name: roleName },
      });
      await this.prisma.client.userRole.create({
        data: { id: newId('userRole'), tenantId, userId: user.id, roleId: role.id },
      });
    }

    await this.audit.record({
      action: 'user.invited',
      entityType: 'User',
      entityId: user.id,
      actorId,
      after: { email, name: input.name, roles: input.roles },
    });

    const token = await this.tokens.issueUserInvite(user.id, tenantId);
    const tenant = await this.prisma.client.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });
    // Fire-and-forget: a real SMTP round-trip takes several seconds and would
    // otherwise exceed the request's 5s RLS transaction budget ("Transaction
    // already closed"). The account already exists and the link can be re-sent,
    // so a mail failure is non-fatal.
    this.dispatchInviteEmail(
      tenant?.name ?? 'your organisation',
      email,
      input.name,
      token,
    );

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      roles: input.roles,
      mfaEnabled: false,
    };
  }

  /**
   * Accept an invite from the emailed magic link: verify the token, set the
   * user's own password and activate the account. Public (no JWT) — the token
   * carries the tenant so we can open the correct RLS context.
   */
  async acceptInvite(token: string, password: string): Promise<{ email: string }> {
    let claims: { userId: string; tenantId: string };
    try {
      claims = await this.tokens.verifyUserInvite(token);
    } catch {
      throw new BadRequestException('This invitation link is invalid or has expired.');
    }

    return this.prisma.runInTenantContext(claims.tenantId, async () => {
      const user = await this.prisma.client.user.findUnique({
        where: { id: claims.userId },
      });
      if (!user || user.tenantId !== claims.tenantId) {
        throw new BadRequestException('No account for this invitation.');
      }
      const argon = await argonHash(password, { type: 2 });
      await this.prisma.client.user.update({
        where: { id: user.id },
        data: { argonHash: argon, isActive: true, invitedAt: null },
      });
      await this.audit.record({
        action: 'user.invite_accepted',
        entityType: 'User',
        entityId: user.id,
        actorId: user.id,
        after: { email: user.email },
        tenantId: claims.tenantId,
      });
      return { email: user.email };
    });
  }

  /**
   * A role an active approval rule routes to at *tenant* scope must have exactly
   * one holder: `ApproverResolver` refuses to pick between candidates, so a
   * second holder would break every submission of that document type with
   * "N candidates". Reject the grant here, where the admin can still understand
   * why — rather than at submit time, on someone else's requisition.
   *
   * Dept- and plant-scoped steps are exempt: the resolver narrows those by the
   * document's own department/plant, so one head per department is expected.
   */
  private async assertRoleIsGrantable(
    tenantId: string,
    roles: RoleName[],
    exceptUserId: string | null,
  ): Promise<void> {
    const matrices = await this.prisma.client.approvalMatrix.findMany({
      where: { tenantId, isActive: true },
      select: { name: true, steps: true },
    });
    const routedBy = new Map<string, string>();
    for (const m of matrices) {
      const steps = (m.steps ?? []) as unknown as { role?: string; scope?: string }[];
      for (const step of steps) {
        if (step.scope === 'tenant' && step.role && !routedBy.has(step.role)) {
          routedBy.set(step.role, m.name);
        }
      }
    }

    for (const roleName of roles) {
      const rule = routedBy.get(roleName);
      if (!rule) continue;
      const others = await this.prisma.client.userRole.count({
        where: {
          tenantId,
          role: { name: roleName },
          ...(exceptUserId ? { userId: { not: exceptUserId } } : {}),
        },
      });
      if (others > 0) {
        throw new BadRequestException(
          `Someone already holds ${roleName}, and the approval rule “${rule}” routes to it. ` +
            'A role used by an approval rule must have exactly one holder, otherwise ' +
            'approvals cannot be assigned. Point that rule at a different role first, ' +
            'or move this role off the current holder.',
        );
      }
    }
  }

  /**
   * Replace a user's roles (inline role change from the Team page). Rejects
   * non-internal roles and refuses to strip the last active admin of admin.
   */
  async updateRoles(
    tenantId: string,
    targetUserId: string,
    roles: RoleName[],
    actorId: string,
  ): Promise<TeamMember> {
    const invalid = roles.filter((r) => !INVITABLE_ROLES.includes(r));
    if (invalid.length > 0) {
      throw new BadRequestException(`Cannot assign role(s): ${invalid.join(', ')}`);
    }
    const target = await this.prisma.client.user.findUnique({
      where: { id: targetUserId },
      include: { userRoles: { include: { role: true } } },
    });
    if (!target || target.tenantId !== tenantId) {
      throw new NotFoundException('User not found.');
    }

    // Don't let the last active admin lose the admin role.
    const wasAdmin = target.userRoles.some((ur) => ur.role.name === ROLES.TENANT_ADMIN);
    const willBeAdmin = roles.includes(ROLES.TENANT_ADMIN);
    if (wasAdmin && !willBeAdmin) {
      const activeAdmins = await this.prisma.client.user.count({
        where: {
          tenantId,
          isActive: true,
          userRoles: { some: { role: { name: ROLES.TENANT_ADMIN } } },
        },
      });
      if (activeAdmins <= 1) {
        throw new ForbiddenException('Cannot remove admin from the last active admin.');
      }
    }

    await this.assertRoleIsGrantable(tenantId, roles, targetUserId);

    await this.prisma.client.userRole.deleteMany({ where: { userId: targetUserId } });
    for (const roleName of roles) {
      const role = await this.prisma.client.role.findUniqueOrThrow({
        where: { name: roleName },
      });
      await this.prisma.client.userRole.create({
        data: { id: newId('userRole'), tenantId, userId: targetUserId, roleId: role.id },
      });
    }

    await this.audit.record({
      action: 'user.roles_updated',
      entityType: 'User',
      entityId: targetUserId,
      actorId,
      before: { roles: target.userRoles.map((ur) => ur.role.name) },
      after: { roles },
    });

    return {
      id: target.id,
      email: target.email,
      name: target.name,
      roles,
      isActive: target.isActive,
      createdAt: target.createdAt.toISOString(),
    };
  }

  /**
   * Deactivate a user (soft remove). Login gates on isActive, so this revokes
   * access without destroying audit history. Guards against removing yourself
   * or the last active admin.
   */
  async deactivate(
    tenantId: string,
    targetUserId: string,
    actorId: string,
  ): Promise<{ id: string }> {
    if (targetUserId === actorId) {
      throw new BadRequestException('You cannot remove your own account.');
    }
    const target = await this.prisma.client.user.findUnique({
      where: { id: targetUserId },
      include: { userRoles: { include: { role: true } } },
    });
    if (!target || target.tenantId !== tenantId) {
      throw new NotFoundException('User not found.');
    }

    const isAdmin = target.userRoles.some((ur) => ur.role.name === ROLES.TENANT_ADMIN);
    if (isAdmin) {
      const activeAdmins = await this.prisma.client.user.count({
        where: {
          tenantId,
          isActive: true,
          userRoles: { some: { role: { name: ROLES.TENANT_ADMIN } } },
        },
      });
      if (activeAdmins <= 1) {
        throw new ForbiddenException('Cannot remove the last active admin.');
      }
    }

    await this.prisma.client.user.update({
      where: { id: targetUserId },
      data: { isActive: false },
    });
    await this.audit.record({
      action: 'user.deactivated',
      entityType: 'User',
      entityId: targetUserId,
      actorId,
      after: { isActive: false },
    });
    return { id: targetUserId };
  }

  async findProfile(userId: string): Promise<MyProfile> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      include: {
        userRoles: { include: { role: true } },
        tenant: { select: { id: true, name: true } },
      },
    });
    if (!user) throw new NotFoundException('User not found');
    const roles = user.userRoles.map((ur) => ur.role.name);
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      roles,
      // Resolved the same way the JWT's `perms` are (auth.service), so the
      // session the app bootstraps from /users/me gates its controls on exactly
      // what the guards will accept.
      perms: await resolveEffectivePermissions(this.prisma.client, roles),
      mfaEnabled: user.mfaEnabled,
      tenant: { id: user.tenant.id, name: user.tenant.name },
    };
  }

  /** Build the set-password magic link and send it WITHOUT awaiting, so the
   *  multi-second SMTP round-trip runs after the request's RLS transaction has
   *  committed. Never throws into the invite flow — a mail failure is logged
   *  and the invite can be re-sent. */
  private dispatchInviteEmail(
    orgName: string,
    email: string,
    name: string,
    token: string,
  ): void {
    const base = this.config.get('APP_BASE_URL', { infer: true });
    const link = `${base}/accept-invite?token=${encodeURIComponent(token)}`;
    const subject = `You've been invited to join ${orgName} on ProcureFlow`;
    const text =
      `Hello ${name},\n\n` +
      `${orgName} has invited you to join their ProcureFlow workspace.\n\n` +
      `Set your password to activate your account (link valid for 7 days):\n` +
      `${link}\n\n` +
      `If you weren't expecting this, you can ignore this email.`;
    const html =
      `<p>Hello ${escapeHtml(name)},</p>` +
      `<p><strong>${escapeHtml(orgName)}</strong> has invited you to join their ` +
      `ProcureFlow workspace.</p>` +
      `<p><a href="${link}">Set your password and activate your account</a> ` +
      `(link valid for 7 days).</p>` +
      `<p>If you weren't expecting this, you can ignore this email.</p>`;
    void this.mail
      .send({ to: email, subject, html, text })
      .catch((err: unknown) =>
        this.logger.warn(
          `Invite email to ${email} failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  }
}
