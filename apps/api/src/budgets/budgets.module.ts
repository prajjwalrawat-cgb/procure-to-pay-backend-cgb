import { Module } from '@nestjs/common';

import { DomainEventsModule } from '../common/events/domain-event.service';
import { BudgetService } from './budget.service';
import { BudgetsController } from './budgets.controller';

/**
 * Budgets (Slice 4). Owns the commitment lifecycle (ADR-009); the PR and PO
 * modules consume `BudgetService` to reserve, transfer, and release budget.
 */
@Module({
  imports: [DomainEventsModule],
  controllers: [BudgetsController],
  providers: [BudgetService],
  exports: [BudgetService],
})
export class BudgetsModule {}
