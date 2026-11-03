import crypto from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InvoiceStatus, PoStatus, Prisma, RequisitionStatus } from '@procureflow/db';
import { PERMISSIONS, ROLES } from '@procureflow/shared';

import { ApprovalRoutingService } from '../../approvals/approval-routing.service';
import { InboxService } from '../../approvals/inbox.service';
import { AuditLogService } from '../../audit/audit.service';
import { AuthService } from '../../auth/auth.service';
import { resolveEffectivePermissions } from '../../auth/effective-permissions';
import { PrismaService } from '../../prisma/prisma.service';
import { statusOf } from './askmira.status';
import {
  BRAND,
  EMAIL_RE,
  PKCE_RE,
  PRODUCT,
  UUID_RE,
  answersChallenge,
  clean,
  deriveSecret,
  normEmail,
  peek,
  safeEqual,
  sha256hex,
  verify,
  type Claims,
  type Use,
} from './askmira.tokens';

/**
 * The link with AskMira, the HRMS a company may run its people in.
 *
 * An admin of a tenant here connects it to one AskMira workspace ("Sign in
 * with…"-style: AskMira's admin presses Connect there, a TENANT_ADMIN here
 * presses Allow at /connect/askmira). From then on AskMira's server calls here
 * for that tenant only, each call signed with the connection's own secret:
 *
 *   POST integrations/askmira/users/sync      use=provision  the company's people
 *   POST integrations/askmira/query           use=query      read for one person
 *   POST integrations/askmira/act             use=act        decide an approval
 *   POST integrations/askmira/connect/token   AskMira swaps the one-time code (PKCE)
 *   POST integrations/askmira/connect/revoke  use=revoke     AskMira disconnected
 *   POST integrations/askmira/launch          use=launch     sign a person in
 *
 * Roles are this tenant's own. AskMira never adds anyone and never grants a
 * role: the sync links the people ProcureFlow's admins invited (by email) and
 * switches off the ones AskMira says have left. Every read and write runs in
 * the tenant's context, as the person, with their own permissions.
 */

export interface Linked {
  tenantId: string;
  tenantName: string;
  askmiraTenantId: string;
  askmiraName: string | null;
  secretNonce: string;
}

export interface Person {
  userId: string;
  tenantId: string;
  email: string;
  name: string;
  roles: string[];
  perms: string[];
}

export interface Admin {
  userId: string;
  tenantId: string;
  roles: string[];
}

const CODE_LIFETIME_MS = 5 * 60 * 1000;
const CALLBACK_PATH = '/settings/connectors/callback';
const LIMIT = 25;

function serverKey(): string {
  const own = process.env.ASKMIRA_LINK_SECRET ?? '';
  if (own.length >= 32) return own;
  // The API's own signing key is a secret only this server holds.
  const jwt = process.env.JWT_PRIVATE_KEY_BASE64 ?? '';
  return jwt ? sha256hex(`askmira:${jwt}`) : '';
}

export function canConnect(): boolean {
  return serverKey().length >= 32;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function money(value: Prisma.Decimal | string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return new Prisma.Decimal(value).toFixed(2);
}

function limitOf(params: Record<string, unknown>): number {
  const n = Number(params.limit);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), 50) : LIMIT;
}

function searchOf(params: Record<string, unknown>): string | null {
  return clean(params.query, 100);
}

@Injectable()
export class AskmiraService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly auth: AuthService,
    private readonly inbox: InboxService,
    private readonly routing: ApprovalRoutingService,
  ) {}

  // ── The connection ──────────────────────────────────────────────────────

  /** The tenant an AskMira workspace is connected to, or null (before any context). */
  async linkedTo(askmiraTenantId: string): Promise<Linked | null> {
    if (!UUID_RE.test(askmiraTenantId)) return null;
    let rows: Array<{
      tenant_id: string;
      askmira_tenant_id: string;
      askmira_name: string | null;
      secret_nonce: string;
      tenant_name: string;
    }>;
    try {
      rows = await this.prisma.$queryRaw`SELECT * FROM askmira_find_link(${askmiraTenantId.toLowerCase()}::uuid)`;
    } catch {
      // Before the migration and security:apply have run: nothing is connected.
      return null;
    }
    const row = rows[0];
    if (!row) return null;
    return {
      tenantId: row.tenant_id,
      tenantName: row.tenant_name,
      askmiraTenantId: row.askmira_tenant_id,
      askmiraName: row.askmira_name,
      secretNonce: row.secret_nonce,
    };
  }

  /**
   * A token's claims, checked with the secret of the AskMira workspace it
   * names, so one workspace's secret can never act for another. A workspace
   * that is not connected gets a 404, as if these endpoints did not exist.
   */
  async claimsOf(token: string, use: Use): Promise<{ found: Linked; claims: Claims }> {
    const unverified = peek(token);
    const askmiraTenantId = String((use === 'launch' ? unverified?.tid : unverified?.sub) ?? '');
    const found = canConnect() ? await this.linkedTo(askmiraTenantId) : null;
    if (!found) throw new NotFoundException('Not found');
    const claims = verify(token, deriveSecret(serverKey(), found.tenantId, found.secretNonce));
    if (!claims) throw new UnauthorizedException('This AskMira link is not valid or has expired.');
    if (claims.use !== use) throw new UnauthorizedException('This AskMira link is not valid here.');
    return { found, claims };
  }

  /** AskMira's server-to-server call: the token, bound to this exact body and workspace. */
  async assertion(
    raw: Buffer | undefined,
    authorization: string | undefined,
    use: Exclude<Use, 'launch'>,
  ): Promise<{ found: Linked; claims: Claims; body: Record<string, unknown> }> {
    if (!raw) throw new BadRequestException('The request has no body.');
    let body: Record<string, unknown>;
    try {
      body = obj(JSON.parse(raw.toString('utf8')));
    } catch {
      throw new BadRequestException('The request is not JSON.');
    }
    const match = /^Bearer\s+(.+)$/i.exec(authorization ?? '');
    if (!match) throw new UnauthorizedException('Missing AskMira assertion.');
    const { found, claims } = await this.claimsOf(match[1]!.trim(), use);
    if (!safeEqual(String(claims.bh ?? ''), sha256hex(raw))) {
      throw new UnauthorizedException('The assertion does not match this request.');
    }
    if (String(body.tenant_id ?? '').toLowerCase() !== String(claims.sub).toLowerCase()) {
      throw new UnauthorizedException('The assertion is for another workspace.');
    }
    return { found, claims, body };
  }

  /** An action or a sign-in link works once: a second use of its `jti` is refused. */
  async spendOnce(claims: Claims, refusal: string): Promise<void> {
    if (typeof claims.jti !== 'string' || !claims.jti || typeof claims.exp !== 'number') {
      throw new UnauthorizedException(refusal);
    }
    await this.prisma.askmiraUsedToken.deleteMany({
      where: { expiresAt: { lt: new Date(Date.now() - 5 * 60 * 1000) } },
    });
    try {
      await this.prisma.askmiraUsedToken.create({
        data: { jti: claims.jti.slice(0, 64), expiresAt: new Date(claims.exp * 1000) },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new UnauthorizedException(refusal);
      }
      throw err;
    }
  }

  /**
   * The person AskMira is asking for, if they are an active user of the
   * connected tenant. Their roles and permissions are this tenant's own.
   */
  async actorIn(found: Linked, actor: unknown): Promise<Person> {
    const email = normEmail(obj(actor).email);
    const refusal = new ForbiddenException(
      `You don't have a ${BRAND} account at ${found.tenantName} yet. Ask your procurement admin to invite you.`,
    );
    if (!EMAIL_RE.test(email)) throw refusal;
    return this.prisma.runInTenantContext(found.tenantId, async (tx) => {
      const user = await tx.user.findFirst({
        where: { tenantId: found.tenantId, email: { equals: email, mode: 'insensitive' } },
        include: { userRoles: { include: { role: true } } },
      });
      if (!user) throw refusal;
      if (!user.isActive) {
        throw new ForbiddenException(`Your ${BRAND} account at ${found.tenantName} is switched off.`);
      }
      const roles = user.userRoles.map((ur) => ur.role.name);
      if (roles.length === 0 || roles.every((r) => r === ROLES.VENDOR_USER)) throw refusal;
      const managed = await tx.askmiraPerson.findUnique({
        where: { tenantId_userId: { tenantId: found.tenantId, userId: user.id } },
      });
      if (managed?.deactivatedAt) {
        throw new ForbiddenException(`Your ${BRAND} account at ${found.tenantName} is switched off.`);
      }
      const perms = await resolveEffectivePermissions(tx, roles);
      return { userId: user.id, tenantId: found.tenantId, email: user.email, name: user.name, roles, perms };
    });
  }

  private actorOf(me: Person) {
    const can = (p: string) => me.perms.includes(p);
    return {
      name: me.name,
      roles: me.roles,
      can_decide_approvals: can(PERMISSIONS.APPROVAL_DECIDE),
      can_read_all_requisitions: can(PERMISSIONS.REQUISITION_READ_TENANT),
      can_read_purchase_orders: can(PERMISSIONS.PURCHASE_ORDER_READ_TENANT),
      can_read_invoices: can(PERMISSIONS.INVOICE_READ_TENANT),
      can_read_budgets: can(PERMISSIONS.BUDGET_READ),
    };
  }

  // ── Connecting (Allow, by a signed-in TENANT_ADMIN) ─────────────────────

  private requireAdmin(admin: Admin): void {
    if (!admin.roles.includes(ROLES.TENANT_ADMIN)) {
      throw new ForbiddenException(`Only a ${BRAND} admin connects this company to AskMira.`);
    }
  }

  private callback(redirectUri: unknown): URL {
    let url: URL;
    try {
      url = new URL(String(redirectUri ?? ''));
    } catch {
      throw new UnprocessableEntityException('That is not an AskMira connect link.');
    }
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      (url.protocol === 'http:' && !local) ||
      url.pathname.replace(/\/+$/, '') !== CALLBACK_PATH ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) {
      throw new UnprocessableEntityException('That is not an AskMira connect link.');
    }
    const allowed = String(process.env.ASKMIRA_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim().replace(/\/+$/, ''))
      .filter(Boolean);
    if (allowed.length && !allowed.includes(url.origin)) {
      throw new ForbiddenException(`This AskMira is not one ${BRAND} connects to.`);
    }
    return url;
  }

  async connection(admin: Admin) {
    this.requireAdmin(admin);
    return this.prisma.runInTenantContext(admin.tenantId, async (tx) => {
      const [tenant, link] = await Promise.all([
        tx.tenant.findUnique({ where: { id: admin.tenantId }, select: { name: true } }),
        tx.askmiraLink.findUnique({ where: { tenantId: admin.tenantId } }),
      ]);
      return {
        can_connect: canConnect(),
        workspace: { id: admin.tenantId, name: tenant?.name ?? '' },
        connected: Boolean(link),
        askmira_workspace_id: link?.askmiraTenantId ?? null,
        askmira_workspace: link?.askmiraName ?? null,
        askmira_origin: link?.askmiraOrigin ?? null,
        connected_at: link?.connectedAt.toISOString() ?? null,
      };
    });
  }

  async approve(admin: Admin, body: Record<string, unknown>) {
    this.requireAdmin(admin);
    if (!canConnect()) {
      throw new ConflictException('Set ASKMIRA_LINK_SECRET (at least 32 characters) on this server first.');
    }
    const askmiraTenantId = String(body.tenant_id ?? '').toLowerCase();
    const challenge = String(body.challenge ?? '');
    const state = String(body.state ?? '');
    const name = clean(body.tenant_name);
    if (!UUID_RE.test(askmiraTenantId) || !PKCE_RE.test(challenge) || !state || state.length > 4000 || !name) {
      throw new UnprocessableEntityException('That is not an AskMira connect link.');
    }
    const callback = this.callback(body.redirect_uri);
    const elsewhere = await this.linkedTo(askmiraTenantId);
    if (elsewhere && elsewhere.tenantId !== admin.tenantId) {
      throw new ConflictException(`That AskMira workspace is already connected to another company in ${BRAND}.`);
    }
    const code = crypto.randomBytes(32).toString('base64url');
    await this.prisma.runInTenantContext(admin.tenantId, async (tx) => {
      const mine = await tx.askmiraLink.findUnique({ where: { tenantId: admin.tenantId } });
      if (mine && mine.askmiraTenantId !== askmiraTenantId) {
        throw new ConflictException(
          'This company is already connected to another AskMira workspace. Disconnect it first.',
        );
      }
      await tx.askmiraConnectCode.deleteMany({ where: { expiresAt: { lt: new Date() } } });
      await tx.askmiraConnectCode.create({
        data: {
          codeHash: sha256hex(code),
          tenantId: admin.tenantId,
          askmiraTenantId,
          askmiraName: name,
          askmiraOrigin: callback.origin,
          challenge,
          approvedBy: admin.userId,
          expiresAt: new Date(Date.now() + CODE_LIFETIME_MS),
        },
      });
      await this.audit.record({
        action: 'askmira.connect_approved',
        entityType: 'AskmiraLink',
        entityId: admin.tenantId,
        actorId: admin.userId,
        after: { askmira_tenant_id: askmiraTenantId, askmira_name: name, origin: callback.origin },
      });
    });
    const query = new URLSearchParams({ code, state, product: PRODUCT });
    return { redirect_to: `${callback.origin}${CALLBACK_PATH}?${query.toString()}` };
  }

  /** AskMira's server swaps the code, and the verifier only it holds, for the secret. */
  async swap(body: Record<string, unknown>) {
    const code = String(body.code ?? '');
    const verifier = String(body.verifier ?? '');
    const askmiraTenantId = String(body.tenant_id ?? '').toLowerCase();
    const refused = new BadRequestException('This connect code is not valid or has expired.');
    if (!code || code.length > 200 || !PKCE_RE.test(verifier)) throw refused;
    let rows: Array<{
      tenant_id: string;
      askmira_tenant_id: string;
      askmira_name: string | null;
      askmira_origin: string;
      challenge: string;
      approved_by: string;
    }>;
    try {
      // One use, whatever happens next.
      rows = await this.prisma.$queryRaw`SELECT * FROM askmira_take_code(${sha256hex(code)})`;
    } catch {
      throw refused;
    }
    const row = rows[0];
    if (!row || row.askmira_tenant_id !== askmiraTenantId || !answersChallenge(verifier, row.challenge)) {
      throw refused;
    }
    const elsewhere = await this.linkedTo(askmiraTenantId);
    if (elsewhere && elsewhere.tenantId !== row.tenant_id) {
      throw new ConflictException(`That AskMira workspace is already connected to another company in ${BRAND}.`);
    }
    const nonce = crypto.randomBytes(32).toString('base64url');
    const tenantName = await this.prisma.runInTenantContext(row.tenant_id, async (tx) => {
      const mine = await tx.askmiraLink.findUnique({ where: { tenantId: row.tenant_id } });
      if (mine && mine.askmiraTenantId !== askmiraTenantId) {
        throw new ConflictException('This company is already connected to another AskMira workspace.');
      }
      await tx.askmiraLink.upsert({
        where: { tenantId: row.tenant_id },
        create: {
          tenantId: row.tenant_id,
          askmiraTenantId,
          askmiraName: row.askmira_name,
          askmiraOrigin: row.askmira_origin,
          secretNonce: nonce,
          connectedBy: row.approved_by,
        },
        update: {
          askmiraName: row.askmira_name,
          askmiraOrigin: row.askmira_origin,
          secretNonce: nonce,
          connectedBy: row.approved_by,
          connectedAt: new Date(),
        },
      });
      await this.audit.record({
        action: 'askmira.connected',
        entityType: 'AskmiraLink',
        entityId: row.tenant_id,
        actorId: row.approved_by,
        after: { askmira_tenant_id: askmiraTenantId, askmira_name: row.askmira_name },
      });
      const tenant = await tx.tenant.findUnique({ where: { id: row.tenant_id }, select: { name: true } });
      return tenant?.name ?? '';
    });
    return {
      product: PRODUCT,
      brand: BRAND,
      secret: deriveSecret(serverKey(), row.tenant_id, nonce),
      external_ref: row.tenant_id,
      organization: tenantName,
    };
  }

  /** AskMira disconnected: forget this workspace's secret here too. */
  async revoke(found: Linked) {
    await this.prisma.runInTenantContext(found.tenantId, async (tx) => {
      await tx.askmiraLink.deleteMany({ where: { tenantId: found.tenantId } });
      await this.audit.record({
        action: 'askmira.disconnected',
        entityType: 'AskmiraLink',
        entityId: found.tenantId,
        actorType: 'SYSTEM',
        after: { by: 'askmira' },
      });
    });
    return { disconnected: true };
  }

  /** Disconnect from this side: AskMira's secret for this company stops working at once. */
  async disconnect(admin: Admin) {
    this.requireAdmin(admin);
    await this.prisma.runInTenantContext(admin.tenantId, async (tx) => {
      await tx.askmiraLink.deleteMany({ where: { tenantId: admin.tenantId } });
      await this.audit.record({
        action: 'askmira.disconnected',
        entityType: 'AskmiraLink',
        entityId: admin.tenantId,
        actorId: admin.userId,
        after: { by: 'procureflow' },
      });
    });
    return this.connection(admin);
  }

  // ── People (users/sync) ─────────────────────────────────────────────────

  /**
   * Links each active user here whose email is in AskMira's list, and switches
   * off a user AskMira linked once who has since left the company in AskMira.
   * Nobody is created and no role changes. A TENANT_ADMIN is never switched off
   * from here (it could lock the company out); the answer says so instead.
   */
  async syncPeople(found: Linked, body: Record<string, unknown>) {
    const list = Array.isArray(body.users) ? body.users : null;
    if (!list || list.length === 0) {
      throw new UnprocessableEntityException('AskMira sent nobody. Nothing was changed.');
    }
    const roster = new Map<string, string | null>();
    for (const raw of list) {
      const item = obj(raw);
      const email = normEmail(item.email);
      if (EMAIL_RE.test(email)) roster.set(email, clean(item.id, 64));
    }
    if (roster.size === 0) {
      throw new UnprocessableEntityException('AskMira sent nobody with an email. Nothing was changed.');
    }
    return this.prisma.runInTenantContext(
      found.tenantId,
      async (tx) => {
        const users = await tx.user.findMany({
          where: { tenantId: found.tenantId },
          include: { userRoles: { include: { role: true } } },
        });
        const managed = new Map(
          (await tx.askmiraPerson.findMany({ where: { tenantId: found.tenantId } })).map((p) => [p.userId, p]),
        );
        let linked = 0;
        let deactivated = 0;
        let restored = 0;
        const keptAdmins: string[] = [];
        const members: Array<{ email: string; role: string; roles: string[] }> = [];
        const known = new Set<string>();
        const now = new Date();
        for (const user of users) {
          const roles = user.userRoles.map((ur) => ur.role.name);
          if (roles.length === 0 || roles.every((r) => r === ROLES.VENDOR_USER)) continue;
          const email = normEmail(user.email);
          known.add(email);
          const row = managed.get(user.id);
          if (roster.has(email)) {
            await tx.askmiraPerson.upsert({
              where: { tenantId_userId: { tenantId: found.tenantId, userId: user.id } },
              create: { tenantId: found.tenantId, userId: user.id, askmiraUserId: roster.get(email) },
              update: { askmiraUserId: roster.get(email), deactivatedAt: null },
            });
            if (!row) linked += 1;
            let active = user.isActive;
            // Only AskMira's own switch-off is undone here, never one made in ProcureFlow.
            if (row?.deactivatedAt && !user.isActive) {
              await tx.user.update({ where: { id: user.id }, data: { isActive: true } });
              await this.audit.record({
                action: 'user.reactivated',
                entityType: 'User',
                entityId: user.id,
                actorType: 'SYSTEM',
                after: { isActive: true, via: 'askmira' },
              });
              active = true;
              restored += 1;
            }
            if (active) members.push({ email, role: roles.join(','), roles });
            continue;
          }
          if (!row || row.deactivatedAt || !user.isActive) continue;
          if (roles.includes(ROLES.TENANT_ADMIN) || roles.includes(ROLES.SYSADMIN)) {
            keptAdmins.push(email);
            continue;
          }
          await tx.user.update({ where: { id: user.id }, data: { isActive: false } });
          await tx.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now } });
          await tx.askmiraPerson.update({
            where: { tenantId_userId: { tenantId: found.tenantId, userId: user.id } },
            data: { deactivatedAt: now },
          });
          await this.audit.record({
            action: 'user.deactivated',
            entityType: 'User',
            entityId: user.id,
            actorType: 'SYSTEM',
            after: { isActive: false, via: 'askmira', reason: 'left the company in AskMira' },
          });
          deactivated += 1;
        }
        const outsiders = [...roster.keys()].filter((e) => !known.has(e));
        return {
          created: 0,
          updated: linked + restored,
          deactivated,
          restored,
          not_members: outsiders.length,
          skipped: [
            ...keptAdmins.map((email) => ({
              email,
              reason: `Left the company in AskMira but is a ${BRAND} admin: switch them off in ${BRAND} yourself.`,
            })),
            ...outsiders.slice(0, 20).map((email) => ({
              email,
              reason: `No ${BRAND} account at ${found.tenantName}; an admin there invites them.`,
            })),
          ],
          members,
        };
      },
      { timeout: 30_000 },
    );
  }

  // ── Reading for one person (query) ──────────────────────────────────────

  async query(found: Linked, me: Person, kind: string, params: Record<string, unknown>) {
    const run = async (): Promise<Record<string, unknown>> => {
      switch (kind) {
        case 'overview':
          return this.overview(me);
        case 'approvals':
          return this.approvals(me);
        case 'requisitions':
          return this.requisitions(me, params);
        case 'purchase_orders':
          return this.purchaseOrders(me, params);
        case 'invoices':
          return this.invoices(me, params);
        case 'budgets':
          return this.budgets(me);
        default:
          throw new UnprocessableEntityException('Unknown query.');
      }
    };
    const answer = await this.prisma.runInTenantContext(found.tenantId, run);
    return { kind, actor: this.actorOf(me), ...answer };
  }

  private need(me: Person, perm: string, what: string): void {
    if (!me.perms.includes(perm)) {
      throw new ForbiddenException(`Your ${BRAND} role does not let you see ${what}.`);
    }
  }

  private async overview(me: Person) {
    const db = this.prisma.client;
    const all = me.perms.includes(PERMISSIONS.REQUISITION_READ_TENANT);
    const [waiting, mine, pos, invoices] = await Promise.all([
      db.approval.count({ where: { approverId: me.userId, decision: 'PENDING' } }),
      db.requisition.groupBy({
        by: ['status'],
        where: all ? {} : { requesterId: me.userId },
        _count: { _all: true },
      }),
      me.perms.includes(PERMISSIONS.PURCHASE_ORDER_READ_TENANT)
        ? db.purchaseOrder.groupBy({ by: ['status'], _count: { _all: true } })
        : Promise.resolve(null),
      me.perms.includes(PERMISSIONS.INVOICE_READ_TENANT)
        ? db.invoice.groupBy({ by: ['status'], _count: { _all: true } })
        : Promise.resolve(null),
    ]);
    const counts = (rows: Array<{ status: string; _count: { _all: number } }> | null) =>
      rows ? Object.fromEntries(rows.map((r) => [r.status, r._count._all])) : null;
    return {
      waiting_on_me: waiting,
      requisitions_scope: all ? 'company' : 'mine',
      requisitions: counts(mine),
      purchase_orders: counts(pos),
      invoices: counts(invoices),
    };
  }

  private async approvals(me: Person) {
    this.need(me, PERMISSIONS.APPROVAL_READ, 'approvals');
    const answer = await this.inbox.list(me.userId, 'waiting_on_me');
    return {
      total: answer.counts.waiting_on_me,
      approvals: answer.items.slice(0, 50).map((item) => ({
        ref: item.approvalId,
        document: item.documentType,
        number: item.number,
        title: item.title,
        submitted_by: item.submitterName,
        amount: item.amount,
        currency: item.currency,
        days_pending: item.daysPending,
        sla: item.slaStatus,
        href: item.href,
      })),
    };
  }

  private async requisitions(me: Person, params: Record<string, unknown>) {
    const all = me.perms.includes(PERMISSIONS.REQUISITION_READ_TENANT);
    const scope = params.scope === 'company' && all ? 'company' : 'mine';
    if (params.scope === 'company' && !all) {
      throw new ForbiddenException(`Your ${BRAND} role shows you your own requisitions only.`);
    }
    const where: Prisma.RequisitionWhereInput = scope === 'mine' ? { requesterId: me.userId } : {};
    const status = statusOf(params, RequisitionStatus, 'Requisitions');
    if (status) where.status = status;
    const text = searchOf(params);
    if (text) {
      where.OR = [
        { number: { contains: text, mode: 'insensitive' } },
        { title: { contains: text, mode: 'insensitive' } },
      ];
    }
    const db = this.prisma.client;
    const [total, rows] = await Promise.all([
      db.requisition.count({ where }),
      db.requisition.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limitOf(params),
        include: { requester: { select: { name: true } }, costCenter: { select: { name: true } } },
      }),
    ]);
    return {
      scope,
      total,
      requisitions: rows.map((r) => ({
        ref: r.id,
        number: r.number,
        title: r.title,
        status: r.status,
        requester: r.requester.name,
        cost_center: r.costCenter.name,
        amount: money(r.totalAmount),
        currency: r.currency,
        needed_by: r.neededBy?.toISOString().slice(0, 10) ?? null,
        created_at: r.createdAt.toISOString(),
        href: `/requisitions/${r.id}`,
      })),
    };
  }

  private async purchaseOrders(me: Person, params: Record<string, unknown>) {
    this.need(me, PERMISSIONS.PURCHASE_ORDER_READ_TENANT, 'purchase orders');
    const where: Prisma.PurchaseOrderWhereInput = {};
    const status = statusOf(params, PoStatus, 'Purchase orders');
    if (status) where.status = status;
    const text = searchOf(params);
    if (text) {
      where.OR = [
        { number: { contains: text, mode: 'insensitive' } },
        { vendor: { name: { contains: text, mode: 'insensitive' } } },
      ];
    }
    const db = this.prisma.client;
    const [total, rows] = await Promise.all([
      db.purchaseOrder.count({ where }),
      db.purchaseOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limitOf(params),
        include: { vendor: { select: { name: true } } },
      }),
    ]);
    return {
      total,
      purchase_orders: rows.map((po) => ({
        ref: po.id,
        number: po.number,
        vendor: po.vendor.name,
        status: po.status,
        amount: money(po.totalAmount),
        currency: po.currency,
        expected_on: po.expectedDeliveryDate?.toISOString().slice(0, 10) ?? null,
        created_at: po.createdAt.toISOString(),
        href: `/purchase-orders/${po.id}`,
      })),
    };
  }

  private async invoices(me: Person, params: Record<string, unknown>) {
    this.need(me, PERMISSIONS.INVOICE_READ_TENANT, 'invoices');
    const where: Prisma.InvoiceWhereInput = {};
    const status = statusOf(params, InvoiceStatus, 'Invoices');
    if (status) where.status = status;
    const text = searchOf(params);
    if (text) {
      where.OR = [
        { number: { contains: text, mode: 'insensitive' } },
        { vendorInvoiceRef: { contains: text, mode: 'insensitive' } },
        { vendor: { name: { contains: text, mode: 'insensitive' } } },
      ];
    }
    const db = this.prisma.client;
    const [total, rows] = await Promise.all([
      db.invoice.count({ where }),
      db.invoice.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limitOf(params),
        include: { vendor: { select: { name: true } } },
      }),
    ]);
    return {
      total,
      invoices: rows.map((inv) => ({
        ref: inv.id,
        number: inv.number,
        vendor_ref: inv.vendorInvoiceRef,
        vendor: inv.vendor.name,
        status: inv.status,
        amount: money(inv.netAmount),
        currency: inv.currency,
        invoice_date: inv.invoiceDate.toISOString().slice(0, 10),
        created_at: inv.createdAt.toISOString(),
        href: `/invoices/${inv.id}`,
      })),
    };
  }

  private async budgets(me: Person) {
    this.need(me, PERMISSIONS.BUDGET_READ, 'budgets');
    const now = new Date();
    const rows = await this.prisma.client.budget.findMany({
      where: { isActive: true, periodStart: { lte: now }, periodEnd: { gte: now } },
      orderBy: { periodStart: 'desc' },
      take: 50,
    });
    const centres = new Map(
      (
        await this.prisma.client.costCenter.findMany({
          where: { id: { in: rows.map((b) => b.costCenterId) } },
          select: { id: true, name: true, code: true },
        })
      ).map((c) => [c.id, c]),
    );
    return {
      budgets: rows.map((b) => {
        const total = b.allocatedAmount.plus(b.openingBalance);
        const available = total.minus(b.committedAmount).minus(b.consumedAmount);
        return {
          cost_center: centres.get(b.costCenterId)?.name ?? null,
          code: centres.get(b.costCenterId)?.code ?? null,
          period: `${b.periodStart.toISOString().slice(0, 10)} to ${b.periodEnd.toISOString().slice(0, 10)}`,
          currency: b.currency,
          allocated: money(total),
          committed: money(b.committedAmount),
          consumed: money(b.consumedAmount),
          available: money(available),
          used_pct: total.isZero()
            ? null
            : b.committedAmount.plus(b.consumedAmount).div(total).times(100).toFixed(1),
        };
      }),
    };
  }

  // ── Doing for one person (act) ──────────────────────────────────────────

  async act(found: Linked, me: Person, kind: string, params: Record<string, unknown>) {
    if (kind !== 'approval.decide') throw new UnprocessableEntityException('Unknown action.');
    if (!me.perms.includes(PERMISSIONS.APPROVAL_DECIDE)) {
      throw new ForbiddenException(`Your ${BRAND} role does not let you decide approvals.`);
    }
    const approvalId = clean(params.approval_id, 64);
    const decision = String(params.decision ?? '').toLowerCase();
    if (!approvalId) throw new UnprocessableEntityException('Which approval? Its ref is missing.');
    if (decision !== 'approve' && decision !== 'reject') {
      throw new UnprocessableEntityException('Approve or reject?');
    }
    const comment = clean(params.comment, 2000);
    if (decision === 'reject' && !comment) {
      throw new UnprocessableEntityException('A rejection needs a reason for the requester.');
    }
    return this.prisma.runInTenantContext(found.tenantId, async (tx) => {
      const approval = await tx.approval.findUnique({ where: { id: approvalId } });
      if (!approval || approval.approverId !== me.userId || approval.decision !== 'PENDING') {
        throw new ConflictException('That approval is no longer waiting on you.');
      }
      await this.routing.decide(
        approvalId,
        decision === 'approve' ? 'APPROVE' : 'REJECT',
        comment ? `${comment} (via AskMira)` : 'Decided from AskMira',
        me.userId,
      );
      return { kind, actor: this.actorOf(me), approval_id: approvalId, decision };
    });
  }

  // ── Signing in from AskMira (launch) ────────────────────────────────────

  async launch(token: string, meta: { userAgent?: string; ipAddress?: string }) {
    let checked;
    try {
      checked = await this.claimsOf(token, 'launch');
    } catch (err) {
      if (err instanceof HttpException && err.getStatus() === 404) {
        throw new ForbiddenException(`Your company is not connected to ${BRAND} any more. Ask your HR admin.`);
      }
      throw err;
    }
    const { found, claims } = checked;
    await this.spendOnce(claims, `This sign-in link was already used. Open ${BRAND} again from AskMira.`);
    if (claims.ext && String(claims.ext) !== found.tenantId) {
      throw new ForbiddenException(`Your company is not connected to ${BRAND} any more. Ask your HR admin.`);
    }
    const me = await this.actorIn(found, { email: claims.email });
    if (me.roles.includes(ROLES.SYSADMIN)) {
      throw new ConflictException(`This is a ${BRAND} system account. Sign in to ${BRAND} directly.`);
    }
    const askmiraUserId = clean(claims.sub, 64);
    const session = await this.prisma.runInTenantContext(found.tenantId, async (tx) => {
      const user = await tx.user.findUnique({ where: { id: me.userId }, select: { mfaEnabled: true } });
      if (user?.mfaEnabled) {
        throw new ConflictException(
          `You use two-step sign-in in ${BRAND}. Sign in to ${BRAND} directly; AskMira cannot do that step for you.`,
        );
      }
      await tx.askmiraPerson.upsert({
        where: { tenantId_userId: { tenantId: found.tenantId, userId: me.userId } },
        create: { tenantId: found.tenantId, userId: me.userId, askmiraUserId },
        update: { askmiraUserId },
      });
      return true;
    });
    if (!session) throw new ForbiddenException('Could not sign you in.');
    return this.auth.signInFromAskMira(found.tenantId, me.userId, meta);
  }
}
