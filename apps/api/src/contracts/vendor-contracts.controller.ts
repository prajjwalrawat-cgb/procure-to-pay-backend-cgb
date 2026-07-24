import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  CountersignInputSchema,
  PERMISSIONS,
  type CountersignInput,
  type VendorContractDetailResponse,
  type VendorContractListItem,
} from '@procureflow/shared';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequireAudience, RequirePermission } from '../auth/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { ContractDocumentService } from './contract-document.service';
import { ContractQueryService } from './contract-query.service';
import { ContractService } from './contract.service';

/** Vendor-portal contract endpoints — vendor JWT audience only (§3 #11). */
@Controller('vendor/contracts')
@RequireAudience('vendor')
export class VendorContractsController {
  constructor(
    private readonly contracts: ContractService,
    private readonly query: ContractQueryService,
    private readonly pdf: ContractDocumentService,
  ) {}

  @Get()
  @RequirePermission(PERMISSIONS.VENDOR_CONTRACT_READ)
  async list(@CurrentUser() user: AuthUser): Promise<VendorContractListItem[]> {
    const vendorId = await this.query.resolveVendorId(user.userId);
    return this.query.vendorList(vendorId);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.VENDOR_CONTRACT_READ)
  async detail(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<VendorContractDetailResponse> {
    const vendorId = await this.query.resolveVendorId(user.userId);
    return this.query.vendorDetail(id, vendorId);
  }

  @Get(':id/pdf')
  @RequirePermission(PERMISSIONS.VENDOR_CONTRACT_READ)
  async pdfDownload(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    const vendorId = await this.query.resolveVendorId(user.userId);
    await this.query.vendorDetail(id, vendorId); // ownership guard
    const { buffer } = await this.pdf.generate(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="contract-${id}.pdf"`);
    res.send(buffer);
  }

  @Post(':id/countersign')
  @RequirePermission(PERMISSIONS.VENDOR_CONTRACT_COUNTERSIGN)
  async countersign(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CountersignInputSchema)) dto: CountersignInput,
  ): Promise<{ ok: true }> {
    const vendorId = await this.query.resolveVendorId(user.userId);
    return this.contracts.recordVendorCountersign(
      id,
      dto.s3Key,
      dto.filename,
      user.userId,
      vendorId,
    );
  }
}
