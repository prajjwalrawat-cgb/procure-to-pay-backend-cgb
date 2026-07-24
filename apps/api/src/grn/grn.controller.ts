import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  GrnAttachmentInputSchema,
  GrnCompleteQcInputSchema,
  GrnCreateInputSchema,
  GrnHoldInputSchema,
  GrnListQuerySchema,
  GrnQcSampleInputSchema,
  GrnReverseInputSchema,
  GrnUpdateInputSchema,
  PERMISSIONS,
  type GrnAttachmentInput,
  type GrnCompleteQcInput,
  type GrnCreateInput,
  type GrnDetailResponse,
  type GrnHoldInput,
  type GrnListQuery,
  type GrnListResponse,
  type GrnQcSampleInput,
  type GrnReverseInput,
  type GrnUpdateInput,
} from '@procureflow/shared';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { GrnQueryService } from './grn-query.service';
import { GrnService } from './grn.service';

@Controller('grn')
export class GrnController {
  constructor(
    private readonly grn: GrnService,
    private readonly query: GrnQueryService,
  ) {}

  @Get()
  @RequirePermission(PERMISSIONS.GRN_READ)
  async list(
    @Query(new ZodValidationPipe(GrnListQuerySchema)) q: GrnListQuery,
  ): Promise<GrnListResponse> {
    return this.query.list(q);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.GRN_READ)
  async detail(@Param('id') id: string): Promise<GrnDetailResponse> {
    return this.query.detail(id);
  }

  @Post()
  @RequirePermission(PERMISSIONS.STORES_RECEIVE_GOODS)
  async create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(GrnCreateInputSchema)) dto: GrnCreateInput,
  ): Promise<{ id: string }> {
    return this.grn.createDraft(dto, user.userId);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.STORES_RECEIVE_GOODS)
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(GrnUpdateInputSchema)) dto: GrnUpdateInput,
  ): Promise<{ ok: true }> {
    return this.grn.updateDraft(id, dto, user.userId);
  }

  @Post(':id/submit')
  @RequirePermission(PERMISSIONS.STORES_RECEIVE_GOODS)
  async submit(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    return this.grn.submit(id, user.userId);
  }

  @Post(':id/start-qc')
  @RequirePermission(PERMISSIONS.QC_INSPECT)
  async startQc(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    return this.grn.startQc(id, user.userId);
  }

  @Post(':id/samples')
  @RequirePermission(PERMISSIONS.QC_INSPECT)
  async recordSample(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(GrnQcSampleInputSchema)) dto: GrnQcSampleInput,
  ): Promise<{ id: string; result: string }> {
    return this.grn.recordQcSample(id, dto, user.userId);
  }

  @Post(':id/complete-qc')
  @RequirePermission(PERMISSIONS.QC_INSPECT)
  async completeQc(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(GrnCompleteQcInputSchema)) dto: GrnCompleteQcInput,
  ): Promise<{ ok: true }> {
    return this.grn.completeQc(id, dto, user.userId);
  }

  @Post(':id/post')
  @RequirePermission(PERMISSIONS.STORES_RECEIVE_GOODS)
  async post(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    return this.grn.post(id, user.userId);
  }

  @Post(':id/reverse')
  @RequirePermission(PERMISSIONS.STORES_REVERSE_GRN)
  async reverse(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(GrnReverseInputSchema)) dto: GrnReverseInput,
  ): Promise<{ ok: true }> {
    return this.grn.reverse(id, dto.reason, user.userId);
  }

  @Post(':id/hold')
  @RequirePermission(PERMISSIONS.STORES_RECEIVE_GOODS)
  async hold(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(GrnHoldInputSchema)) dto: GrnHoldInput,
  ): Promise<{ ok: true }> {
    return this.grn.hold(id, dto.reason, user.userId);
  }

  @Post(':id/attachments')
  @RequirePermission(PERMISSIONS.STORES_RECEIVE_GOODS)
  async attach(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(GrnAttachmentInputSchema)) dto: GrnAttachmentInput,
  ): Promise<{ id: string }> {
    return this.grn.addAttachment(id, dto, user.userId);
  }
}
