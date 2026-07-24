import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApprovalDecisionInputSchema,
  ApprovalDelegateInputSchema,
  BulkApproveInputSchema,
  InboxFilterSchema,
  PERMISSIONS,
  type ApprovalDecisionInput,
  type ApprovalDelegateInput,
  type ApprovalSidebarCounts,
  type BulkApproveInput,
  type DocumentType,
  type InboxFilter,
  type InboxResponse,
} from '@procureflow/shared';
import { z } from 'zod';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { ApprovalRoutingService } from './approval-routing.service';
import { InboxService } from './inbox.service';

const DocTypeParam = z.enum([
  'REQUISITION',
  'PURCHASE_ORDER',
  'GRN',
  'INVOICE',
  'PAYMENT_RUN',
  'CONTRACT',
]);

@Controller()
export class InboxController {
  constructor(
    private readonly inbox: InboxService,
    private readonly routing: ApprovalRoutingService,
  ) {}

  @Get('inbox')
  @RequirePermission(PERMISSIONS.APPROVAL_READ)
  async list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(InboxFilterSchema)) q: InboxFilter,
  ): Promise<InboxResponse> {
    return this.inbox.list(user.userId, q.filter);
  }

  @Get('inbox/sidebar')
  @RequirePermission(PERMISSIONS.APPROVAL_READ)
  async sidebar(@CurrentUser() user: AuthUser): Promise<ApprovalSidebarCounts> {
    return this.inbox.sidebarCounts(user.userId);
  }

  @Post('approvals/:approvalId/decide')
  @RequirePermission(PERMISSIONS.APPROVAL_DECIDE)
  async decide(
    @CurrentUser() user: AuthUser,
    @Param('approvalId') approvalId: string,
    @Body(new ZodValidationPipe(ApprovalDecisionInputSchema)) dto: ApprovalDecisionInput,
  ): Promise<{ ok: true }> {
    await this.routing.decide(approvalId, dto.decision, dto.comment ?? null, user.userId);
    return { ok: true };
  }

  @Post('approvals/:approvalId/delegate')
  @RequirePermission(PERMISSIONS.APPROVAL_DELEGATE)
  async delegate(
    @CurrentUser() user: AuthUser,
    @Param('approvalId') approvalId: string,
    @Body(new ZodValidationPipe(ApprovalDelegateInputSchema)) dto: ApprovalDelegateInput,
  ): Promise<{ ok: true }> {
    await this.routing.delegate(
      approvalId,
      dto.delegateToUserId,
      dto.reason,
      user.userId,
    );
    return { ok: true };
  }

  @Post('inbox/bulk-approve')
  @RequirePermission(PERMISSIONS.APPROVAL_DECIDE)
  async bulkApprove(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(BulkApproveInputSchema)) dto: BulkApproveInput,
  ): Promise<{ approved: number }> {
    let approved = 0;
    for (const approvalId of dto.approvalIds) {
      await this.routing.decide(approvalId, 'APPROVE', dto.comment ?? null, user.userId);
      approved += 1;
    }
    return { approved };
  }

  @Post('approvals/documents/:type/:id/withdraw')
  @RequirePermission(PERMISSIONS.APPROVAL_READ)
  async withdraw(
    @CurrentUser() user: AuthUser,
    @Param('type') type: string,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    const documentType: DocumentType = DocTypeParam.parse(type);
    await this.routing.withdraw(documentType, id, user.userId);
    return { ok: true };
  }
}
