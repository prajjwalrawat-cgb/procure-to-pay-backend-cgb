import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import {
  PERMISSIONS,
  PoAttachmentUploadMetaSchema,
  PoCancelInputSchema,
  PoCommentInputSchema,
  PoCreateInputSchema,
  PoDecisionInputSchema,
  PoHoldInputSchema,
  PoListQuerySchema,
  PoTermsSetInputSchema,
  PoUpdateInputSchema,
  type PoAttachmentUploadMeta,
  type PoAttachmentView,
  type PoCancelInput,
  type PoCommentInput,
  type PoCreateInput,
  type PoDecisionInput,
  type PoDetailResponse,
  type PoHoldInput,
  type PoListQuery,
  type PoListResponse,
  type PoTermView,
  type PoTermsSetInput,
  type PoUpdateInput,
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
import { PoAttachmentService } from './po-attachment.service';
import { PoDocumentService } from './po-document.service';
import { PoTermsService } from './po-terms.service';
import { PurchaseOrderQueryService } from './purchase-order-query.service';
import { PurchaseOrderService } from './purchase-order.service';
import { PurchaseOrderStateError } from './purchase-order.errors';

@Controller('purchase-orders')
export class PurchaseOrdersController {
  constructor(
    private readonly pos: PurchaseOrderService,
    private readonly query: PurchaseOrderQueryService,
    private readonly pdf: PoDocumentService,
    private readonly attachments: PoAttachmentService,
    private readonly terms: PoTermsService,
  ) {}

  @Get()
  @RequirePermission(PERMISSIONS.PURCHASE_ORDER_READ_TENANT)
  async list(
    @Query(new ZodValidationPipe(PoListQuerySchema)) q: PoListQuery,
  ): Promise<PoListResponse> {
    return this.query.list(q);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.PURCHASE_ORDER_READ_TENANT)
  async detail(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<PoDetailResponse> {
    return this.query.detail(id, user.userId);
  }

  @Get(':id/pdf')
  @RequirePermission(PERMISSIONS.PURCHASE_ORDER_READ_TENANT)
  async downloadPdf(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const po = await this.query.detail(id, '');
    if (!po.pdfAvailable) {
      throw new PurchaseOrderStateError('The PDF is available once the PO is issued.', {
        status: po.status,
      });
    }
    const { buffer } = await this.pdf.generate(id, {
      watermark: po.status === 'CANCELLED' ? 'CANCELLED' : undefined,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${po.number}.pdf"`);
    res.send(buffer);
  }

  @Post()
  @RequirePermission(PERMISSIONS.PURCHASE_ORDER_CREATE)
  async create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(PoCreateInputSchema)) dto: PoCreateInput,
  ): Promise<{ id: string }> {
    return this.pos.create(dto, user.userId);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.PURCHASE_ORDER_UPDATE)
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(PoUpdateInputSchema)) dto: PoUpdateInput,
  ): Promise<{ ok: true }> {
    return this.pos.updateDraft(id, dto, user.userId);
  }

  @Post(':id/submit')
  @RequirePermission(PERMISSIONS.PURCHASE_ORDER_UPDATE)
  async submit(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    return this.pos.submitForApproval(id, user.userId);
  }

  @Post(':id/decide')
  @RequirePermission(PERMISSIONS.APPROVAL_DECIDE)
  async decide(
    @CurrentUser() user: AuthUser,
    @Param('id') _id: string,
    @Body(new ZodValidationPipe(PoDecisionInputSchema)) dto: PoDecisionInput,
  ): Promise<{ ok: true }> {
    return this.pos.decide(
      dto.approvalId,
      dto.decision,
      dto.comment ?? null,
      user.userId,
    );
  }

  @Post(':id/issue')
  @RequirePermission(PERMISSIONS.PURCHASE_ORDER_ISSUE)
  async issue(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    return this.pos.issue(id, user.userId);
  }

  @Post(':id/cancel')
  @RequirePermission(PERMISSIONS.PURCHASE_ORDER_CANCEL)
  async cancel(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(PoCancelInputSchema)) dto: PoCancelInput,
  ): Promise<{ ok: true }> {
    return this.pos.cancel(id, dto.reason, user.userId);
  }

  @Post(':id/hold')
  @RequirePermission(PERMISSIONS.PURCHASE_ORDER_UPDATE)
  async hold(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(PoHoldInputSchema)) dto: PoHoldInput,
  ): Promise<{ ok: true }> {
    return this.pos.hold(id, dto.reason, user.userId);
  }

  @Post(':id/comments')
  @RequirePermission(PERMISSIONS.PURCHASE_ORDER_READ_TENANT)
  async comment(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(PoCommentInputSchema)) dto: PoCommentInput,
  ): Promise<{ id: string }> {
    return this.pos.addComment(id, dto.body, user.userId);
  }

  // ── Supporting documents ───────────────────────────────────────────────────
  // Buyer-side only. There is deliberately no equivalent on VendorPoController:
  // the quote a spot buy was priced from must not travel back to the supplier.

  @Get(':id/attachments')
  @RequirePermission(PERMISSIONS.PURCHASE_ORDER_READ_TENANT)
  async listAttachments(@Param('id') id: string): Promise<PoAttachmentView[]> {
    return this.attachments.list(id);
  }

  /**
   * Multipart upload of a single supporting document — for a spot buy this is
   * the offline vendor quote the order is raised against. Size cap and MIME
   * allow-list are enforced by the interceptor before this handler runs.
   *
   * Gated on read, not update: PROCUREMENT_OFFICER raises spot buys but holds no
   * `procurement_order:update`, and would otherwise be unable to attach the very
   * quote their own PO is priced from. State rules live in the service.
   */
  @Post(':id/attachments/upload')
  @RequirePermission(PERMISSIONS.PURCHASE_ORDER_READ_TENANT)
  @UseInterceptors(FileInterceptor('file', DOCUMENT_UPLOAD_OPTIONS))
  async uploadAttachment(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @UploadedFile()
    file:
      | { originalname: string; buffer: Buffer; mimetype: string; size?: number }
      | undefined,
    @Body(new ZodValidationPipe(PoAttachmentUploadMetaSchema))
    meta: PoAttachmentUploadMeta,
  ): Promise<PoAttachmentView> {
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
  @RequirePermission(PERMISSIONS.PURCHASE_ORDER_READ_TENANT)
  async removeAttachment(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
  ): Promise<{ ok: true }> {
    return this.attachments.remove(id, attachmentId, user.userId);
  }

  // ── Terms & conditions ─────────────────────────────────────────────────────

  @Get(':id/terms')
  @RequirePermission(PERMISSIONS.PURCHASE_ORDER_READ_TENANT)
  async listTerms(@Param('id') id: string): Promise<PoTermView[]> {
    return this.terms.list(id);
  }

  /** Replaces the whole set — array order becomes the order printed on the PDF. */
  @Put(':id/terms')
  @RequirePermission(PERMISSIONS.PURCHASE_ORDER_UPDATE)
  async setTerms(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(PoTermsSetInputSchema)) dto: PoTermsSetInput,
  ): Promise<PoTermView[]> {
    return this.terms.set(id, dto.terms, user.userId);
  }
}
