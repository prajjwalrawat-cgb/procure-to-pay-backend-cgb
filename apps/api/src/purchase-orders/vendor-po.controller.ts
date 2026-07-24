import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  PERMISSIONS,
  VendorPoQueryInputSchema,
  type VendorPoDetailResponse,
  type VendorPoListResponse,
  type VendorPoQueryInput,
} from '@procureflow/shared';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequireAudience, RequirePermission } from '../auth/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { PoDocumentService } from './po-document.service';
import { VendorPoService } from './vendor-po.service';

/** Vendor-portal PO endpoints — vendor JWT audience only (Master Context §3 #11). */
@Controller('vendor/purchase-orders')
@RequireAudience('vendor')
export class VendorPoController {
  constructor(
    private readonly vendorPos: VendorPoService,
    private readonly pdf: PoDocumentService,
  ) {}

  @Get()
  @RequirePermission(PERMISSIONS.VENDOR_PO_READ)
  async list(@CurrentUser() user: AuthUser): Promise<VendorPoListResponse> {
    return this.vendorPos.list(user.userId);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.VENDOR_PO_READ)
  async detail(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<VendorPoDetailResponse> {
    return this.vendorPos.detail(user.userId, id);
  }

  @Get(':id/pdf')
  @RequirePermission(PERMISSIONS.VENDOR_PO_READ)
  async pdfDownload(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    await this.vendorPos.pdfKey(user.userId, id); // authorises + asserts availability
    const { buffer } = await this.pdf.generate(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${id}.pdf"`);
    res.send(buffer);
  }

  @Post(':id/acknowledge')
  @RequirePermission(PERMISSIONS.VENDOR_PO_ACKNOWLEDGE)
  async acknowledge(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<{ acknowledgedAt: string }> {
    return this.vendorPos.acknowledge(user.userId, id);
  }

  @Post(':id/query')
  @RequirePermission(PERMISSIONS.VENDOR_PO_QUERY)
  async query(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(VendorPoQueryInputSchema)) dto: VendorPoQueryInput,
  ): Promise<{ id: string }> {
    return this.vendorPos.raiseQuery(user.userId, id, dto.body);
  }
}
