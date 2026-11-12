import crypto from 'node:crypto';

import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma, newId } from '@procureflow/db';
import { hash as argonHash } from 'argon2';

import { DomainError } from '../../common/errors/domain-error';
import { AuditLogService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AskmiraService, canConnect, serverKey } from './askmira.service';
import {
  BRAND,
  EMAIL_RE,
  PRODUCT,
  UUID_RE,
  clean,
  deriveSecret,
  normEmail,
  safeEqual,
  sha256hex,
  verify,
  type Claims,
} from './askmira.tokens';

/**
 * AskMira's platform sets a company up here (AskMira → Platform → Tools).
 *
 * AskMira's super admin holds ProcureFlow's platform key, the same value as
 * this server's ASKMIRA_PLATFORM_SECRET. With it — never with a company's own
 * secret — AskMira may:
 *
 *   POST integrations/askmira/platform/ping           check the key
 *   POST integrations/askmira/platform/organizations  find an organisation here
 *   POST integrations/askmira/platform/provision      create or attach one
 *
 * `provision` creates an organisation with AskMira's admin as its TENANT_ADMIN
 * (they come in from AskMira, or set a password with "Forgot password"), or
 * attaches the organisation the super admin picked, and answers with that
 * organisation's own secret, exactly as Allow does. It never makes a second
 * organisation for someone who already administers one unasked: it answers
 * 409 "existing" naming them. Attaching grants nobody a role.
 */

/** A refusal AskMira acts on: its `code` (and what it names) travel in the problem's context. */
class AskmiraRefusal extends DomainError {
  readonly type = 'https://procureflow.io/errors/askmira';
  readonly title = 'AskMira';
  constructor(
    readonly status: number,
    message: string,
    context: Record<string, unknown>,
  ) {
    super(message, context);
  }
}

interface OrgRow {
  tenant_id: string;
  tenant_name: string;
  admins: string[] | null;
  connected_to: string | null;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function platformKey(): string {
  return process.env.ASKMIRA_PLATFORM_SECRET ?? '';
}

function originOf(value: unknown): string | null {
  try {
    const url = new URL(String(value ?? ''));
    return ['https:', 'http:'].includes(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
}

const orgOf = (row: OrgRow) => ({
  ref: row.tenant_id,
  name: row.tenant_name,
  admins: (row.admins ?? []).slice(0, 5),
  connected_to: row.connected_to,
});

@Injectable()
export class AskmiraPlatformService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly askmira: AskmiraService,
  ) {}

  /** The platform's call: signed with the platform key, use=platform, bound to this body. */
  assertion(raw: Buffer | undefined, authorization: string | undefined) {
    const key = platformKey();
    // Not set up for it: as if these endpoints did not exist.
    if (key.length < 32) throw new NotFoundException('Not found');
    if (!raw) throw new BadRequestException('The request has no body.');
    const match = /^Bearer\s+(.+)$/i.exec(authorization ?? '');
    if (!match) throw new UnauthorizedException('Missing AskMira assertion.');
    const claims = verify(match[1]!.trim(), key);
    if (!claims || claims.use !== 'platform' || claims.sub !== 'platform') {
      throw new UnauthorizedException('This AskMira platform key is not the one set here.');
    }
    if (!safeEqual(String(claims.bh ?? ''), sha256hex(raw))) {
      throw new UnauthorizedException('The assertion does not match this request.');
    }
    let body: Record<string, unknown>;
    try {
      body = obj(JSON.parse(raw.toString('utf8')));
    } catch {
      throw new BadRequestException('The request is not JSON.');
    }
    return { claims, body };
  }

  ping() {
    return {
      product: PRODUCT,
      brand: BRAND,
      ready: canConnect(),
      message: canConnect()
        ? `${BRAND} is ready.`
        : `Set ASKMIRA_LINK_SECRET (at least 32 characters) on ${BRAND} first.`,
    };
  }

  private async orgs(q: string | null, adminEmail: string | null) {
    const rows = await this.prisma.client.$queryRaw<OrgRow[]>(
      Prisma.sql`SELECT * FROM askmira_platform_orgs(${q}, ${adminEmail})`,
    );
    return rows.map(orgOf);
  }

  async organizations(body: Record<string, unknown>) {
    const q = clean(body.q, 120);
    if (!q || q.length < 2) throw new UnprocessableEntityException('Type at least two letters.');
    return { organizations: await this.orgs(q.replace(/[%_\\]/g, (c) => `\\${c}`), null) };
  }

  /** Connect a tenant to the AskMira workspace: a fresh nonce, so a fresh secret. */
  private async connect(tenantId: string, askmira: { id: string; name: string | null; origin: string | null }) {
    const elsewhere = await this.askmira.linkedTo(askmira.id);
    if (elsewhere && elsewhere.tenantId !== tenantId) {
      // One AskMira workspace per organisation here: the old link goes.
      await this.prisma.runInTenantContext(elsewhere.tenantId, async (tx) => {
        await tx.askmiraLink.deleteMany({ where: { tenantId: elsewhere.tenantId } });
      });
    }
    const nonce = crypto.randomBytes(32).toString('base64url');
    const name = await this.prisma.runInTenantContext(tenantId, async (tx) => {
      await tx.askmiraLink.upsert({
        where: { tenantId },
        create: {
          tenantId,
          askmiraTenantId: askmira.id,
          askmiraName: askmira.name,
          askmiraOrigin: askmira.origin,
          secretNonce: nonce,
          connectedBy: 'askmira-platform',
        },
        update: {
          askmiraTenantId: askmira.id,
          askmiraName: askmira.name,
          askmiraOrigin: askmira.origin,
          secretNonce: nonce,
          connectedBy: 'askmira-platform',
          connectedAt: new Date(),
        },
      });
      await this.audit.record({
        action: 'askmira.connected',
        entityType: 'AskmiraLink',
        entityId: tenantId,
        actorType: 'SYSTEM',
        after: { askmira_tenant_id: askmira.id, askmira_name: askmira.name, by: 'askmira-platform' },
      });
      const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
      return tenant?.name ?? '';
    });
    return { secret: deriveSecret(serverKey(), tenantId, nonce), name };
  }

  async provision(body: Record<string, unknown>, claims: Claims) {
    if (!canConnect()) {
      throw new AskmiraRefusal(409, `Set ASKMIRA_LINK_SECRET (at least 32 characters) on ${BRAND} first.`, {});
    }
    // A captured request can't be sent again to swap the key AskMira holds.
    await this.askmira.spendOnce(claims, 'This request was already carried out.');
    const askmiraId = String(body.tenant_id ?? '').toLowerCase();
    const company = obj(body.company);
    const admin = obj(body.admin);
    const name = clean(company.name, 200) ?? clean(body.tenant_name, 200);
    const email = normEmail(admin.email);
    const ref = clean(body.organization_ref, 120);
    if (!UUID_RE.test(askmiraId) || !name || !EMAIL_RE.test(email)) {
      throw new UnprocessableEntityException('AskMira sent an incomplete company.');
    }
    const askmira = {
      id: askmiraId,
      name: clean(body.tenant_name, 200) ?? name,
      origin: originOf(body.askmira_origin),
    };
    const answer = (tenantId: string, secret: string, organization: string, created: boolean) => ({
      product: PRODUCT,
      brand: BRAND,
      secret,
      external_ref: tenantId,
      organization,
      created,
      admin_created: created,
    });

    // Attach the organisation the super admin picked.
    if (ref) {
      if (!UUID_RE.test(ref)) throw new NotFoundException(`No such organisation in ${BRAND}.`);
      const tenant = await this.prisma.client.tenant.findUnique({ where: { id: ref }, select: { id: true, name: true } });
      if (!tenant) throw new NotFoundException(`No such organisation in ${BRAND}.`);
      const link = await this.prisma.runInTenantContext(tenant.id, (tx) =>
        tx.askmiraLink.findUnique({ where: { tenantId: tenant.id } }),
      );
      if (link && link.askmiraTenantId !== askmiraId) {
        throw new AskmiraRefusal(409, `${tenant.name} is connected to another AskMira workspace.`, { code: 'taken' });
      }
      const { secret, name: orgName } = await this.connect(tenant.id, askmira);
      return answer(tenant.id, secret, orgName, false);
    }

    // Already connected here (AskMira lost its key, or asked twice): the same organisation, a new key.
    const linked = await this.askmira.linkedTo(askmiraId);
    if (linked) {
      const { secret, name: orgName } = await this.connect(linked.tenantId, askmira);
      return answer(linked.tenantId, secret, orgName, false);
    }

    if (body.create_new !== true) {
      const runs = await this.orgs(null, email);
      if (runs.length > 0) {
        throw new AskmiraRefusal(
          409,
          `${email} already administers ${runs.length === 1 ? 'an organisation' : `${runs.length} organisations`} in ${BRAND}.`,
          { code: 'existing', organizations: runs.slice(0, 10) },
        );
      }
    }

    // Nobody knows this password: the admin comes in from AskMira or uses "Forgot password".
    const unusable = await argonHash(crypto.randomBytes(32).toString('base64url'), { type: 2 });
    const person = clean(admin.name, 200) ?? email.split('@')[0]!;
    const rows = await this.prisma.client.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT askmira_platform_create(${name}, ${email}, ${person}, ${unusable}, ${newId('user')}, ${newId('userRole')}) AS id`,
    );
    const tenantId = rows[0]!.id;
    await this.prisma.runInTenantContext(tenantId, async () => {
      await this.audit.record({
        action: 'tenant.created',
        entityType: 'Tenant',
        entityId: tenantId,
        actorType: 'SYSTEM',
        after: { name, admin: email, by: 'askmira-platform', askmira_tenant_id: askmiraId },
      });
    });
    const { secret, name: orgName } = await this.connect(tenantId, askmira);
    return answer(tenantId, secret, orgName, true);
  }
}
