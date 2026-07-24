import { Body, Controller, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  PERMISSIONS,
  PoCancelInputSchema,
  PoCommentInputSchema,
  PoCreateInputSchema,
  PoDecisionInputSchema,
  PoHoldInputSchema,
  PoListQuerySchema,
  PoUpdateInputSchema,
  type PoCancelInput,
  type PoCommentInput,
  type PoCreateInput,
  type PoDecisionInput,
  type PoDetailResponse,
  type PoHoldInput,
  type PoListQuery,
  type PoListResponse,
  type PoUpdateInput,
} from '@procureflow/shared';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { PoDocumentService } from './po-document.service';
import { PurchaseOrderQueryService } from './purchase-order-query.service';
import { PurchaseOrderService } from './purchase-order.service';
import { PurchaseOrderStateError } from './purchase-order.errors';

@Controller('purchase-orders')
export class PurchaseOrdersController {
  constructor(
    private readonly pos: PurchaseOrderService,
    private readonly query: PurchaseOrderQueryService,
    private readonly pdf: PoDocumentService,
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
}
