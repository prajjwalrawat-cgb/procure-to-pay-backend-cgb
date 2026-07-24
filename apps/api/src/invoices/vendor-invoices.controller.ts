import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  PERMISSIONS,
  VendorInvoiceSubmitInputSchema,
  type VendorInvoiceSubmitInput,
  type VendorPoOption,
} from '@procureflow/shared';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequireAudience, RequirePermission } from '../auth/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import {
  VendorInvoiceService,
  type VendorInvoiceSummary,
} from './vendor-invoice.service';

/**
 * Vendor-portal invoice endpoints. `@RequireAudience('vendor')` rejects buyer
 * tokens (Master Context §3 rule #11); the vendor is resolved from the JWT user.
 */
@Controller('vendor')
@RequireAudience('vendor')
export class VendorInvoicesController {
  constructor(private readonly vendor: VendorInvoiceService) {}

  @Get('pos')
  async openPos(@CurrentUser() user: AuthUser): Promise<VendorPoOption[]> {
    return this.vendor.openPos(user.userId);
  }

  @Get('invoices')
  async listOwn(@CurrentUser() user: AuthUser): Promise<VendorInvoiceSummary[]> {
    return this.vendor.listOwn(user.userId);
  }

  @Get('invoices/:id')
  async getOwn(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<VendorInvoiceSummary> {
    return this.vendor.getOwn(user.userId, id);
  }

  @Post('invoices')
  @RequirePermission(PERMISSIONS.INVOICE_CREATE)
  async submit(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(VendorInvoiceSubmitInputSchema))
    dto: VendorInvoiceSubmitInput,
  ): Promise<{ id: string }> {
    return this.vendor.submit(user.tenantId, user.userId, dto);
  }
}
