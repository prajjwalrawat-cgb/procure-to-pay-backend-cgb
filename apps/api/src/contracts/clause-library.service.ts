import { Injectable } from '@nestjs/common';
import { newId } from '@procureflow/db';
import type {
  ClauseLibraryInput,
  ClauseLibraryItem,
  ContractClauseType,
} from '@procureflow/shared';

import { AuditLogService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * ClauseLibraryService (Slice 9). The tenant's reusable standard clauses. Edits
 * are governed by TENANT_ADMIN / LEGAL_OFFICER (enforced at the controller);
 * executed contracts never retroactively inherit library edits (frozen at
 * execution — a deliberate non-goal).
 */
@Injectable()
export class ClauseLibraryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  async list(clauseType?: ContractClauseType | null): Promise<ClauseLibraryItem[]> {
    const rows = await this.prisma.client.clauseLibrary.findMany({
      where: clauseType ? { clauseType } : {},
      orderBy: [{ clauseType: 'asc' }, { title: 'asc' }, { version: 'desc' }],
    });
    return rows.map((r) => ({
      id: r.id,
      clauseType: r.clauseType as ContractClauseType,
      title: r.title,
      contentText: r.contentText,
      isDefault: r.isDefault,
      version: r.version,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async add(input: ClauseLibraryInput, actorId: string): Promise<{ id: string }> {
    const tenantId = this.tenantId();
    // New version if a clause with this type + title already exists.
    const existing = await this.prisma.client.clauseLibrary.findFirst({
      where: { tenantId, clauseType: input.clauseType, title: input.title },
      orderBy: { version: 'desc' },
    });
    const id = newId('clauseLibrary');
    await this.prisma.client.clauseLibrary.create({
      data: {
        id,
        tenantId,
        clauseType: input.clauseType,
        title: input.title,
        contentText: input.contentText,
        isDefault: input.isDefault,
        version: existing ? existing.version + 1 : 1,
        createdBy: actorId,
      },
    });
    await this.audit.record({
      action: 'CLAUSE_LIBRARY_ADDED',
      entityType: 'ClauseLibrary',
      entityId: id,
      actorId,
      after: { clauseType: input.clauseType, title: input.title },
    });
    return { id };
  }

  private tenantId(): string {
    const tid = this.prisma.currentTenantId;
    if (!tid) throw new Error('No tenant context');
    return tid;
  }
}
