import { Module } from '@nestjs/common';

import { ApprovalsModule } from '../approvals/approvals.module';
import { DomainEventsModule } from '../common/events/domain-event.service';
import { StorageModule } from '../common/storage/storage.service';
import { ComplianceModule } from '../compliance/compliance.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { GrnQueryService } from './grn-query.service';
import { GrnController } from './grn.controller';
import { GrnService } from './grn.service';
import { InventoryValuationService } from './inventory-valuation.service';
import { QcParameterEvaluator } from './qc-parameter-evaluator';
import { RmaDocumentService } from './rma-document.service';
import { RmaQueryService } from './rma-query.service';
import { RmaController } from './rma.controller';
import { RmaService } from './rma.service';
import { SamplingPlanService } from './sampling-plan.service';
import { StockController } from './stock.controller';
import { StockLedgerService } from './stock-ledger.service';
import { VendorGrnController } from './vendor-grn.controller';
import { VendorGrnService } from './vendor-grn.service';

/**
 * Goods receipt + stores (Slice 5). Gate-to-post GRN lifecycle, AQL QC, stock
 * ledger, RMA returns, and vendor-portal views. Depends on InvoicesModule to
 * re-run the Slice 1 3-way match when a GRN posts (MatchEngine integration).
 */
@Module({
  imports: [
    ApprovalsModule,
    DomainEventsModule,
    StorageModule,
    InvoicesModule,
    ComplianceModule,
  ],
  controllers: [GrnController, RmaController, StockController, VendorGrnController],
  providers: [
    GrnService,
    GrnQueryService,
    RmaService,
    RmaQueryService,
    RmaDocumentService,
    VendorGrnService,
    SamplingPlanService,
    QcParameterEvaluator,
    InventoryValuationService,
    StockLedgerService,
  ],
  exports: [
    GrnService,
    SamplingPlanService,
    QcParameterEvaluator,
    InventoryValuationService,
  ],
})
export class GrnModule {}
