import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { BulkImportProcessor } from './import/bulk-import.processor';
import { BulkImportService } from './import/bulk-import.service';
import { BulkImportsController } from './import/bulk-imports.controller';
import { InventoryController } from './inventory.controller';
import { InventoryIssueService } from './inventory-issue.service';
import { InventoryLedgerService } from './inventory-ledger.service';
import { InventoryOrderService } from './inventory-order.service';
import { InventoryQueryService } from './inventory-query.service';
import { InventoryReceiptService } from './inventory-receipt.service';
import { LocationService } from './location.service';
import { ProductService } from './product.service';
import { BoxMovementService } from './box/box-movement.service';
import { BoxController, ProductLocationController } from './box/box.controller';
import { BoxService } from './box/box.service';
import { LocationPathService } from './box/location-path.service';
import { FefoService } from './scan/fefo.service';
import { ScanBatchSyncService } from './scan/scan-batch-sync.service';
import { ScanController } from './scan/scan.controller';
import { ScanCycleCountService } from './scan/scan-cycle-count.service';
import { ScanMovementService } from './scan/scan-movement.service';
import { ScanPickService } from './scan/scan-pick.service';
import { ScanPutawayService } from './scan/scan-putaway.service';
import { ScanReceiveService } from './scan/scan-receive.service';
import { ScanResolveService } from './scan/scan-resolve.service';
import { ScanTransferService } from './scan/scan-transfer.service';

/**
 * InventoryModule (Slice 12) — the native warehouse inventory module.
 *
 * Runs alongside, not instead of, the Slice 5 GRN/StockLedger stack: that one
 * is the financial ledger (valuation, item + plant), this one is the physical
 * ledger (piece counts, product + location). Nothing auto-posts between them;
 * receipts here validate `purchaseOrderId` against the PO module and may carry
 * an informational `grnId` back-reference.
 */
@Module({
  imports: [AuditModule],
  controllers: [
    InventoryController,
    BulkImportsController,
    ScanController,
    BoxController,
    ProductLocationController,
  ],
  providers: [
    ProductService,
    LocationService,
    InventoryLedgerService,
    InventoryQueryService,
    InventoryReceiptService,
    InventoryIssueService,
    InventoryOrderService,
    BulkImportService,
    BulkImportProcessor,
    // Slice 13 mobile scanner
    ScanResolveService,
    FefoService,
    ScanMovementService,
    ScanReceiveService,
    ScanPutawayService,
    ScanPickService,
    ScanCycleCountService,
    ScanTransferService,
    ScanBatchSyncService,
    // Slice 14 physical box tracking
    LocationPathService,
    BoxService,
    BoxMovementService,
  ],
  exports: [InventoryLedgerService, InventoryQueryService, ProductService, LocationService],
})
export class InventoryModule {}
