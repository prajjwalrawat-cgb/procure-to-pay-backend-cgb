import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { newId } from '@procureflow/db';
import {
  PERMISSIONS,
  TaxInvoiceInputSchema,
  VendorInvoiceSubmitInputSchema,
  type TaxInvoiceInput,
  type VendorInvoiceSubmitInput,
  type VendorPoOption,
} from '@procureflow/shared';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequireAudience, RequirePermission } from '../auth/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { StorageService } from '../common/storage/storage.service';
import {
  DOCUMENT_UPLOAD_OPTIONS,
  assertUploadSize,
  safeFilename,
} from '../common/upload/upload-options';
import {
  VendorInvoiceService,
  vendorUploadPrefix,
  type VendorInvoiceDetail,
  type VendorInvoiceSummary,
} from './vendor-invoice.service';

/**
 * Vendor-portal invoice endpoints. `@RequireAudience('vendor')` rejects buyer
 * tokens (Master Context §3 rule #11); the vendor is resolved from the JWT user.
 */
@Controller('vendor')
@RequireAudience('vendor')
export class VendorInvoicesController {
  constructor(
    private readonly vendor: VendorInvoiceService,
    private readonly storage: StorageService,
  ) {}

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
  ): Promise<VendorInvoiceDetail> {
    return this.vendor.getOwn(user.userId, id);
  }

  /**
   * Store the vendor's tax invoice and hand back the object key to submit with.
   *
   * Same shape as the buyer's `POST /invoices/upload`: the interceptor enforces
   * the size cap + MIME allow-list, and the filename is sanitised before it
   * becomes part of the key.
   */
  @Post('invoices/upload')
  @RequirePermission(PERMISSIONS.INVOICE_CREATE)
  @UseInterceptors(FileInterceptor('file', DOCUMENT_UPLOAD_OPTIONS))
  async upload(
    @CurrentUser() user: AuthUser,
    @UploadedFile()
    file:
      | { originalname: string; buffer: Buffer; mimetype: string; size?: number }
      | undefined,
  ): Promise<{ s3Key: string }> {
    assertUploadSize(file);
    if (!file?.buffer) {
      throw new BadRequestException('No file received — attach the tax invoice.');
    }
    const s3Key = `${vendorUploadPrefix(user.tenantId)}${newId('invoiceAttachment')}-${safeFilename(file.originalname)}`;
    await this.storage.put(s3Key, file.buffer, file.mimetype ?? 'application/pdf');
    return { s3Key };
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

  /** Replace one of the vendor's own proformas with its tax invoice. */
  @Post('invoices/:id/tax-invoice')
  @RequirePermission(PERMISSIONS.INVOICE_CREATE)
  async attachTaxInvoice(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(TaxInvoiceInputSchema)) dto: TaxInvoiceInput,
  ): Promise<{ ok: true }> {
    await this.vendor.attachTaxInvoice(user.tenantId, user.userId, id, dto);
    return { ok: true };
  }
}
