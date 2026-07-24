import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  Sse,
  type MessageEvent,
} from '@nestjs/common';
import {
  AwardDecisionInputSchema,
  AwardRecommendInputSchema,
  PERMISSIONS,
  QuoteEvaluateInputSchema,
  QuoteOpenInputSchema,
  QuoteQualifyInputSchema,
  ReverseAuctionStartInputSchema,
  RfqAnswerInputSchema,
  RfqCancelInputSchema,
  RfqCorrigendumInputSchema,
  RfqCreateInputSchema,
  RfqInvitationInputSchema,
  RfqListQuerySchema,
  RfqPublishInputSchema,
  RfqRemoveInvitationSchema,
  RfqUpdateInputSchema,
  type AwardDecisionInput,
  type AwardRecommendInput,
  type AwardView,
  type ComparisonMatrixResponse,
  type QuoteEvaluateInput,
  type QuoteOpenInput,
  type QuoteQualifyInput,
  type ReverseAuctionStartInput,
  type RfqAnswerInput,
  type RfqCancelInput,
  type RfqCorrigendumInput,
  type RfqCreateInput,
  type RfqDetailResponse,
  type RfqInvitationInput,
  type RfqListQuery,
  type RfqListResponse,
  type RfqPublishInput,
  type RfqQuestionView,
  type RfqRemoveInvitationInput,
  type RfqUpdateInput,
} from '@procureflow/shared';
import type { Response } from 'express';
import type { Observable } from 'rxjs';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { AwardJustificationService } from './award-justification.service';
import { AwardService } from './award.service';
import { QuoteEvaluationService } from './quote-evaluation.service';
import { QuoteOpenService } from './quote-open.service';
import { ReverseAuctionService } from './reverse-auction.service';
import { RfqQaService } from './rfq-qa.service';
import { RfqQueryService } from './rfq-query.service';
import { RfqService } from './rfq.service';

/** Buyer-portal sourcing endpoints (buyer JWT). */
@Controller('rfq')
export class RfqController {
  constructor(
    private readonly rfq: RfqService,
    private readonly query: RfqQueryService,
    private readonly qa: RfqQaService,
    private readonly open: QuoteOpenService,
    private readonly evaluation: QuoteEvaluationService,
    private readonly reverseAuction: ReverseAuctionService,
    private readonly award: AwardService,
    private readonly justification: AwardJustificationService,
  ) {}

  @Post()
  @RequirePermission(PERMISSIONS.SOURCING_MANAGE)
  async create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(RfqCreateInputSchema)) dto: RfqCreateInput,
  ): Promise<{ id: string }> {
    return this.rfq.createDraft(dto, user.userId);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.SOURCING_MANAGE)
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RfqUpdateInputSchema)) dto: RfqUpdateInput,
  ): Promise<{ ok: true }> {
    return this.rfq.updateDraft(id, dto, user.userId);
  }

  @Get()
  @RequirePermission(PERMISSIONS.SOURCING_READ)
  async list(
    @Query(new ZodValidationPipe(RfqListQuerySchema)) q: RfqListQuery,
  ): Promise<RfqListResponse> {
    return this.query.list(q);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.SOURCING_READ)
  async detail(@Param('id') id: string): Promise<RfqDetailResponse> {
    return this.query.detail(id);
  }

  @Post(':id/invitations')
  @RequirePermission(PERMISSIONS.SOURCING_MANAGE)
  async invite(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RfqInvitationInputSchema)) dto: RfqInvitationInput,
  ): Promise<{ added: number }> {
    return this.rfq.addInvitation(id, dto, user.userId);
  }

  @Delete(':id/invitations/:invitationId')
  @RequirePermission(PERMISSIONS.SOURCING_MANAGE)
  async removeInvitation(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('invitationId') invitationId: string,
    @Body(new ZodValidationPipe(RfqRemoveInvitationSchema)) dto: RfqRemoveInvitationInput,
  ): Promise<{ ok: true }> {
    return this.rfq.removeInvitation(id, invitationId, dto.reason, user.userId);
  }

  @Post(':id/publish')
  @RequirePermission(PERMISSIONS.SOURCING_MANAGE)
  async publish(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RfqPublishInputSchema)) dto: RfqPublishInput,
  ): Promise<{ status: string }> {
    return this.rfq.publish(id, dto, user.userId);
  }

  @Post(':id/corrigenda')
  @RequirePermission(PERMISSIONS.SOURCING_MANAGE)
  async corrigendum(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RfqCorrigendumInputSchema)) dto: RfqCorrigendumInput,
  ): Promise<{ id: string }> {
    return this.rfq.issueCorrigendum(id, dto, user.userId);
  }

  @Post(':id/cancel')
  @RequirePermission(PERMISSIONS.SOURCING_MANAGE)
  async cancel(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RfqCancelInputSchema)) dto: RfqCancelInput,
  ): Promise<{ ok: true }> {
    return this.rfq.cancel(id, dto.reason, user.userId);
  }

  @Get(':id/questions')
  @RequirePermission(PERMISSIONS.SOURCING_READ)
  async questions(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<RfqQuestionView[]> {
    return this.qa.listQuestions(id, { isVendor: false, userId: user.userId });
  }

  @Post(':id/questions/:questionId/answer')
  @RequirePermission(PERMISSIONS.SOURCING_MANAGE)
  async answer(
    @CurrentUser() user: AuthUser,
    @Param('questionId') questionId: string,
    @Body(new ZodValidationPipe(RfqAnswerInputSchema)) dto: RfqAnswerInput,
  ): Promise<{ ok: true }> {
    return this.qa.answerQuestion(questionId, dto, user.userId);
  }

  @Post(':id/open-technical')
  @RequirePermission(PERMISSIONS.SOURCING_OPEN_QUOTES)
  async openTechnical(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(QuoteOpenInputSchema)) dto: QuoteOpenInput,
  ): Promise<{ opened: number }> {
    return this.open.openTechnical(id, dto.participantUserIds, user.userId);
  }

  @Post(':id/quotes/:quoteId/qualify')
  @RequirePermission(PERMISSIONS.SOURCING_EVALUATE)
  async qualify(
    @CurrentUser() user: AuthUser,
    @Param('quoteId') quoteId: string,
    @Body(new ZodValidationPipe(QuoteQualifyInputSchema)) dto: QuoteQualifyInput,
  ): Promise<{ ok: true }> {
    return this.open.qualifyTechnically(quoteId, dto, user.userId);
  }

  @Post(':id/open-commercial')
  @RequirePermission(PERMISSIONS.SOURCING_OPEN_QUOTES)
  async openCommercial(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(QuoteOpenInputSchema)) dto: QuoteOpenInput,
  ): Promise<{ opened: number }> {
    return this.open.openCommercial(id, dto.participantUserIds, user.userId);
  }

  @Get(':id/comparison')
  @RequirePermission(PERMISSIONS.SOURCING_READ)
  async comparison(@Param('id') id: string): Promise<ComparisonMatrixResponse> {
    return this.evaluation.getComparisonMatrix(id, { isVendor: false });
  }

  @Post(':id/quotes/:quoteId/evaluate')
  @RequirePermission(PERMISSIONS.SOURCING_EVALUATE)
  async evaluate(
    @CurrentUser() user: AuthUser,
    @Param('quoteId') quoteId: string,
    @Body(new ZodValidationPipe(QuoteEvaluateInputSchema)) dto: QuoteEvaluateInput,
  ): Promise<{ ok: true }> {
    return this.evaluation.evaluateQuote(quoteId, dto, user.userId);
  }

  @Post(':id/auto-score')
  @RequirePermission(PERMISSIONS.SOURCING_EVALUATE)
  async autoScore(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<{ scored: number }> {
    return this.evaluation.autoScore(id, user.userId);
  }

  @Post(':id/reverse-auction/start')
  @RequirePermission(PERMISSIONS.SOURCING_MANAGE)
  async startRound(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ReverseAuctionStartInputSchema))
    dto: ReverseAuctionStartInput,
  ): Promise<{ id: string }> {
    return this.reverseAuction.startRound(id, dto, user.userId);
  }

  @Sse(':id/reverse-auction/:roundId/leaderboard/stream')
  @RequirePermission(PERMISSIONS.SOURCING_READ)
  leaderboardStream(@Param('roundId') roundId: string): Observable<MessageEvent> {
    return this.reverseAuction.stream(
      roundId,
      null,
    ) as unknown as Observable<MessageEvent>;
  }

  @Post(':id/awards')
  @RequirePermission(PERMISSIONS.SOURCING_AWARD)
  async recommendAward(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AwardRecommendInputSchema)) dto: AwardRecommendInput,
  ): Promise<{ id: string }> {
    return this.award.recommendAward(id, dto, user.userId);
  }

  @Get(':id/awards/:awardId')
  @RequirePermission(PERMISSIONS.SOURCING_READ)
  async awardDetail(@Param('awardId') awardId: string): Promise<AwardView> {
    return this.query.getAward(awardId);
  }

  @Post(':id/awards/:awardId/submit')
  @RequirePermission(PERMISSIONS.SOURCING_AWARD)
  async submitAward(
    @CurrentUser() user: AuthUser,
    @Param('awardId') awardId: string,
  ): Promise<{ ok: true }> {
    return this.award.submitForApproval(awardId, user.userId);
  }

  @Post(':id/awards/:awardId/decide')
  @RequirePermission(PERMISSIONS.APPROVAL_DECIDE)
  async decideAward(
    @CurrentUser() user: AuthUser,
    @Param('awardId') _awardId: string,
    @Body(new ZodValidationPipe(AwardDecisionInputSchema)) dto: AwardDecisionInput,
  ): Promise<{ ok: true }> {
    return this.award.decide(
      dto.approvalId,
      dto.decision,
      dto.comment ?? null,
      user.userId,
    );
  }

  @Get(':id/awards/:awardId/justification.pdf')
  @RequirePermission(PERMISSIONS.SOURCING_READ)
  async justificationPdf(
    @Param('awardId') awardId: string,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer } = await this.justification.generate(awardId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${awardId}-justification.pdf"`,
    );
    res.send(buffer);
  }
}
