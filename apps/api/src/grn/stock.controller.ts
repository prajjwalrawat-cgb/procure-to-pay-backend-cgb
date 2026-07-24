import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  PERMISSIONS,
  StockMovementsQuerySchema,
  type StockBalanceView,
  type StockMovementsQuery,
  type StockMovementsResponse,
} from '@procureflow/shared';

import { RequirePermission } from '../auth/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { StockLedgerService } from './stock-ledger.service';

@Controller('stock')
export class StockController {
  constructor(private readonly stock: StockLedgerService) {}

  @Get('movements')
  @RequirePermission(PERMISSIONS.STOCK_READ)
  async movements(
    @Query(new ZodValidationPipe(StockMovementsQuerySchema)) q: StockMovementsQuery,
  ): Promise<StockMovementsResponse> {
    return this.stock.getMovements(q);
  }

  @Get('balance/:itemId')
  @RequirePermission(PERMISSIONS.STOCK_READ)
  async balance(@Param('itemId') itemId: string): Promise<StockBalanceView> {
    return this.stock.getBalance(itemId);
  }
}
