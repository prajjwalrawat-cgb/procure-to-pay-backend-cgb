import { Injectable } from '@nestjs/common';
import { newId } from '@procureflow/db';
import type { DelegationCreateInput, DocumentType } from '@procureflow/shared';

import { AuditLogService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { CircularDelegationError } from './approval.errors';

export interface DelegationView {
  id: string;
  userId: string;
  userName: string | null;
  delegateUserId: string;
  delegateName: string | null;
  scope: string;
  documentTypes: DocumentType[];
  reason: string;
  fromDate: string;
  toDate: string;
  isActive: boolean;
  createdAt: string;
}

/** Standing delegations of approval authority (Slice 2). */
@Injectable()
export class DelegationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  async create(
    tenantId: string,
    actorId: string,
    userId: string,
    input: DelegationCreateInput,
  ): Promise<DelegationView> {
    // Reject A→B when an active B→A already exists (loop).
    const now = new Date();
    const reverse = await this.prisma.client.delegation.findFirst({
      where: {
        userId: input.delegateUserId,
        delegateUserId: userId,
        isActive: true,
        toDate: { gte: now },
      },
    });
    if (reverse) {
      throw new CircularDelegationError(
        'A reciprocal delegation already exists between these users.',
        { userId, delegateUserId: input.delegateUserId },
      );
    }

    const id = newId('delegation');
    await this.prisma.client.delegation.create({
      data: {
        id,
        tenantId,
        userId,
        delegateUserId: input.delegateUserId,
        scope: input.scope,
        documentTypes: input.documentTypes ?? [],
        reason: input.reason,
        fromDate: new Date(input.from),
        toDate: new Date(input.to),
        isActive: true,
        createdBy: actorId,
      },
    });
    await this.audit.record({
      action: 'DELEGATION_CREATED',
      entityType: 'Delegation',
      entityId: id,
      actorId,
      after: { userId, delegateUserId: input.delegateUserId, scope: input.scope },
    });
    return this.get(id);
  }

  async listFor(userId: string): Promise<DelegationView[]> {
    const rows = await this.prisma.client.delegation.findMany({
      where: { OR: [{ userId }, { delegateUserId: userId }] },
      orderBy: { createdAt: 'desc' },
    });
    return this.decorate(rows);
  }

  async revoke(actorId: string, id: string): Promise<void> {
    await this.prisma.client.delegation.updateMany({
      where: { id },
      data: { isActive: false },
    });
    await this.audit.record({
      action: 'DELEGATION_REVOKED',
      entityType: 'Delegation',
      entityId: id,
      actorId,
    });
  }

  private async get(id: string): Promise<DelegationView> {
    const row = await this.prisma.client.delegation.findUniqueOrThrow({ where: { id } });
    return (await this.decorate([row]))[0] as DelegationView;
  }

  private async decorate(
    rows: Array<{
      id: string;
      userId: string;
      delegateUserId: string;
      scope: string;
      documentTypes: DocumentType[];
      reason: string;
      fromDate: Date;
      toDate: Date;
      isActive: boolean;
      createdAt: Date;
    }>,
  ): Promise<DelegationView[]> {
    const ids = [...new Set(rows.flatMap((r) => [r.userId, r.delegateUserId]))];
    const users = await this.prisma.client.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    const nameById = new Map(users.map((u) => [u.id, u.name]));
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      userName: nameById.get(r.userId) ?? null,
      delegateUserId: r.delegateUserId,
      delegateName: nameById.get(r.delegateUserId) ?? null,
      scope: r.scope,
      documentTypes: r.documentTypes,
      reason: r.reason,
      fromDate: r.fromDate.toISOString(),
      toDate: r.toDate.toISOString(),
      isActive: r.isActive,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
