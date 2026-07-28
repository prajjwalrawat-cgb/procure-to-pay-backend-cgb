import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  AdjustmentInputSchema,
  CustomerReturnInputSchema,
  DamageWriteOffInputSchema,
  IssueCreateInputSchema,
  IssueReturnInputSchema,
  LedgerQuerySchema,
  LocationCreateInputSchema,
  LocationUpdateInputSchema,
  OrderFulfillInputSchema,
  PERMISSIONS,
  ProductCreateInputSchema,
  ProductListQuerySchema,
  ProductUpdateInputSchema,
  ReceiptCreateInputSchema,
  ReceiptQcInputSchema,
  RestockDecisionInputSchema,
  SampleInwardInputSchema,
  VendorReturnInputSchema,
  type AdjustmentInput,
  type CustomerReturnInput,
  type DamageWriteOffInput,
  type IssueCreateInput,
  type IssueReturnInput,
  type LedgerQuery,
  type LedgerResponse,
  type LocationCreateInput,
  type LocationListResponse,
  type LocationUpdateInput,
  type OrderFulfillInput,
  type PendingDispositionResponse,
  type ProductCreateInput,
  type ProductDetailResponse,
  type ProductListQuery,
  type ProductListResponse,
  type ProductStockResponse,
  type ProductUpdateInput,
  type ReceiptCreateInput,
  type ReceiptQcInput,
  type RestockDecisionInput,
  type SampleInwardInput,
  type VendorReturnInput,
} from '@procureflow/shared';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { InventoryIssueService } from './inventory-issue.service';
import { InventoryOrderService } from './inventory-order.service';
import { InventoryQueryService } from './inventory-query.service';
import { InventoryReceiptService } from './inventory-receipt.service';
import { LocationService } from './location.service';
import { ProductService } from './product.service';

/**
 * InventoryController (Slice 12). The warehouse inventory API.
 *
 * There is deliberately NO update or delete route for a ledger entry: the
 * ledger is insert-only and mistakes are corrected with an offsetting
 * ADJUSTMENT via POST /inventory/adjustments (business rule 6). A DB trigger
 * enforces the same invariant at the storage layer.
 *
 * Receiving and QC reuse the Slice 5 stores/QC permissions rather than minting
 * parallel ones — the same people do both jobs.
 */
@Controller('inventory')
export class InventoryController {
  constructor(
    private readonly products: ProductService,
    private readonly locations: LocationService,
    private readonly query: InventoryQueryService,
    private readonly receipts: InventoryReceiptService,
    private readonly issues: InventoryIssueService,
    private readonly orders: InventoryOrderService,
  ) {}

  // ══════════════════════ Products ══════════════════════

  @Get('products')
  @RequirePermission(PERMISSIONS.INVENTORY_READ)
  async listProducts(
    @Query(new ZodValidationPipe(ProductListQuerySchema)) q: ProductListQuery,
  ): Promise<ProductListResponse> {
    return this.query.listProducts(q);
  }

  @Get('products/:id')
  @RequirePermission(PERMISSIONS.INVENTORY_READ)
  async productDetail(@Param('id') id: string): Promise<ProductDetailResponse> {
    return this.query.productDetail(id);
  }

  @Get('products/:id/stock')
  @RequirePermission(PERMISSIONS.INVENTORY_READ)
  async productStock(@Param('id') id: string): Promise<ProductStockResponse> {
    return this.query.productStock(id);
  }

  @Post('products')
  @RequirePermission(PERMISSIONS.INVENTORY_PRODUCT_MANAGE)
  async createProduct(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(ProductCreateInputSchema)) dto: ProductCreateInput,
  ): Promise<{ id: string; code: string }> {
    return this.products.create(dto, user.userId);
  }

  @Patch('products/:id')
  @RequirePermission(PERMISSIONS.INVENTORY_PRODUCT_MANAGE)
  async updateProduct(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ProductUpdateInputSchema)) dto: ProductUpdateInput,
  ): Promise<{ ok: true }> {
    return this.products.update(id, dto, user.userId);
  }

  @Post('products/:id/deactivate')
  @RequirePermission(PERMISSIONS.INVENTORY_PRODUCT_MANAGE)
  async deactivateProduct(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    return this.products.deactivate(id, user.userId);
  }

  // ══════════════════════ Locations ══════════════════════

  @Get('locations')
  @RequirePermission(PERMISSIONS.INVENTORY_READ)
  async listLocations(
    @Query('includeInactive') includeInactive?: string,
  ): Promise<LocationListResponse> {
    return this.locations.list(includeInactive === 'true');
  }

  @Post('locations')
  @RequirePermission(PERMISSIONS.INVENTORY_PRODUCT_MANAGE)
  async createLocation(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(LocationCreateInputSchema)) dto: LocationCreateInput,
  ): Promise<{ id: string }> {
    return this.locations.create(dto, user.userId);
  }

  @Patch('locations/:id')
  @RequirePermission(PERMISSIONS.INVENTORY_PRODUCT_MANAGE)
  async updateLocation(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(LocationUpdateInputSchema)) dto: LocationUpdateInput,
  ): Promise<{ ok: true }> {
    return this.locations.update(id, dto, user.userId);
  }

  @Post('locations/:id/deactivate')
  @RequirePermission(PERMISSIONS.INVENTORY_PRODUCT_MANAGE)
  async deactivateLocation(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    return this.locations.deactivate(id, user.userId);
  }

  // ══════════════════════ Vendor-side movements ══════════════════════

  @Post('receipts')
  @RequirePermission(PERMISSIONS.STORES_RECEIVE_GOODS)
  async receive(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(ReceiptCreateInputSchema)) dto: ReceiptCreateInput,
  ): Promise<{ id: string }> {
    return this.receipts.receive(dto, user.userId);
  }

  @Post('receipts/:id/qc')
  @RequirePermission(PERMISSIONS.QC_INSPECT)
  async recordQc(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ReceiptQcInputSchema)) dto: ReceiptQcInput,
  ): Promise<{ ok: true; dispositionEntryId: string | null }> {
    return this.receipts.recordQc(id, dto, user.userId);
  }

  @Post('vendor-returns')
  @RequirePermission(PERMISSIONS.STORES_RECEIVE_GOODS)
  async vendorReturn(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(VendorReturnInputSchema)) dto: VendorReturnInput,
  ): Promise<{ id: string }> {
    return this.receipts.vendorReturn(dto, user.userId);
  }

  @Post('samples')
  @RequirePermission(PERMISSIONS.STORES_RECEIVE_GOODS)
  async sampleInward(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(SampleInwardInputSchema)) dto: SampleInwardInput,
  ): Promise<{ id: string }> {
    return this.receipts.sampleInward(dto, user.userId);
  }

  // ══════════════════════ Internal issues ══════════════════════

  @Post('issues')
  @RequirePermission(PERMISSIONS.INVENTORY_ISSUE)
  async issue(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(IssueCreateInputSchema)) dto: IssueCreateInput,
  ): Promise<{ id: string }> {
    return this.issues.issue(dto, user.userId);
  }

  @Post('issues/:id/return')
  @RequirePermission(PERMISSIONS.INVENTORY_ISSUE)
  async returnIssue(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(IssueReturnInputSchema)) dto: IssueReturnInput,
  ): Promise<{ id: string; balanceQty: number; status: 'OPEN' | 'CLOSED' }> {
    return this.issues.recordReturn(id, dto, user.userId);
  }

  // ══════════════════════ Customer orders & returns ══════════════════════

  @Post('orders/fulfill')
  @RequirePermission(PERMISSIONS.INVENTORY_FULFILL)
  async fulfill(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(OrderFulfillInputSchema)) dto: OrderFulfillInput,
  ): Promise<{ id: string }> {
    return this.orders.fulfill(dto, user.userId);
  }

  @Post('returns')
  @RequirePermission(PERMISSIONS.INVENTORY_FULFILL)
  async customerReturn(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CustomerReturnInputSchema)) dto: CustomerReturnInput,
  ): Promise<{ id: string }> {
    return this.orders.customerReturn(dto, user.userId);
  }

  @Post('returns/:id/restock-decision')
  @RequirePermission(PERMISSIONS.INVENTORY_FULFILL)
  async restockDecision(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RestockDecisionInputSchema)) dto: RestockDecisionInput,
  ): Promise<{ ok: true; writeOffEntryId: string | null }> {
    return this.orders.restockDecision(id, dto, user.userId);
  }

  // ══════════════════════ Housekeeping movements ══════════════════════

  @Post('damage')
  @RequirePermission(PERMISSIONS.INVENTORY_ADJUST)
  async damage(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(DamageWriteOffInputSchema)) dto: DamageWriteOffInput,
  ): Promise<{ id: string }> {
    return this.orders.writeOffDamage(dto, user.userId);
  }

  /** The only way to correct a posted entry — never an update or a delete. */
  @Post('adjustments')
  @RequirePermission(PERMISSIONS.INVENTORY_ADJUST)
  async adjust(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(AdjustmentInputSchema)) dto: AdjustmentInput,
  ): Promise<{ id: string }> {
    return this.orders.adjust(dto, user.userId);
  }

  // ══════════════════════ Ledger / reports ══════════════════════

  /** Powers every report screen; each legacy sheet is a saved filter over this. */
  @Get('ledger')
  @RequirePermission(PERMISSIONS.INVENTORY_READ)
  async ledger(
    @Query(new ZodValidationPipe(LedgerQuerySchema)) q: LedgerQuery,
  ): Promise<LedgerResponse> {
    return this.query.ledgerEntries(q);
  }

  @Get('pending-dispositions')
  @RequirePermission(PERMISSIONS.INVENTORY_READ)
  async pendingDispositions(): Promise<PendingDispositionResponse> {
    return this.query.pendingDispositions();
  }
}
