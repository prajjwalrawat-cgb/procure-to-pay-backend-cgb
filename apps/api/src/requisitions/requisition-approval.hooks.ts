import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DOMAIN_EVENTS } from '@procureflow/shared';

import { ApprovalRoutingService } from '../approvals/approval-routing.service';
import { BudgetService } from '../budgets/budget.service';
import { DomainEventService } from '../common/events/domain-event.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * RequisitionApprovalHooks (Slice 4). When the approval engine fully approves a
 * requisition it fires this hook (inside the deciding request's transaction):
 * the PR moves to APPROVED (engine) and its budget is committed here, then a
 * `RequisitionApproved` domain event is emitted for the PO module to react to.
 */
@Injectable()
export class RequisitionApprovalHooks implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly routing: ApprovalRoutingService,
    private readonly budgets: BudgetService,
    private readonly events: DomainEventService,
  ) {}

  onModuleInit(): void {
    this.routing.onApproved('REQUISITION', (prId, actorId) =>
      this.onApproved(prId, actorId),
    );
  }

  private async onApproved(prId: string, actorId: string): Promise<void> {
    const pr = await this.prisma.client.requisition.findUnique({ where: { id: prId } });
    if (!pr) return;

    // Idempotency: never double-commit if the hook re-fires.
    const existing = await this.prisma.client.budgetCommitment.count({
      where: { requisitionId: prId, sourceType: 'PR', status: { not: 'RELEASED' } },
    });
    if (existing === 0) {
      await this.budgets.commitAmount(
        pr.costCenterId,
        prId,
        pr.totalAmount.toString(),
        actorId,
        pr.currency,
      );
    }
    await this.events.emit(DOMAIN_EVENTS.REQUISITION_APPROVED, {
      requisitionId: prId,
      costCenterId: pr.costCenterId,
      totalAmount: pr.totalAmount.toString(),
    });
  }
}
