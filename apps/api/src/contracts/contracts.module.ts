import { Module } from '@nestjs/common';

import { ApprovalsModule } from '../approvals/approvals.module';
import { StorageModule } from '../common/storage/storage.service';
import { PurchaseOrdersModule } from '../purchase-orders/purchase-orders.module';
import { CallOffService } from './call-off.service';
import { ClauseLibraryService } from './clause-library.service';
import { ContractDocumentService } from './contract-document.service';
import { ContractQueryService } from './contract-query.service';
import { ContractRenewalService } from './contract-renewal.service';
import { ContractService } from './contract.service';
import { ContractsController } from './contracts.controller';
import { EscalationService } from './escalation.service';
import { VendorContractsController } from './vendor-contracts.controller';

/**
 * Contracts module (Slice 9). Reuses the Slice 2 approval engine (contract +
 * amendment routing) and the Slice 4 PurchaseOrderService (call-off creation via
 * `createFromContract`). PrismaModule / AuditModule / DomainEventsModule are
 * global, so only cross-module deps are imported here.
 */
@Module({
  imports: [ApprovalsModule, PurchaseOrdersModule, StorageModule],
  controllers: [ContractsController, VendorContractsController],
  providers: [
    ContractService,
    ContractQueryService,
    CallOffService,
    EscalationService,
    ContractRenewalService,
    ContractDocumentService,
    ClauseLibraryService,
  ],
  exports: [ContractService, ContractRenewalService],
})
export class ContractsModule {}
