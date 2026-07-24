import { Injectable } from '@nestjs/common';
import type { ApprovalContext, DocumentType, RoleName, Scope } from '@procureflow/shared';

import { PrismaService } from '../prisma/prisma.service';
import { AmbiguousApproverError } from './approval.errors';

export interface ResolvedApprover {
  approverId: string;
  /** Set when a standing delegation redirected the assignee. */
  delegatedFromId: string | null;
}

/**
 * Resolves a step's (role, scope) to a single concrete user at routing time.
 *
 * On zero or multiple candidates it throws `AmbiguousApproverError` — never
 * silently picks one (Slice 2 §In-scope 3). Standing delegations are consulted
 * last: if the resolved assignee has an active delegation covering this document
 * type, the delegate becomes the assignee.
 */
@Injectable()
export class ApproverResolver {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(
    role: RoleName,
    scope: Scope,
    ctx: ApprovalContext,
    opts: { documentType: DocumentType; tenantId: string },
  ): Promise<ResolvedApprover> {
    const candidates = await this.candidatesForRole(role, scope, ctx);

    if (candidates.length === 0) {
      throw new AmbiguousApproverError(
        `No user holds role ${role} for scope ${scope} on this document.`,
        { role, scope, candidates: 0 },
      );
    }
    if (candidates.length > 1) {
      throw new AmbiguousApproverError(
        `Multiple users hold role ${role} for scope ${scope}; cannot auto-route.`,
        { role, scope, candidates: candidates.length },
      );
    }

    const assignee = candidates[0] as string;
    const delegate = await this.activeDelegateFor(assignee, opts.documentType);
    if (delegate && delegate !== assignee) {
      return { approverId: delegate, delegatedFromId: assignee };
    }
    return { approverId: assignee, delegatedFromId: null };
  }

  /** Distinct user ids holding `role`, filtered by `scope` against the context. */
  async candidatesForRole(
    role: RoleName,
    scope: Scope,
    ctx: ApprovalContext,
  ): Promise<string[]> {
    const roleRow = await this.prisma.client.role.findUnique({ where: { name: role } });
    if (!roleRow) return [];

    // `assigned` short-circuits to the officer already on the document.
    if (scope === 'assigned') {
      const assigned = asString(ctx.assigned_to_id);
      if (!assigned) return [];
      const holds = await this.prisma.client.userRole.findFirst({
        where: { roleId: roleRow.id, userId: assigned },
      });
      return holds ? [assigned] : [];
    }

    const where: Record<string, unknown> = { roleId: roleRow.id };
    if (scope === 'dept') where.deptId = asString(ctx.dept_id) ?? '__none__';
    if (scope === 'plant') where.plantId = asString(ctx.plant_id) ?? '__none__';

    const userRoles = await this.prisma.client.userRole.findMany({
      where,
      select: { userId: true },
    });
    return [...new Set(userRoles.map((ur) => ur.userId))];
  }

  /** Returns the delegate user id if `userId` has an active delegation now. */
  private async activeDelegateFor(
    userId: string,
    documentType: DocumentType,
  ): Promise<string | null> {
    const now = new Date();
    const delegations = await this.prisma.client.delegation.findMany({
      where: {
        userId,
        isActive: true,
        fromDate: { lte: now },
        toDate: { gte: now },
      },
      orderBy: { createdAt: 'desc' },
    });
    const applicable = delegations.find(
      (d) => d.scope === 'ALL' || d.documentTypes.includes(documentType),
    );
    return applicable?.delegateUserId ?? null;
  }
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
