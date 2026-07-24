import { Injectable } from '@nestjs/common';
import { Prisma, newId } from '@procureflow/db';
import type { BudgetCheckResult, BudgetUtilization } from '@procureflow/shared';
import { DOMAIN_EVENTS } from '@procureflow/shared';
import Decimal from 'decimal.js';

import { AuditLogService } from '../audit/audit.service';
import { DomainEventService } from '../common/events/domain-event.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  BudgetBreachError,
  BudgetMissingError,
  BudgetTransferOverError,
  CurrencyMismatchError,
} from './budget.errors';

/** Commitment statuses that still reserve budget (live "committed"). */
const RESERVED = ['COMMITTED', 'PARTIALLY_TRANSFERRED'] as const;

/**
 * BudgetService — the reserve → transfer → consume → release lifecycle
 * (Slice 4, ADR-009). A `BudgetCommitment` bookkeeping table records every hold
 * so "remaining" is auditable rather than a computed guess; a denormalised
 * snapshot on the `Budget` row makes availability reads O(1).
 */
@Injectable()
export class BudgetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly events: DomainEventService,
  ) {}

  /** Pure read: allocated / committed / consumed / remaining for a cost center. */
  async checkAvailability(
    costCenterId: string,
    amount: string,
    asOfDate: Date = new Date(),
  ): Promise<BudgetCheckResult> {
    const budget = await this.activeBudget(costCenterId, asOfDate);
    if (!budget) {
      return {
        available: false,
        budgetId: null,
        costCenterId,
        allocated: '0.0000',
        committed: '0.0000',
        consumed: '0.0000',
        remaining: '0.0000',
        wouldBreachBy: new Decimal(amount).greaterThan(0)
          ? new Decimal(amount).toFixed(4)
          : null,
        period: null,
        currency: 'INR',
      };
    }

    const allocated = new Decimal(budget.allocatedAmount.toString());
    const committed = new Decimal(budget.committedAmount.toString());
    const consumed = new Decimal(budget.consumedAmount.toString());
    const remaining = allocated.minus(committed).minus(consumed);
    const req = new Decimal(amount);
    const available = req.lessThanOrEqualTo(remaining);

    return {
      available,
      budgetId: budget.id,
      costCenterId,
      allocated: allocated.toFixed(4),
      committed: committed.toFixed(4),
      consumed: consumed.toFixed(4),
      remaining: remaining.toFixed(4),
      wouldBreachBy: available ? null : req.minus(remaining).toFixed(4),
      period: {
        type: budget.periodType,
        start: budget.periodStart.toISOString(),
        end: budget.periodEnd.toISOString(),
      },
      currency: budget.currency,
    };
  }

  /** Alias used by the PR wizard's budget block — a zero-side-effect dry run. */
  simulateCommit(
    costCenterId: string,
    amount: string,
    asOfDate: Date = new Date(),
  ): Promise<BudgetCheckResult> {
    return this.checkAvailability(costCenterId, amount, asOfDate);
  }

  /**
   * Reserve `amount` against the cost center's budget for a requisition. Locks
   * the budget row (SELECT FOR UPDATE) to serialise concurrent commits, then
   * re-checks availability inside the lock before writing the commitment.
   */
  async commitAmount(
    costCenterId: string,
    requisitionId: string,
    amount: string,
    actorId: string,
    currency = 'INR',
  ): Promise<{ commitmentId: string; budgetId: string }> {
    if (currency !== 'INR') {
      throw new CurrencyMismatchError('Cost centers are INR-only in v1.', { currency });
    }
    const budget = await this.activeBudget(costCenterId, new Date(), true);
    if (!budget) {
      throw new BudgetMissingError('No active budget for this cost center.', {
        costCenterId,
      });
    }
    const check = await this.checkAvailability(costCenterId, amount);
    if (!check.available) {
      throw new BudgetBreachError('Requisition exceeds the remaining budget.', {
        ...check,
      });
    }

    const commitment = await this.prisma.client.budgetCommitment.create({
      data: {
        id: newId('budgetCommitment'),
        tenantId: this.tenantId(),
        budgetId: budget.id,
        costCenterId,
        sourceType: 'PR',
        sourceId: requisitionId,
        requisitionId,
        amount: new Prisma.Decimal(new Decimal(amount).toFixed(4)),
        status: 'COMMITTED',
        committedBy: actorId,
      },
    });
    await this.recompute(budget.id);
    await this.audit.record({
      action: 'BUDGET_COMMITTED',
      entityType: 'Budget',
      entityId: budget.id,
      actorId,
      after: { commitmentId: commitment.id, requisitionId, amount },
    });
    await this.events.emit(DOMAIN_EVENTS.BUDGET_COMMITTED, {
      budgetId: budget.id,
      commitmentId: commitment.id,
      costCenterId,
      sourceType: 'PR',
      sourceId: requisitionId,
      amount,
    });
    return { commitmentId: commitment.id, budgetId: budget.id };
  }

  /** Reserve budget for a non-PR-backed spot buy (creates a PO commitment). */
  async commitSpotBuy(
    costCenterId: string,
    poId: string,
    amount: string,
    actorId: string,
    currency = 'INR',
  ): Promise<{ commitmentId: string; budgetId: string }> {
    if (currency !== 'INR') {
      throw new CurrencyMismatchError('Cost centers are INR-only in v1.', { currency });
    }
    const budget = await this.activeBudget(costCenterId, new Date(), true);
    if (!budget) {
      throw new BudgetMissingError('No active budget for this cost center.', {
        costCenterId,
      });
    }
    const check = await this.checkAvailability(costCenterId, amount);
    if (!check.available) {
      throw new BudgetBreachError('Spot buy exceeds the remaining budget.', {
        ...check,
      });
    }
    const commitment = await this.prisma.client.budgetCommitment.create({
      data: {
        id: newId('budgetCommitment'),
        tenantId: this.tenantId(),
        budgetId: budget.id,
        costCenterId,
        sourceType: 'SPOT_BUY',
        sourceId: poId,
        poId,
        amount: new Prisma.Decimal(new Decimal(amount).toFixed(4)),
        status: 'COMMITTED',
        committedBy: actorId,
      },
    });
    await this.recompute(budget.id);
    await this.audit.record({
      action: 'BUDGET_COMMITTED',
      entityType: 'Budget',
      entityId: budget.id,
      actorId,
      after: { commitmentId: commitment.id, poId, amount, sourceType: 'SPOT_BUY' },
    });
    await this.events.emit(DOMAIN_EVENTS.BUDGET_COMMITTED, {
      budgetId: budget.id,
      commitmentId: commitment.id,
      costCenterId,
      sourceType: 'SPOT_BUY',
      sourceId: poId,
      amount,
    });
    return { commitmentId: commitment.id, budgetId: budget.id };
  }

  /**
   * Transfer part (or all) of a PR commitment onto an issued PO. The PR
   * commitment's reserved remainder shrinks; a fresh PO commitment holds the
   * transferred amount. Over-transfer is refused (needs explicit re-approval).
   */
  async transferToPo(
    prCommitmentId: string,
    poId: string,
    amount: string,
    actorId: string,
  ): Promise<{ poCommitmentId: string }> {
    const pr = await this.prisma.client.budgetCommitment.findUnique({
      where: { id: prCommitmentId },
    });
    if (!pr) throw new BudgetTransferOverError('PR commitment not found.');
    await this.lockBudget(pr.budgetId);

    const remaining = new Decimal(pr.amount.toString());
    const transfer = new Decimal(amount);
    if (transfer.greaterThan(remaining)) {
      throw new BudgetTransferOverError('PO exceeds the PR budget commitment.', {
        prCommitmentId,
        remaining: remaining.toFixed(4),
        requested: transfer.toFixed(4),
      });
    }

    const newRemaining = remaining.minus(transfer);
    await this.prisma.client.budgetCommitment.update({
      where: { id: prCommitmentId },
      data: {
        amount: new Prisma.Decimal(newRemaining.toFixed(4)),
        status: newRemaining.isZero() ? 'TRANSFERRED' : 'PARTIALLY_TRANSFERRED',
      },
    });
    const poCommitment = await this.prisma.client.budgetCommitment.create({
      data: {
        id: newId('budgetCommitment'),
        tenantId: this.tenantId(),
        budgetId: pr.budgetId,
        costCenterId: pr.costCenterId,
        sourceType: 'PO',
        sourceId: poId,
        requisitionId: pr.requisitionId,
        poId,
        amount: new Prisma.Decimal(transfer.toFixed(4)),
        status: 'COMMITTED',
        committedBy: actorId,
      },
    });
    await this.recompute(pr.budgetId);
    await this.audit.record({
      action: 'BUDGET_TRANSFERRED',
      entityType: 'Budget',
      entityId: pr.budgetId,
      actorId,
      before: { prCommitmentId, remaining: remaining.toFixed(4) },
      after: { poCommitmentId: poCommitment.id, poId, amount },
    });
    await this.events.emit(DOMAIN_EVENTS.BUDGET_TRANSFERRED, {
      fromCommitmentId: prCommitmentId,
      toCommitmentId: poCommitment.id,
      budgetId: pr.budgetId,
      poId,
      amount,
    });
    return { poCommitmentId: poCommitment.id };
  }

  /** Mark a commitment CONSUMED (GRN post / invoice approval — wired in later slices). */
  async consumeAmount(commitmentId: string, actorId: string): Promise<void> {
    const c = await this.prisma.client.budgetCommitment.findUnique({
      where: { id: commitmentId },
    });
    if (!c || c.status === 'CONSUMED' || c.status === 'RELEASED') return;
    await this.prisma.client.budgetCommitment.update({
      where: { id: commitmentId },
      data: { status: 'CONSUMED' },
    });
    await this.recompute(c.budgetId);
    await this.audit.record({
      action: 'BUDGET_CONSUMED',
      entityType: 'Budget',
      entityId: c.budgetId,
      actorId,
      after: { commitmentId, amount: c.amount.toString() },
    });
  }

  /** Release a single commitment (reversal). Amount returns to the budget. */
  async releaseAmount(
    commitmentId: string,
    reason: string,
    actorId: string,
  ): Promise<void> {
    const c = await this.prisma.client.budgetCommitment.findUnique({
      where: { id: commitmentId },
    });
    if (!c || c.status === 'RELEASED') return;
    await this.lockBudget(c.budgetId);
    await this.prisma.client.budgetCommitment.update({
      where: { id: commitmentId },
      data: { status: 'RELEASED', releasedAt: new Date(), releaseReason: reason },
    });
    await this.recompute(c.budgetId);
    await this.audit.record({
      action: 'BUDGET_RELEASED',
      entityType: 'Budget',
      entityId: c.budgetId,
      actorId,
      before: { commitmentId, status: c.status },
      after: { reason, amount: c.amount.toString() },
    });
    await this.events.emit(DOMAIN_EVENTS.BUDGET_RELEASED, {
      commitmentId,
      budgetId: c.budgetId,
      amount: c.amount.toString(),
      reason,
    });
  }

  /** Release every live commitment raised by a requisition (PR cancel/withdraw). */
  async releaseForRequisition(
    requisitionId: string,
    reason: string,
    actorId: string,
  ): Promise<void> {
    const commitments = await this.prisma.client.budgetCommitment.findMany({
      where: {
        requisitionId,
        sourceType: 'PR',
        status: { in: [...RESERVED] },
      },
    });
    for (const c of commitments) {
      await this.releaseAmount(c.id, reason, actorId);
    }
  }

  /**
   * Cancel a PO's budget: release its PO commitment and return the amount to the
   * originating PR commitment so the PR can be re-issued (cancellation cascade).
   */
  async releaseForPo(poId: string, reason: string, actorId: string): Promise<void> {
    const poCommitments = await this.prisma.client.budgetCommitment.findMany({
      where: { poId, sourceType: 'PO', status: 'COMMITTED' },
    });
    for (const po of poCommitments) {
      await this.lockBudget(po.budgetId);
      await this.prisma.client.budgetCommitment.update({
        where: { id: po.id },
        data: { status: 'RELEASED', releasedAt: new Date(), releaseReason: reason },
      });
      // Return the reservation to the PR commitment, if any.
      if (po.requisitionId) {
        const prCommitment = await this.prisma.client.budgetCommitment.findFirst({
          where: {
            requisitionId: po.requisitionId,
            sourceType: 'PR',
            status: { in: ['COMMITTED', 'PARTIALLY_TRANSFERRED', 'TRANSFERRED'] },
          },
        });
        if (prCommitment) {
          const restored = new Decimal(prCommitment.amount.toString()).plus(
            po.amount.toString(),
          );
          await this.prisma.client.budgetCommitment.update({
            where: { id: prCommitment.id },
            data: {
              amount: new Prisma.Decimal(restored.toFixed(4)),
              status: 'COMMITTED',
            },
          });
        }
      }
      await this.recompute(po.budgetId);
      await this.audit.record({
        action: 'BUDGET_RELEASED',
        entityType: 'Budget',
        entityId: po.budgetId,
        actorId,
        before: { poCommitmentId: po.id },
        after: { reason, amount: po.amount.toString(), restoredToPr: !!po.requisitionId },
      });
      await this.events.emit(DOMAIN_EVENTS.BUDGET_RELEASED, {
        commitmentId: po.id,
        budgetId: po.budgetId,
        amount: po.amount.toString(),
        reason,
      });
    }
  }

  async getUtilization(budgetId: string): Promise<BudgetUtilization> {
    const budget = await this.prisma.client.budget.findUniqueOrThrow({
      where: { id: budgetId },
    });
    const allocated = new Decimal(budget.allocatedAmount.toString());
    const committed = new Decimal(budget.committedAmount.toString());
    const consumed = new Decimal(budget.consumedAmount.toString());
    const pct = (v: Decimal): number =>
      allocated.isZero() ? 0 : Number(v.dividedBy(allocated).times(100).toFixed(2));
    return {
      budgetId,
      allocated: allocated.toFixed(4),
      committed: committed.toFixed(4),
      consumed: consumed.toFixed(4),
      remaining: allocated.minus(committed).minus(consumed).toFixed(4),
      committedPct: pct(committed),
      consumedPct: pct(consumed),
      currency: budget.currency,
    };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Recompute the denormalised committed/consumed snapshot from commitments. */
  private async recompute(budgetId: string): Promise<void> {
    const commitments = await this.prisma.client.budgetCommitment.findMany({
      where: { budgetId },
      select: { amount: true, status: true },
    });
    let committed = new Decimal(0);
    let consumed = new Decimal(0);
    for (const c of commitments) {
      if ((RESERVED as readonly string[]).includes(c.status)) {
        committed = committed.plus(c.amount.toString());
      } else if (c.status === 'CONSUMED') {
        consumed = consumed.plus(c.amount.toString());
      }
    }
    await this.prisma.client.budget.update({
      where: { id: budgetId },
      data: {
        committedAmount: new Prisma.Decimal(committed.toFixed(4)),
        consumedAmount: new Prisma.Decimal(consumed.toFixed(4)),
      },
    });
  }

  private async activeBudget(
    costCenterId: string,
    asOf: Date,
    lock = false,
  ): Promise<Prisma.BudgetGetPayload<Record<string, never>> | null> {
    const budget = await this.prisma.client.budget.findFirst({
      where: {
        costCenterId,
        isActive: true,
        periodStart: { lte: asOf },
        periodEnd: { gte: asOf },
      },
      orderBy: { periodStart: 'desc' },
    });
    if (budget && lock) await this.lockBudget(budget.id);
    return budget;
  }

  private async lockBudget(budgetId: string): Promise<void> {
    await this.prisma.client.$queryRawUnsafe(
      'SELECT 1 FROM "Budget" WHERE id = $1 FOR UPDATE',
      budgetId,
    );
  }

  private tenantId(): string {
    const tid = this.prisma.currentTenantId;
    if (!tid) throw new Error('No tenant context');
    return tid;
  }
}
