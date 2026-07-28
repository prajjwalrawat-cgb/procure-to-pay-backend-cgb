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
  controllers: [InventoryController, BulkImportsController],
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
  ],
  exports: [InventoryLedgerService, InventoryQueryService, ProductService, LocationService],
})
export class InventoryModule {}
