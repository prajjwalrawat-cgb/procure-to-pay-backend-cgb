import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  PERMISSIONS,
  RequisitionAttachmentUploadMetaSchema,
  RequisitionCancelInputSchema,
  RequisitionCommentInputSchema,
  RequisitionCreateInputSchema,
  RequisitionDecisionInputSchema,
  RequisitionListQuerySchema,
  RequisitionUpdateInputSchema,
  type RequisitionAttachmentUploadMeta,
  type RequisitionAttachmentView,
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
import { ZodValidationError } from '../common/errors/domain-error';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import {
  DOCUMENT_UPLOAD_OPTIONS,
  assertUploadSize,
  safeFilename,
} from '../common/upload/upload-options';
import { RequisitionAttachmentService } from './requisition-attachment.service';
import { RequisitionQueryService } from './requisition-query.service';
import { RequisitionService } from './requisition.service';

@Controller('requisitions')
export class RequisitionsController {
  constructor(
    private readonly requisitions: RequisitionService,
    private readonly query: RequisitionQueryService,
    private readonly attachments: RequisitionAttachmentService,
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

  // ── Attachments ────────────────────────────────────────────────────────────

  @Get(':id/attachments')
  @RequirePermission(PERMISSIONS.REQUISITION_READ_TENANT)
  async listAttachments(@Param('id') id: string): Promise<RequisitionAttachmentView[]> {
    return this.attachments.list(id);
  }

  /**
   * Multipart upload of a single supporting document (quote, vendor proforma
   * invoice, spec, drawing). Size cap and MIME allow-list are enforced by the
   * interceptor before this handler runs, same as the invoice upload path.
   *
   * One file per request — the shared DOCUMENT_UPLOAD_OPTIONS caps `files: 1`,
   * so the client posts a multi-file selection as parallel requests.
   */
  // Gated on read, not update: PROCUREMENT_OFFICER can raise a PR but has no
  // `requisition:update`, and would otherwise be blocked from attaching the
  // quote or PI to their own requisition. The real authorization — requester vs
  // approver vs post-approval lockout — lives in the service, same split as the
  // comments endpoint below.
  @Post(':id/attachments/upload')
  @RequirePermission(PERMISSIONS.REQUISITION_READ_TENANT)
  @UseInterceptors(FileInterceptor('file', DOCUMENT_UPLOAD_OPTIONS))
  async uploadAttachment(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @UploadedFile()
    file:
      | { originalname: string; buffer: Buffer; mimetype: string; size?: number }
      | undefined,
    @Body(new ZodValidationPipe(RequisitionAttachmentUploadMetaSchema))
    meta: RequisitionAttachmentUploadMeta,
  ): Promise<RequisitionAttachmentView> {
    assertUploadSize(file);
    if (!file?.buffer) {
      throw new ZodValidationError('No file was uploaded.', {
        issues: [{ path: 'file', message: 'A file is required.' }],
      });
    }
    return this.attachments.upload(
      id,
      {
        filename: safeFilename(file.originalname),
        buffer: file.buffer,
        mimeType: file.mimetype,
        sizeBytes: file.size ?? file.buffer.byteLength,
        docType: meta.docType,
        note: meta.note ?? null,
      },
      user.userId,
    );
  }

  @Delete(':id/attachments/:attachmentId')
  @RequirePermission(PERMISSIONS.REQUISITION_READ_TENANT)
  async removeAttachment(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
  ): Promise<{ ok: true }> {
    return this.attachments.remove(id, attachmentId, user.userId);
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
