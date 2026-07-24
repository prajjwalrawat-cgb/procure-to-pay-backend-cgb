import { Module } from '@nestjs/common';

import { ApprovalsModule } from '../approvals/approvals.module';
import { BudgetsModule } from '../budgets/budgets.module';
import { DomainEventsModule } from '../common/events/domain-event.service';
import { ProcurementRefsController } from './procurement-refs.controller';
import { RequisitionApprovalHooks } from './requisition-approval.hooks';
import { RequisitionQueryService } from './requisition-query.service';
import { RequisitionValidator } from './requisition-validator';
import { RequisitionService } from './requisition.service';
import { RequisitionsController } from './requisitions.controller';

/**
 * Requisitions (Slice 4). Draft → submit → approve → convert. Reuses the Slice 2
 * approval engine and the Slice 4 BudgetService; commits budget on approval via
 * RequisitionApprovalHooks.
 */
@Module({
  imports: [ApprovalsModule, BudgetsModule, DomainEventsModule],
  controllers: [RequisitionsController, ProcurementRefsController],
  providers: [
    RequisitionService,
    RequisitionQueryService,
    RequisitionValidator,
    RequisitionApprovalHooks,
  ],
  exports: [RequisitionService, RequisitionValidator],
})
export class RequisitionsModule {}
