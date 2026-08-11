import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  BlacklistVendorInputSchema,
  CancelOnboardingInputSchema,
  InviteVendorInputSchema,
  LiftSuspensionInputSchema,
  OnboardingDecisionInputSchema,
  OnboardingListQuerySchema,
  PERMISSIONS,
  RenameVendorInputSchema,
  ReturnForInfoInputSchema,
  ReviewScreeningInputSchema,
  ScorecardQuerySchema,
  SuspendVendorInputSchema,
  TriggerScreeningInputSchema,
  VendorListQuerySchema,
  VerifyDocumentInputSchema,
  type ApprovalDecisionAction,
  type BlacklistVendorInput,
  type CancelOnboardingInput,
  type InviteVendorInput,
  type LiftSuspensionInput,
  type OnboardingDecisionInput,
  type OnboardingDetailResponse,
  type OnboardingListQuery,
  type OnboardingListResponse,
  type RenameVendorInput,
  type ReturnForInfoInput,
  type ReviewScreeningInput,
  type ScorecardQuery,
  type SuspendVendorInput,
  type TriggerScreeningInput,
  type Vendor360Response,
  type VendorListQuery,
  type VendorListResponse,
  type VendorScorecardView,
  type VerifyDocumentInput,
} from '@procureflow/shared';

import { ApprovalRoutingService } from '../approvals/approval-routing.service';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { VendorLifecycleService } from './vendor-lifecycle.service';
import { VendorOnboardingService } from './vendor-onboarding.service';
import { VendorQueryService } from './vendor-query.service';
import { VendorScorecardService } from './vendor-scorecard.service';
import { VendorScreeningRefreshService } from './vendor-screening-refresh.service';
import { VendorVerificationService } from './vendor-verification.service';
import { VendorDocumentService } from './vendor-document.service';

/** Buyer-portal vendor master + onboarding review endpoints (buyer JWT). */
@Controller('vendors')
export class VendorsController {
  constructor(
    private readonly onboarding: VendorOnboardingService,
    private readonly query: VendorQueryService,
    private readonly documents: VendorDocumentService,
    private readonly verification: VendorVerificationService,
    private readonly scorecard: VendorScorecardService,
    private readonly lifecycle: VendorLifecycleService,
    private readonly routing: ApprovalRoutingService,
    private readonly screeningRefresh: VendorScreeningRefreshService,
  ) {}

  // ── Onboarding review queue (declared before /:id) ─────────────────────────

  @Get('onboarding')
  @RequirePermission(PERMISSIONS.VENDOR_ONBOARDING_REVIEW)
  async onboardingQueue(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(OnboardingListQuerySchema)) q: OnboardingListQuery,
  ): Promise<OnboardingListResponse> {
    return this.query.listOnboardings(
      q,
      user.userId,
      user.perms.includes(PERMISSIONS.VENDOR_ONBOARDING_CANCEL),
    );
  }

  @Get('onboarding/:id')
  @RequirePermission(PERMISSIONS.VENDOR_ONBOARDING_REVIEW)
  async onboardingDetail(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<OnboardingDetailResponse> {
    return this.query.onboardingDetail(id, user.userId);
  }

  @Post('invite')
  @RequirePermission(PERMISSIONS.VENDOR_INVITE)
  async invite(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(InviteVendorInputSchema)) dto: InviteVendorInput,
  ): Promise<{ vendorId: string; onboardingId: string }> {
    return this.onboarding.inviteVendor(dto, user.userId);
  }

  @Post('onboarding/:id/decision')
  @RequirePermission(PERMISSIONS.VENDOR_ONBOARDING_REVIEW)
  async decideOnboarding(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(OnboardingDecisionInputSchema))
    dto: OnboardingDecisionInput,
  ): Promise<{ ok: true }> {
    await this.routing.decide(
      dto.approvalId,
      decisionAction(dto.decision),
      dto.comment ?? null,
      user.userId,
    );
    return { ok: true };
  }

  /**
   * Withdraw an invitation the vendor never submitted. Admin-only
   * (VENDOR_ONBOARDING_CANCEL): the onboarding queue is shared across all
   * procurement officers, so a permission every inviter held would let one
   * officer cancel another's vendor.
   */
  @Post('onboarding/:id/cancel')
  @RequirePermission(PERMISSIONS.VENDOR_ONBOARDING_CANCEL)
  async cancelOnboarding(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CancelOnboardingInputSchema)) dto: CancelOnboardingInput,
  ): Promise<{ ok: true }> {
    return this.onboarding.cancelOnboarding(
      id,
      dto,
      user.userId,
      user.perms.includes(PERMISSIONS.VENDOR_SUSPEND),
    );
  }

  @Post('onboarding/:id/return')
  @RequirePermission(PERMISSIONS.VENDOR_ONBOARDING_REVIEW)
  async returnForInfo(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ReturnForInfoInputSchema)) dto: ReturnForInfoInput,
  ): Promise<{ ok: true }> {
    return this.onboarding.returnForInfo(id, dto, user.userId);
  }

  // ── Document + screening review ────────────────────────────────────────────

  @Post('documents/:docId/verify')
  @RequirePermission(PERMISSIONS.VENDOR_DOC_VERIFY)
  async verifyDocument(
    @CurrentUser() user: AuthUser,
    @Param('docId') docId: string,
    @Body(new ZodValidationPipe(VerifyDocumentInputSchema)) dto: VerifyDocumentInput,
  ): Promise<{ ok: true }> {
    return this.documents.verifyDocument(
      docId,
      dto.decision,
      dto.reason ?? null,
      user.userId,
    );
  }

  @Post(':id/screenings')
  @RequirePermission(PERMISSIONS.VENDOR_SCREENING_REVIEW)
  async triggerScreening(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(TriggerScreeningInputSchema)) dto: TriggerScreeningInput,
  ): Promise<{ id: string; status: string }> {
    return this.verification.runScreening(id, dto.screeningType, user.userId);
  }

  /** Slice 10c — re-screen every active vendor for a type (e.g. quarterly sanctions). */
  @Post('screenings/rescreen-all')
  @RequirePermission(PERMISSIONS.VENDOR_SCREENING_REVIEW)
  async rescreenAll(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(TriggerScreeningInputSchema)) dto: TriggerScreeningInput,
  ): Promise<{ vendors: number; flagged: number }> {
    return this.screeningRefresh.rescreenAll(dto.screeningType, user.userId);
  }

  @Post('screenings/:screeningId/review')
  @RequirePermission(PERMISSIONS.VENDOR_SCREENING_REVIEW)
  async reviewScreening(
    @CurrentUser() user: AuthUser,
    @Param('screeningId') screeningId: string,
    @Body(new ZodValidationPipe(ReviewScreeningInputSchema)) dto: ReviewScreeningInput,
  ): Promise<{ ok: true }> {
    return this.verification.reviewScreeningFinding(
      screeningId,
      dto.decision,
      dto.notes ?? null,
      user.userId,
    );
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  @Post(':id/suspend')
  @RequirePermission(PERMISSIONS.VENDOR_SUSPEND)
  async suspend(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(SuspendVendorInputSchema)) dto: SuspendVendorInput,
  ): Promise<{ id: string }> {
    return this.lifecycle.suspendVendor(id, dto, user.userId);
  }

  @Post('suspensions/:suspensionId/lift')
  @RequirePermission(PERMISSIONS.VENDOR_SUSPEND)
  async lift(
    @CurrentUser() user: AuthUser,
    @Param('suspensionId') suspensionId: string,
    @Body(new ZodValidationPipe(LiftSuspensionInputSchema)) dto: LiftSuspensionInput,
  ): Promise<{ ok: true }> {
    return this.lifecycle.liftSuspension(suspensionId, dto.liftReason, user.userId);
  }

  @Post(':id/blacklist')
  @RequirePermission(PERMISSIONS.VENDOR_BLACKLIST)
  async blacklist(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(BlacklistVendorInputSchema)) dto: BlacklistVendorInput,
  ): Promise<{ id: string }> {
    return this.lifecycle.blacklistVendor(id, dto, user.userId);
  }

  // ── Change-request approval decision ───────────────────────────────────────

  @Post('changes/:changeRequestId/decision')
  @RequirePermission(PERMISSIONS.VENDOR_CHANGE_APPROVE)
  async decideChange(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(OnboardingDecisionInputSchema))
    dto: OnboardingDecisionInput,
  ): Promise<{ ok: true }> {
    await this.routing.decide(
      dto.approvalId,
      decisionAction(dto.decision),
      dto.comment ?? null,
      user.userId,
    );
    return { ok: true };
  }

  // ── Scorecard ──────────────────────────────────────────────────────────────

  @Post(':id/scorecard/recompute')
  @RequirePermission(PERMISSIONS.VENDOR_SCORECARD_READ)
  async recomputeScorecard(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query(new ZodValidationPipe(ScorecardQuerySchema)) q: ScorecardQuery,
  ): Promise<{ id: string; score: number | null; grade: string }> {
    return this.scorecard.computeScorecard(id, q.category ?? null, q.period, user.userId);
  }

  @Get(':id/scorecard')
  @RequirePermission(PERMISSIONS.VENDOR_SCORECARD_READ)
  async scorecardView(
    @Param('id') id: string,
    @Query(new ZodValidationPipe(ScorecardQuerySchema)) q: ScorecardQuery,
  ): Promise<VendorScorecardView> {
    return this.query.scorecardView(id, q.category ?? null, q.period);
  }

  // ── Master list + 360 (declared last so /:id doesn't shadow others) ────────

  @Get()
  @RequirePermission(PERMISSIONS.VENDOR_READ)
  async list(
    @Query(new ZodValidationPipe(VendorListQuerySchema)) q: VendorListQuery,
  ): Promise<VendorListResponse> {
    return this.query.listVendors(q);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.VENDOR_READ)
  async vendor360(@Param('id') id: string): Promise<Vendor360Response> {
    return this.query.vendor360(id);
  }

  /** Correct a vendor's display and/or legal name (the legal one only while the
   *  vendor is still onboarding — see renameVendor). */
  @Patch(':id')
  @RequirePermission(PERMISSIONS.VENDOR_UPDATE)
  async rename(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RenameVendorInputSchema)) dto: RenameVendorInput,
  ): Promise<{ ok: true }> {
    return this.onboarding.renameVendor(id, dto, user.userId);
  }
}

function decisionAction(
  decision: 'APPROVE' | 'REJECT' | 'CHANGES',
): ApprovalDecisionAction {
  if (decision === 'APPROVE') return 'APPROVE';
  if (decision === 'REJECT') return 'REJECT';
  return 'REQUEST_CHANGES';
}
