import { Injectable } from '@nestjs/common';
import { Prisma, newId } from '@procureflow/db';

import { PrismaService } from '../prisma/prisma.service';

export interface AuditRecordInput {
  action: string;
  entityType: string;
  entityId: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  actorId?: string | null;
  actorType?: 'USER' | 'SYSTEM';
  ipAddress?: string | null;
  userAgent?: string | null;
  /** Override tenant when not inside a request context (e.g. login flows). */
  tenantId?: string;
}

/**
 * AuditLogService (Master Context §3 rule #3). Every mutation calls `record`.
 * The DB trigger computes the chained hash — the app never sets it — so the log
 * is tamper-evident even if the app is compromised.
 *
 * Must run inside a tenant context (or be given a tenantId) so the RLS
 * WITH CHECK on AuditLog passes.
 */
@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditRecordInput): Promise<void> {
    const tenantId = input.tenantId ?? this.prisma.currentTenantId;
    if (!tenantId) {
      throw new Error('AuditLogService.record requires a tenant context.');
    }

    await this.prisma.client.auditLog.create({
      data: {
        id: newId('auditLog'),
        tenantId,
        actorId: input.actorId ?? null,
        actorType: input.actorType ?? (input.actorId ? 'USER' : 'SYSTEM'),
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        before: (input.before ?? undefined) as Prisma.InputJsonValue | undefined,
        after: (input.after ?? undefined) as Prisma.InputJsonValue | undefined,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        // Placeholder — BEFORE INSERT trigger overwrites with the chained hash.
        hashCurrent: '',
      },
    });
  }
}
