import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, newId } from '@procureflow/db';
import {
  evaluateConditions,
  type ApprovalContext,
  type ApprovalMatrixCreateInput,
  type ApprovalMatrixUpdateInput,
  type ApprovalMatrixView,
  type ApprovalStep,
  type Condition,
  type DocumentType,
  type ResolvedChainStep,
  type SimulateResult,
} from '@procureflow/shared';

import { AuditLogService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { ApprovalContextService } from './approval-context.service';
import { ApproverResolver } from './approver-resolver.service';

type MatrixRow = Prisma.ApprovalMatrixGetPayload<Record<string, never>>;

/**
 * ApprovalMatrixService — the editable, versioned rule store (Slice 2).
 *
 * `update` never mutates: it writes a new *version* row chained on
 * `previousVersionId`, so documents that snapshotted an older version keep their
 * route. Only one version per (name, documentType) is active at a time.
 */
@Injectable()
export class ApprovalMatrixService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly context: ApprovalContextService,
    private readonly resolver: ApproverResolver,
  ) {}

  /** Active matrices for a document type, priority order — the rule cards. */
  async list(documentType: DocumentType): Promise<ApprovalMatrixView[]> {
    const rows = await this.prisma.client.approvalMatrix.findMany({
      where: { documentType, isActive: true },
      orderBy: { priority: 'asc' },
    });
    return this.withNames(rows);
  }

  async get(id: string): Promise<ApprovalMatrixView> {
    const row = await this.requireMatrix(id);
    return (await this.withNames([row]))[0] as ApprovalMatrixView;
  }

  /** All versions sharing this matrix's (name, documentType), newest first. */
  async versions(id: string): Promise<ApprovalMatrixView[]> {
    const row = await this.requireMatrix(id);
    const rows = await this.prisma.client.approvalMatrix.findMany({
      where: { name: row.name, documentType: row.documentType },
      orderBy: { version: 'desc' },
    });
    return this.withNames(rows);
  }

  async create(
    tenantId: string,
    actorId: string,
    input: ApprovalMatrixCreateInput,
  ): Promise<ApprovalMatrixView> {
    const id = newId('approvalMatrix');
    const row = await this.prisma.client.approvalMatrix.create({
      data: {
        id,
        tenantId,
        documentType: input.documentType,
        name: input.name,
        priority: input.priority,
        isActive: false, // created as draft; activation is a separate step
        version: 1,
        conditions: input.conditions as unknown as Prisma.InputJsonValue,
        steps: input.steps as unknown as Prisma.InputJsonValue,
        updatedBy: actorId,
      },
    });
    await this.audit.record({
      action: 'MATRIX_CREATED',
      entityType: 'ApprovalMatrix',
      entityId: id,
      actorId,
      after: { name: input.name, documentType: input.documentType, version: 1 },
    });
    return (await this.withNames([row]))[0] as ApprovalMatrixView;
  }

  /** Create a new version instead of mutating the existing one. */
  async update(
    tenantId: string,
    actorId: string,
    id: string,
    input: ApprovalMatrixUpdateInput,
  ): Promise<ApprovalMatrixView> {
    const prev = await this.requireMatrix(id);
    const maxVersion = await this.prisma.client.approvalMatrix.aggregate({
      where: { name: prev.name, documentType: prev.documentType },
      _max: { version: true },
    });
    const nextVersion = (maxVersion._max.version ?? prev.version) + 1;
    const newRowId = newId('approvalMatrix');
    const row = await this.prisma.client.approvalMatrix.create({
      data: {
        id: newRowId,
        tenantId,
        documentType: prev.documentType,
        name: input.name ?? prev.name,
        priority: input.priority ?? prev.priority,
        isActive: false, // new version is a draft until activated
        version: nextVersion,
        previousVersionId: prev.id,
        conditions: (input.conditions ??
          (prev.conditions as unknown)) as Prisma.InputJsonValue,
        steps: (input.steps ?? (prev.steps as unknown)) as Prisma.InputJsonValue,
        updatedBy: actorId,
      },
    });
    await this.audit.record({
      action: 'MATRIX_VERSIONED',
      entityType: 'ApprovalMatrix',
      entityId: newRowId,
      actorId,
      before: { id: prev.id, version: prev.version },
      after: { id: newRowId, version: nextVersion },
    });
    return (await this.withNames([row]))[0] as ApprovalMatrixView;
  }

  async activate(actorId: string, id: string): Promise<ApprovalMatrixView> {
    const row = await this.requireMatrix(id);
    // Only one active version per (name, documentType).
    await this.prisma.client.approvalMatrix.updateMany({
      where: {
        name: row.name,
        documentType: row.documentType,
        isActive: true,
        id: { not: id },
      },
      data: { isActive: false },
    });
    const updated = await this.prisma.client.approvalMatrix.update({
      where: { id },
      data: { isActive: true },
    });
    await this.audit.record({
      action: 'MATRIX_ACTIVATED',
      entityType: 'ApprovalMatrix',
      entityId: id,
      actorId,
      after: { name: row.name, version: row.version },
    });
    return (await this.withNames([updated]))[0] as ApprovalMatrixView;
  }

  async deactivate(actorId: string, id: string): Promise<ApprovalMatrixView> {
    await this.requireMatrix(id);
    const updated = await this.prisma.client.approvalMatrix.update({
      where: { id },
      data: { isActive: false },
    });
    await this.audit.record({
      action: 'MATRIX_DEACTIVATED',
      entityType: 'ApprovalMatrix',
      entityId: id,
      actorId,
    });
    return (await this.withNames([updated]))[0] as ApprovalMatrixView;
  }

  async duplicate(
    tenantId: string,
    actorId: string,
    id: string,
  ): Promise<ApprovalMatrixView> {
    const row = await this.requireMatrix(id);
    const newRowId = newId('approvalMatrix');
    const created = await this.prisma.client.approvalMatrix.create({
      data: {
        id: newRowId,
        tenantId,
        documentType: row.documentType,
        name: `${row.name} (copy)`,
        priority: row.priority,
        isActive: false,
        version: 1,
        conditions: row.conditions as Prisma.InputJsonValue,
        steps: row.steps as Prisma.InputJsonValue,
        updatedBy: actorId,
      },
    });
    await this.audit.record({
      action: 'MATRIX_DUPLICATED',
      entityType: 'ApprovalMatrix',
      entityId: newRowId,
      actorId,
      after: { source: id, name: created.name },
    });
    return (await this.withNames([created]))[0] as ApprovalMatrixView;
  }

  /** Dry-run a rule against a document. ZERO side effects. */
  async simulate(args: {
    documentType: DocumentType;
    conditions: Condition;
    steps: ApprovalStep[];
    matrixId: string | null;
    matrixName: string | null;
    documentId?: string;
    sampleDocument?: Record<string, unknown>;
  }): Promise<SimulateResult> {
    const ctx: ApprovalContext = args.documentId
      ? await this.context.build(args.documentType, args.documentId)
      : (args.sampleDocument as ApprovalContext);
    const submitterId = args.documentId
      ? await this.context.submitterOf(args.documentType, args.documentId)
      : null;

    const { matched, trace } = evaluateConditions(args.conditions, ctx);
    const chain: ResolvedChainStep[] = [];
    if (matched) {
      for (const step of args.steps) {
        chain.push(await this.simulateStep(step, ctx, submitterId));
      }
    }
    return {
      matchedMatrixId: matched ? args.matrixId : null,
      matchedMatrixName: matched ? args.matrixName : null,
      matched,
      trace,
      chain,
      context: ctx as Record<string, unknown>,
    };
  }

  private async simulateStep(
    step: ApprovalStep,
    ctx: ApprovalContext,
    submitterId: string | null,
  ): Promise<ResolvedChainStep> {
    const base: ResolvedChainStep = {
      stepNo: step.step_no,
      name: step.name,
      role: step.role,
      scope: step.scope,
      slaHours: step.sla_hours,
      parallelGroup: step.parallel_group ?? null,
      approverId: null,
      approverName: null,
      skipped: false,
      skipReason: null,
      unresolved: false,
      unresolvedReason: null,
    };

    if (step.skip_if && evaluateConditions(step.skip_if, ctx).matched) {
      return { ...base, skipped: true, skipReason: 'skip_if matched' };
    }

    const candidates = await this.resolver.candidatesForRole(step.role, step.scope, ctx);
    const nonSubmitter = candidates.filter((c) => c !== submitterId);
    if (submitterId && candidates.includes(submitterId) && nonSubmitter.length === 0) {
      return { ...base, skipped: true, skipReason: 'submitter is the only approver' };
    }
    if (nonSubmitter.length !== 1) {
      return {
        ...base,
        unresolved: true,
        unresolvedReason:
          nonSubmitter.length === 0
            ? `No user holds ${step.role} for scope ${step.scope}`
            : `${nonSubmitter.length} candidates for ${step.role}/${step.scope}`,
      };
    }
    const approverId = nonSubmitter[0] as string;
    const user = await this.prisma.client.user.findUnique({
      where: { id: approverId },
      select: { name: true },
    });
    return { ...base, approverId, approverName: user?.name ?? null };
  }

  private async requireMatrix(id: string): Promise<MatrixRow> {
    const row = await this.prisma.client.approvalMatrix.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Approval matrix not found');
    return row;
  }

  private async withNames(rows: MatrixRow[]): Promise<ApprovalMatrixView[]> {
    const actorIds = [
      ...new Set(rows.map((r) => r.updatedBy).filter((v): v is string => !!v)),
    ];
    const users = await this.prisma.client.user.findMany({
      where: { id: { in: actorIds } },
      select: { id: true, name: true },
    });
    const nameById = new Map(users.map((u) => [u.id, u.name]));
    return rows.map((r) => ({
      id: r.id,
      documentType: r.documentType,
      name: r.name,
      priority: r.priority,
      isActive: r.isActive,
      version: r.version,
      previousVersionId: r.previousVersionId,
      conditions: r.conditions as unknown as Condition,
      steps: r.steps as unknown as ApprovalStep[],
      updatedBy: r.updatedBy,
      updatedByName: r.updatedBy ? (nameById.get(r.updatedBy) ?? null) : null,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
