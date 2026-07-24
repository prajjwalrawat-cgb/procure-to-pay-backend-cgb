import { Injectable } from '@nestjs/common';
import { Prisma } from '@procureflow/db';
import type {
  AuditListResponse,
  AuditQueryInput,
  AuditRecordView,
  AuditVerifyResult,
} from '@procureflow/shared';

import { PrismaService } from '../prisma/prisma.service';

interface VerifyRow {
  id: string;
  timestamp: Date;
  hash_current: string;
  hash_previous: string | null;
  prev_link: string | null;
  recomputed: string;
}

/**
 * AuditQueryService — read-only access to the tamper-evident log (Slice 2).
 * `verifyChain` recomputes each row's hash using Postgres's OWN digest so the
 * serialization matches the insert trigger byte-for-byte.
 */
@Injectable()
export class AuditQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async find(input: AuditQueryInput): Promise<AuditListResponse> {
    const where = await this.buildWhere(input);
    const rows = await this.prisma.client.auditLog.findMany({
      where,
      take: input.limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
    });
    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const totalEstimate = await this.prisma.client.auditLog.count({ where });

    return {
      items: await this.decorate(page),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      totalEstimate,
    };
  }

  async getByEntity(entityType: string, entityId: string): Promise<AuditRecordView[]> {
    const rows = await this.prisma.client.auditLog.findMany({
      where: { entityType, entityId },
      orderBy: { timestamp: 'asc' },
    });
    return this.decorate(rows);
  }

  /** Re-derive the chain and report the first break within [from, to]. */
  async verifyChain(from: string | null, to: string | null): Promise<AuditVerifyResult> {
    const rows = await this.prisma.client.$queryRaw<VerifyRow[]>`
      SELECT a.id,
             a.timestamp,
             a.hash_current,
             a.hash_previous,
             lag(a.hash_current) OVER w AS prev_link,
             encode(
               extensions.digest(
                 coalesce(a.hash_previous, '') ||
                 (to_jsonb(a) - 'hash_current' - 'hash_previous')::text,
                 'sha256'
               ), 'hex'
             ) AS recomputed
      FROM "AuditLog" a
      WINDOW w AS (ORDER BY a.timestamp, a.id)
      ORDER BY a.timestamp, a.id`;

    const fromT = from ? new Date(from).getTime() : null;
    const toT = to ? new Date(to).getTime() : null;
    let checked = 0;
    let firstBreak: string | null = null;

    rows.forEach((row, idx) => {
      const t = row.timestamp.getTime();
      if ((fromT !== null && t < fromT) || (toT !== null && t > toT)) return;
      checked += 1;
      const integrityOk = row.recomputed === row.hash_current;
      const expectedPrev = idx === 0 ? null : row.prev_link;
      const linkageOk = (row.hash_previous ?? null) === (expectedPrev ?? null);
      if ((!integrityOk || !linkageOk) && firstBreak === null) {
        firstBreak = row.id;
      }
    });

    return {
      verified: firstBreak === null,
      eventsChecked: checked,
      firstBreakAt: firstBreak,
      from,
      to,
    };
  }

  private async buildWhere(input: AuditQueryInput): Promise<Prisma.AuditLogWhereInput> {
    const where: Prisma.AuditLogWhereInput = {};
    if (input.from || input.to) {
      where.timestamp = {
        ...(input.from ? { gte: new Date(input.from) } : {}),
        ...(input.to ? { lte: new Date(input.to) } : {}),
      };
    }
    if (input.actorId) where.actorId = input.actorId;
    if (input.action?.length) where.action = { in: input.action };
    if (input.entityType?.length) where.entityType = { in: input.entityType };
    if (input.entityId) where.entityId = input.entityId;
    if (input.ip) where.ipAddress = input.ip;

    if (input.search) {
      const matchingUsers = await this.prisma.client.user.findMany({
        where: { name: { contains: input.search, mode: 'insensitive' } },
        select: { id: true },
      });
      where.OR = [
        { entityId: { contains: input.search, mode: 'insensitive' } },
        ...(matchingUsers.length
          ? [{ actorId: { in: matchingUsers.map((u) => u.id) } }]
          : []),
      ];
    }
    return where;
  }

  private async decorate(
    rows: Prisma.AuditLogGetPayload<Record<string, never>>[],
  ): Promise<AuditRecordView[]> {
    const actorIds = [
      ...new Set(rows.map((r) => r.actorId).filter((v): v is string => !!v)),
    ];
    const users = await this.prisma.client.user.findMany({
      where: { id: { in: actorIds } },
      select: { id: true, name: true },
    });
    const nameById = new Map(users.map((u) => [u.id, u.name]));

    return rows.map((r) => ({
      id: r.id,
      timestamp: r.timestamp.toISOString(),
      actorId: r.actorId,
      actorName: r.actorId ? (nameById.get(r.actorId) ?? null) : null,
      actorType: r.actorType,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      before: (r.before as Record<string, unknown> | null) ?? null,
      after: (r.after as Record<string, unknown> | null) ?? null,
      ipAddress: r.ipAddress,
      hashCurrent: r.hashCurrent,
      hashPrevious: r.hashPrevious,
    }));
  }
}
