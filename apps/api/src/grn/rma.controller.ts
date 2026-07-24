import { Body, Controller, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  PERMISSIONS,
  RmaCreditNoteInputSchema,
  RmaListQuerySchema,
  RmaPickupInputSchema,
  RmaUpdateInputSchema,
  type RmaCreditNoteInput,
  type RmaDetailResponse,
  type RmaListQuery,
  type RmaListResponse,
  type RmaPickupInput,
  type RmaUpdateInput,
} from '@procureflow/shared';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { RmaDocumentService } from './rma-document.service';
import { RmaQueryService } from './rma-query.service';
import { RmaService } from './rma.service';

@Controller('rma')
export class RmaController {
  constructor(
    private readonly rma: RmaService,
    private readonly query: RmaQueryService,
    private readonly pdf: RmaDocumentService,
  ) {}

  @Get()
  @RequirePermission(PERMISSIONS.RMA_READ)
  async list(
    @Query(new ZodValidationPipe(RmaListQuerySchema)) q: RmaListQuery,
  ): Promise<RmaListResponse> {
    return this.query.list(q);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.RMA_READ)
  async detail(@Param('id') id: string): Promise<RmaDetailResponse> {
    return this.query.detail(id);
  }

  @Get(':id/pdf')
  @RequirePermission(PERMISSIONS.RMA_READ)
  async downloadPdf(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const { buffer } = await this.pdf.generate(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${id}.pdf"`);
    res.send(buffer);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.RMA_MANAGE)
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RmaUpdateInputSchema)) dto: RmaUpdateInput,
  ): Promise<{ ok: true }> {
    return this.rma.updateDraft(id, dto, user.userId);
  }

  @Post(':id/issue')
  @RequirePermission(PERMISSIONS.RMA_MANAGE)
  async issue(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    return this.rma.issue(id, user.userId);
  }

  @Post(':id/pickup')
  @RequirePermission(PERMISSIONS.RMA_MANAGE)
  async pickup(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RmaPickupInputSchema)) dto: RmaPickupInput,
  ): Promise<{ ok: true }> {
    return this.rma.recordPickup(id, dto.vehicleOutNo, dto.gatePassOutNo, user.userId);
  }

  @Post(':id/credit-note')
  @RequirePermission(PERMISSIONS.RMA_MANAGE)
  async creditNote(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RmaCreditNoteInputSchema)) dto: RmaCreditNoteInput,
  ): Promise<{ ok: true }> {
    return this.rma.recordCreditNote(id, dto, user.userId);
  }

  @Post(':id/close')
  @RequirePermission(PERMISSIONS.RMA_MANAGE)
  async close(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    return this.rma.close(id, user.userId);
  }
}
