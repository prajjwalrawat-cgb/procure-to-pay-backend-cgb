import { Module } from '@nestjs/common';

import { ApprovalsModule } from '../approvals/approvals.module';
import { BudgetsModule } from '../budgets/budgets.module';
import { DomainEventsModule } from '../common/events/domain-event.service';
import { StorageModule } from '../common/storage/storage.service';
import { PoDocumentService } from './po-document.service';
import { PurchaseOrderQueryService } from './purchase-order-query.service';
import { PurchaseOrderService } from './purchase-order.service';
import { PurchaseOrdersController } from './purchase-orders.controller';
import { VendorPoController } from './vendor-po.controller';
import { VendorPoService } from './vendor-po.service';

/**
 * Purchase orders (Slice 4). Convert approved PRs (split-award) or spot buys,
 * route through the Slice 2 engine, issue with a signed PDF, and expose a
 * sanitised vendor-portal view (separate JWT audience).
 */
@Module({
  imports: [ApprovalsModule, BudgetsModule, DomainEventsModule, StorageModule],
  controllers: [PurchaseOrdersController, VendorPoController],
  providers: [
    PurchaseOrderService,
    PurchaseOrderQueryService,
    PoDocumentService,
    VendorPoService,
  ],
  exports: [PurchaseOrderService, PoDocumentService],
})
export class PurchaseOrdersModule {}
