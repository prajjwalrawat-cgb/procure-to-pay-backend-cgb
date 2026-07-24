import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, newId } from '@procureflow/db';
import {
  DOMAIN_EVENTS,
  type RequisitionCreateInput,
  type RequisitionLineInput,
  type RequisitionUpdateInput,
} from '@procureflow/shared';
import Decimal from 'decimal.js';

import { ApprovalRoutingService } from '../approvals/approval-routing.service';
import { AuditLogService } from '../audit/audit.service';
import { BudgetService } from '../budgets/budget.service';
import { DomainEventService } from '../common/events/domain-event.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  RequisitionReviseNotAllowedError,
  RequisitionStateError,
  RequisitionValidationError,
} from './requisition.errors';
import {
  RequisitionValidator,
  type ValidatorContext,
  type ValidatorLineInput,
} from './requisition-validator';

interface BuiltLine {
  data: Prisma.RequisitionLineCreateManyRequisitionInput;
}

/**
 * RequisitionService (Slice 4) — draft → submit → approve → convert lifecycle.
 * Budget is *checked* at submit but only *committed* on approval, via the
 * RequisitionApprovalHooks listener. The approval engine (Slice 2) is reused
 * wholesale for routing.
 */
@Injectable()
export class RequisitionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly events: DomainEventService,
    private readonly routing: ApprovalRoutingService,
    private readonly budgets: BudgetService,
    private readonly validator: RequisitionValidator,
  ) {}

  async createDraft(
    input: RequisitionCreateInput,
    actorId: string,
  ): Promise<{ id: string }> {
    const { costCenter, plant } = await this.resolveOrg(
      input.costCenterId,
      input.plantId,
    );
    if (new Date(input.neededBy).getTime() <= Date.now()) {
      throw new BadRequestException('needed_by must be in the future.');
    }

    const ctx = this.taxContext(plant.stateCode);
    const { lines, result } = await this.buildLines(input.lines, ctx);
    if (!this.validator.isSubmittable(result)) {
      throw new RequisitionValidationError('Requisition lines are invalid.', {
        issues: result.issues,
      });
    }

    const id = newId('requisition');
    const number = await this.nextNumber();
    await this.prisma.client.requisition.create({
      data: {
        id,
        tenantId: this.tenantId(),
        number,
        title: input.title,
        businessJustification: input.businessJustification,
        requesterId: actorId,
        deptId: costCenter.deptId ?? plant.id,
        costCenterId: input.costCenterId,
        plantId: input.plantId,
        deliveryLocation: input.deliveryLocation ?? plant.address ?? null,
        priority: input.priority,
        status: 'DRAFT',
        totalAmount: new Prisma.Decimal(result.total),
        taxAmount: new Prisma.Decimal(result.taxAmount),
        currency: 'INR',
        neededBy: new Date(input.neededBy),
        lines: { createMany: { data: lines.map((l) => l.data) } },
      },
    });
    await this.audit.record({
      action: 'REQUISITION_CREATED',
      entityType: 'Requisition',
      entityId: id,
      actorId,
      before: null,
      after: { number, title: input.title, total: result.total, lineCount: lines.length },
    });
    await this.events.emit(DOMAIN_EVENTS.REQUISITION_DRAFTED, {
      requisitionId: id,
      requesterId: actorId,
      totalAmount: result.total,
    });
    return { id };
  }

  async updateDraft(
    id: string,
    input: RequisitionUpdateInput,
    actorId: string,
  ): Promise<{ ok: true }> {
    const pr = await this.requirePr(id);
    if (pr.status !== 'DRAFT') {
      throw new RequisitionStateError('Only a draft requisition can be edited.', {
        status: pr.status,
      });
    }
    if (pr.requesterId !== actorId && !(await this.isTenantAdmin(actorId))) {
      throw new RequisitionStateError('Only the requester or a tenant admin may edit.');
    }

    const plant = await this.prisma.client.plant.findUniqueOrThrow({
      where: { id: input.plantId ?? pr.plantId },
    });
    const ctx = this.taxContext(plant.stateCode);
    const lineInputs = input.lines ?? [];
    const { lines, result } = await this.buildLines(lineInputs, ctx);
    if (input.lines && !this.validator.isSubmittable(result)) {
      throw new RequisitionValidationError('Requisition lines are invalid.', {
        issues: result.issues,
      });
    }

    const before = await this.snapshotLines(id);
    await this.prisma.client.requisitionLine.deleteMany({ where: { requisitionId: id } });
    await this.prisma.client.requisitionLine.createMany({
      data: lines.map((l) => ({ ...l.data, requisitionId: id })),
    });
    await this.prisma.client.requisition.update({
      where: { id },
      data: {
        title: input.title ?? pr.title,
        businessJustification: input.businessJustification ?? pr.businessJustification,
        costCenterId: input.costCenterId ?? pr.costCenterId,
        plantId: input.plantId ?? pr.plantId,
        deliveryLocation: input.deliveryLocation ?? pr.deliveryLocation,
        priority: input.priority ?? pr.priority,
        neededBy: input.neededBy ? new Date(input.neededBy) : pr.neededBy,
        totalAmount: new Prisma.Decimal(result.total),
        taxAmount: new Prisma.Decimal(result.taxAmount),
      },
    });
    await this.audit.record({
      action: 'REQUISITION_UPDATED',
      entityType: 'Requisition',
      entityId: id,
      actorId,
      before: { lines: before },
      after: { total: result.total, lineCount: lines.length },
    });
    return { ok: true };
  }

  async submitForApproval(id: string, actorId: string): Promise<{ ok: true }> {
    const pr = await this.prisma.client.requisition.findUnique({
      where: { id },
      include: { lines: true },
    });
    if (!pr) throw new NotFoundException('Requisition not found');
    if (pr.status !== 'DRAFT' && pr.status !== 'BUDGET_BREACH_HELD') {
      throw new RequisitionStateError('Only a draft requisition can be submitted.', {
        status: pr.status,
      });
    }
    if (pr.lines.length === 0) {
      throw new RequisitionValidationError('Add at least one line first.');
    }
    for (const l of pr.lines) {
      if (!new Decimal(l.qty.toString()).greaterThan(0)) {
        throw new RequisitionValidationError('Every line needs a positive quantity.');
      }
      if (new Decimal(l.unitPrice.toString()).lessThan(0)) {
        throw new RequisitionValidationError('Unit prices cannot be negative.');
      }
    }
    if (pr.neededBy && pr.neededBy.getTime() <= Date.now()) {
      throw new RequisitionValidationError('needed_by must be in the future.');
    }

    // Budget check — hold (do not reject) on breach so the user can revise.
    const check = await this.budgets.checkAvailability(
      pr.costCenterId,
      pr.totalAmount.toString(),
    );
    if (!check.available) {
      await this.prisma.client.requisition.update({
        where: { id },
        data: {
          status: 'BUDGET_BREACH_HELD',
          budgetBreachDetail: check as unknown as Prisma.InputJsonValue,
        },
      });
      await this.audit.record({
        action: 'BUDGET_BREACH_DETECTED',
        entityType: 'Requisition',
        entityId: id,
        actorId,
        after: { wouldBreachBy: check.wouldBreachBy, remaining: check.remaining },
      });
      throw new RequisitionValidationError('Requisition exceeds the remaining budget.', {
        budget: check,
      });
    }

    // Vendor pre-check — warn (not block) if a preferred vendor is unverified.
    await this.warnUnverifiedPreferredVendors(pr.lines);

    await this.audit.record({
      action: 'SUBMITTED_FOR_APPROVAL',
      entityType: 'Requisition',
      entityId: id,
      actorId,
      after: { total: pr.totalAmount.toString() },
    });
    await this.routing.submit('REQUISITION', id, actorId);
    return { ok: true };
  }

  async withdraw(id: string, reason: string, actorId: string): Promise<{ ok: true }> {
    const pr = await this.requirePr(id);
    if (pr.status !== 'AWAITING_APPROVAL') {
      throw new RequisitionStateError('Only an awaiting-approval PR can be withdrawn.', {
        status: pr.status,
      });
    }
    await this.routing.withdraw('REQUISITION', id, actorId); // → DRAFT
    await this.audit.record({
      action: 'REQUISITION_WITHDRAWN',
      entityType: 'Requisition',
      entityId: id,
      actorId,
      after: { reason },
    });
    return { ok: true };
  }

  async cancel(id: string, reason: string, actorId: string): Promise<{ ok: true }> {
    const pr = await this.requirePr(id);
    const blocked: string[] = ['PARTIALLY_ISSUED', 'FULLY_ISSUED', 'CANCELLED', 'CLOSED'];
    if (blocked.includes(pr.status)) {
      throw new RequisitionStateError('This requisition can no longer be cancelled.', {
        status: pr.status,
      });
    }
    // Drop any pending approvals and release a committed budget.
    await this.prisma.client.approval.deleteMany({
      where: { documentType: 'REQUISITION', documentId: id },
    });
    await this.budgets.releaseForRequisition(id, reason, actorId);
    await this.prisma.client.requisition.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });
    await this.audit.record({
      action: 'REQUISITION_CANCELLED',
      entityType: 'Requisition',
      entityId: id,
      actorId,
      before: { status: pr.status },
      after: { reason },
    });
    return { ok: true };
  }

  /** Slice 4: post-approval revision is not allowed (cancel + re-create). */
  revise(_id: string, _actorId: string): never {
    throw new RequisitionReviseNotAllowedError(
      'Post-approval revision is not supported. Cancel and re-create instead.',
    );
  }

  async decide(
    approvalId: string,
    decision: 'APPROVE' | 'REJECT' | 'REQUEST_CHANGES',
    comment: string | null,
    actorId: string,
  ): Promise<{ ok: true }> {
    await this.routing.decide(approvalId, decision, comment, actorId);
    return { ok: true };
  }

  async addComment(id: string, body: string, actorId: string): Promise<{ id: string }> {
    await this.requirePr(id);
    const commentId = newId('requisitionComment');
    await this.prisma.client.requisitionComment.create({
      data: {
        id: commentId,
        tenantId: this.tenantId(),
        requisitionId: id,
        authorId: actorId,
        body,
      },
    });
    await this.audit.record({
      action: 'REQUISITION_COMMENT_ADDED',
      entityType: 'Requisition',
      entityId: id,
      actorId,
      after: { commentId },
    });
    return { id: commentId };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private taxContext(plantStateCode: string): ValidatorContext {
    // At PR stage no single vendor is bound, so tax is an intra-state estimate;
    // the real CGST/SGST vs IGST split is resolved at PO stage.
    return { plantStateCode, estimateWhenUnknown: true };
  }

  private async buildLines(
    lineInputs: RequisitionLineInput[],
    ctx: ValidatorContext,
  ): Promise<{
    lines: BuiltLine[];
    result: ReturnType<RequisitionValidator['validate']>;
  }> {
    const itemIds = lineInputs
      .map((l) => l.itemId)
      .filter((v): v is string => typeof v === 'string');
    const items = itemIds.length
      ? await this.prisma.client.item.findMany({ where: { id: { in: itemIds } } })
      : [];
    const itemById = new Map(items.map((i) => [i.id, i]));

    const validatorInputs: ValidatorLineInput[] = lineInputs.map((l, idx) => {
      const item = l.itemId ? itemById.get(l.itemId) : undefined;
      return {
        lineNo: idx + 1,
        itemId: l.itemId ?? null,
        itemDesc: l.itemDesc,
        hsnCode: l.hsnCode ?? item?.hsnCode ?? null,
        uom: l.uom,
        qty: l.qty,
        unitPrice: l.unitPrice,
        discountPct: l.discountPct,
        taxRate: l.taxRate,
        reasonCode: l.reasonCode ?? null,
        expectedGstRate: item?.gstRate.toString() ?? null,
      };
    });
    const result = this.validator.validate(validatorInputs, ctx);

    const lines: BuiltLine[] = lineInputs.map((l, idx) => {
      const item = l.itemId ? itemById.get(l.itemId) : undefined;
      const v = result.lines[idx];
      return {
        data: {
          id: newId('requisitionLine'),
          tenantId: this.tenantId(),
          lineNo: idx + 1,
          itemId: l.itemId ?? null,
          skuCode: item?.skuCode ?? null,
          itemDesc: l.itemDesc,
          hsnCode: l.hsnCode ?? item?.hsnCode ?? null,
          uom: l.uom,
          qty: new Prisma.Decimal(l.qty),
          unitPrice: new Prisma.Decimal(l.unitPrice),
          discountPct: new Prisma.Decimal(l.discountPct ?? '0'),
          taxRate: new Prisma.Decimal(l.taxRate),
          lineTotal: new Prisma.Decimal(v?.lineTotal ?? '0'),
          taxAmount: new Prisma.Decimal(v?.taxAmount ?? '0'),
          category: l.category ?? item?.category ?? null,
          subCategory: l.subCategory ?? item?.subcategory ?? null,
          notes: l.notes ?? null,
          preferredVendorId: l.preferredVendorId ?? null,
          reasonCode: l.reasonCode ?? null,
          isReverseCharge: v?.isReverseCharge ?? false,
        },
      };
    });
    return { lines, result };
  }

  private async warnUnverifiedPreferredVendors(
    lines: { preferredVendorId: string | null }[],
  ): Promise<void> {
    const vendorIds = [
      ...new Set(lines.map((l) => l.preferredVendorId).filter((v): v is string => !!v)),
    ];
    if (vendorIds.length === 0) return;
    const vendors = await this.prisma.client.vendor.findMany({
      where: { id: { in: vendorIds } },
      include: { banks: true },
    });
    const unverified = vendors.filter(
      (v) => v.status !== 'ACTIVE' || !v.banks.some((b) => b.isVerified),
    );
    for (const v of unverified) {
      await this.audit.record({
        action: 'REQUISITION_VENDOR_WARNING',
        entityType: 'Vendor',
        entityId: v.id,
        actorType: 'SYSTEM',
        after: { reason: 'preferred vendor unverified at PR submit', code: v.code },
      });
    }
  }

  private async resolveOrg(costCenterId: string, plantId: string) {
    const costCenter = await this.prisma.client.costCenter.findUnique({
      where: { id: costCenterId },
    });
    if (!costCenter) throw new NotFoundException('Cost center not found');
    const plant = await this.prisma.client.plant.findUnique({ where: { id: plantId } });
    if (!plant) throw new NotFoundException('Plant not found');
    return { costCenter, plant };
  }

  private async nextNumber(): Promise<string> {
    const latest = await this.prisma.client.requisition.findMany({
      where: { number: { startsWith: 'PR-' } },
      select: { number: true },
      orderBy: { number: 'desc' },
      take: 50,
    });
    let max = 1140;
    for (const r of latest) {
      const n = Number.parseInt(r.number.replace('PR-', ''), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return `PR-${max + 1}`;
  }

  private async snapshotLines(id: string) {
    const lines = await this.prisma.client.requisitionLine.findMany({
      where: { requisitionId: id },
      select: { lineNo: true, itemDesc: true, qty: true, unitPrice: true },
    });
    return lines.map((l) => ({
      lineNo: l.lineNo,
      itemDesc: l.itemDesc,
      qty: l.qty.toString(),
      unitPrice: l.unitPrice.toString(),
    }));
  }

  private async isTenantAdmin(userId: string): Promise<boolean> {
    const roles = await this.prisma.client.userRole.findMany({
      where: { userId },
      include: { role: true },
    });
    return roles.some((r) => r.role.name === 'TENANT_ADMIN');
  }

  private async requirePr(id: string) {
    const pr = await this.prisma.client.requisition.findUnique({ where: { id } });
    if (!pr) throw new NotFoundException('Requisition not found');
    return pr;
  }

  private tenantId(): string {
    const tid = this.prisma.currentTenantId;
    if (!tid) throw new Error('No tenant context');
    return tid;
  }
}
