import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  PERMISSIONS,
  RmaSchedulePickupInputSchema,
  type RmaSchedulePickupInput,
  type VendorGrnListResponse,
  type VendorRmaListResponse,
} from '@procureflow/shared';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequireAudience, RequirePermission } from '../auth/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { RmaDocumentService } from './rma-document.service';
import { VendorGrnService } from './vendor-grn.service';

/** Vendor-portal GRN/RMA endpoints — vendor JWT audience only (§3 #11). */
@Controller('vendor')
@RequireAudience('vendor')
export class VendorGrnController {
  constructor(
    private readonly vendor: VendorGrnService,
    private readonly pdf: RmaDocumentService,
  ) {}

  @Get('grn')
  @RequirePermission(PERMISSIONS.VENDOR_GRN_READ)
  async grns(@CurrentUser() user: AuthUser): Promise<VendorGrnListResponse> {
    return this.vendor.listGrns(user.userId);
  }

  @Get('rma')
  @RequirePermission(PERMISSIONS.VENDOR_RMA_READ)
  async rmas(@CurrentUser() user: AuthUser): Promise<VendorRmaListResponse> {
    return this.vendor.listRmas(user.userId);
  }

  @Get('rma/:id/pdf')
  @RequirePermission(PERMISSIONS.VENDOR_RMA_READ)
  async pdf_(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    await this.vendor.rmaPdfId(user.userId, id); // authorises + asserts availability
    const { buffer } = await this.pdf.generate(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${id}.pdf"`);
    res.send(buffer);
  }

  @Post('rma/:id/schedule-pickup')
  @RequirePermission(PERMISSIONS.VENDOR_RMA_SCHEDULE_PICKUP)
  async schedulePickup(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RmaSchedulePickupInputSchema))
    dto: RmaSchedulePickupInput,
  ): Promise<{ ok: true }> {
    return this.vendor.schedulePickup(user.userId, id, dto.pickupAt);
  }
}
