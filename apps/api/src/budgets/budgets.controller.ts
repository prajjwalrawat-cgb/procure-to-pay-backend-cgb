import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  BudgetAvailabilityQuerySchema,
  PERMISSIONS,
  type BudgetAvailabilityQuery,
  type BudgetCheckResult,
} from '@procureflow/shared';

import { RequirePermission } from '../auth/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { BudgetService } from './budget.service';

/** Live budget-availability lookup used by the PR wizard (Slice 4). */
@Controller()
export class BudgetsController {
  constructor(private readonly budgets: BudgetService) {}

  @Get('cost-centers/:id/budget')
  @RequirePermission(PERMISSIONS.BUDGET_READ)
  async availability(
    @Param('id') costCenterId: string,
    @Query(new ZodValidationPipe(BudgetAvailabilityQuerySchema))
    q: BudgetAvailabilityQuery,
  ): Promise<BudgetCheckResult> {
    const asOf = q.asOf ? new Date(q.asOf) : new Date();
    return this.budgets.checkAvailability(costCenterId, q.amount, asOf);
  }
}
