import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  PERMISSIONS,
  RequisitionCancelInputSchema,
  RequisitionCommentInputSchema,
  RequisitionCreateInputSchema,
  RequisitionDecisionInputSchema,
  RequisitionListQuerySchema,
  RequisitionUpdateInputSchema,
  type RequisitionCancelInput,
  type RequisitionCommentInput,
  type RequisitionCreateInput,
  type RequisitionDecisionInput,
  type RequisitionDetailResponse,
  type RequisitionKanbanResponse,
  type RequisitionListQuery,
  type RequisitionListResponse,
  type RequisitionUpdateInput,
} from '@procureflow/shared';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { RequisitionQueryService } from './requisition-query.service';
import { RequisitionService } from './requisition.service';

@Controller('requisitions')
export class RequisitionsController {
  constructor(
    private readonly requisitions: RequisitionService,
    private readonly query: RequisitionQueryService,
  ) {}

  @Get('board')
  @RequirePermission(PERMISSIONS.REQUISITION_READ_TENANT)
  async board(@CurrentUser() user: AuthUser): Promise<RequisitionKanbanResponse> {
    return this.query.board(user.userId);
  }

  @Get()
  @RequirePermission(PERMISSIONS.REQUISITION_READ_TENANT)
  async list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(RequisitionListQuerySchema)) q: RequisitionListQuery,
  ): Promise<RequisitionListResponse> {
    return this.query.list(q, user.userId);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.REQUISITION_READ_TENANT)
  async detail(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<RequisitionDetailResponse> {
    return this.query.detail(id, user.userId);
  }

  @Post()
  @RequirePermission(PERMISSIONS.REQUISITION_CREATE)
  async create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(RequisitionCreateInputSchema))
    dto: RequisitionCreateInput,
  ): Promise<{ id: string }> {
    return this.requisitions.createDraft(dto, user.userId);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.REQUISITION_UPDATE)
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RequisitionUpdateInputSchema))
    dto: RequisitionUpdateInput,
  ): Promise<{ ok: true }> {
    return this.requisitions.updateDraft(id, dto, user.userId);
  }

  @Post(':id/submit')
  @RequirePermission(PERMISSIONS.REQUISITION_SUBMIT)
  async submit(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    return this.requisitions.submitForApproval(id, user.userId);
  }

  @Post(':id/withdraw')
  @RequirePermission(PERMISSIONS.REQUISITION_SUBMIT)
  async withdraw(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RequisitionCancelInputSchema))
    dto: RequisitionCancelInput,
  ): Promise<{ ok: true }> {
    return this.requisitions.withdraw(id, dto.reason, user.userId);
  }

  @Post(':id/cancel')
  @RequirePermission(PERMISSIONS.REQUISITION_CANCEL)
  async cancel(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RequisitionCancelInputSchema))
    dto: RequisitionCancelInput,
  ): Promise<{ ok: true }> {
    return this.requisitions.cancel(id, dto.reason, user.userId);
  }

  @Post(':id/decide')
  @RequirePermission(PERMISSIONS.APPROVAL_DECIDE)
  async decide(
    @CurrentUser() user: AuthUser,
    @Param('id') _id: string,
    @Body(new ZodValidationPipe(RequisitionDecisionInputSchema))
    dto: RequisitionDecisionInput,
  ): Promise<{ ok: true }> {
    return this.requisitions.decide(
      dto.approvalId,
      dto.decision,
      dto.comment ?? null,
      user.userId,
    );
  }

  @Post(':id/comments')
  @RequirePermission(PERMISSIONS.REQUISITION_READ_TENANT)
  async comment(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RequisitionCommentInputSchema))
    dto: RequisitionCommentInput,
  ): Promise<{ id: string }> {
    return this.requisitions.addComment(id, dto.body, user.userId);
  }
}
