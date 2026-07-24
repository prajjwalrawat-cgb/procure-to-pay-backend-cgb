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
} from '@nestjs/common';
import type { Response } from 'express';
import {
  AcknowledgeAlertInputSchema,
  AddClauseInputSchema,
  AmendmentInputSchema,
  ApplyIndexInputSchema,
  CallOffInputSchema,
  ClauseLibraryInputSchema,
  ContractCreateInputSchema,
  ContractDecisionInputSchema,
  ContractListQuerySchema,
  ContractUpdateInputSchema,
  PERMISSIONS,
  RenewInputSchema,
  TerminateInputSchema,
  type AcknowledgeAlertInput,
  type AddClauseInput,
  type AmendmentInput,
  type ApplyIndexInput,
  type CallOffInput,
  type ClauseLibraryInput,
  type ClauseLibraryItem,
  type ContractCreateInput,
  type ContractDecisionInput,
  type ContractDetailResponse,
  type ContractListQuery,
  type ContractListResponse,
  type ContractUpdateInput,
  type EscalationProposalResponse,
  type RenewalCalendarResponse,
  type RenewInput,
  type TerminateInput,
  type VolumeTrackingView,
} from '@procureflow/shared';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { CallOffService } from './call-off.service';
import { ClauseLibraryService } from './clause-library.service';
import { ContractDocumentService } from './contract-document.service';
import { ContractQueryService } from './contract-query.service';
import { ContractRenewalService } from './contract-renewal.service';
import { ContractService } from './contract.service';
import { EscalationService } from './escalation.service';

/** Buyer-side contract endpoints (Master Context §8: /api/v1 global prefix). */
@Controller('contracts')
export class ContractsController {
  constructor(
    private readonly contracts: ContractService,
    private readonly query: ContractQueryService,
    private readonly callOffs: CallOffService,
    private readonly escalation: EscalationService,
    private readonly renewals: ContractRenewalService,
    private readonly library: ClauseLibraryService,
    private readonly pdf: ContractDocumentService,
  ) {}

  // ── Clause library (declared before :id routes) ────────────────────────────

  @Get('clause-library')
  @RequirePermission(PERMISSIONS.CLAUSE_LIBRARY_READ)
  async listLibrary(
    @Query('clauseType') clauseType?: string,
  ): Promise<ClauseLibraryItem[]> {
    return this.library.list((clauseType as never) ?? null);
  }

  @Post('clause-library')
  @RequirePermission(PERMISSIONS.CLAUSE_LIBRARY_MANAGE)
  async addLibrary(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(ClauseLibraryInputSchema)) dto: ClauseLibraryInput,
  ): Promise<{ id: string }> {
    return this.library.add(dto, user.userId);
  }

  // ── Renewals ───────────────────────────────────────────────────────────────

  @Get('renewals/calendar')
  @RequirePermission(PERMISSIONS.CONTRACT_READ)
  async renewalCalendar(): Promise<RenewalCalendarResponse> {
    return this.query.renewalCalendar();
  }

  @Post('renewals/:alertId/acknowledge')
  @RequirePermission(PERMISSIONS.CONTRACT_RENEW)
  async acknowledge(
    @CurrentUser() user: AuthUser,
    @Param('alertId') alertId: string,
    @Body(new ZodValidationPipe(AcknowledgeAlertInputSchema)) dto: AcknowledgeAlertInput,
  ): Promise<{ ok: true }> {
    return this.renewals.acknowledgeAlert(alertId, dto.actionTaken, user.userId);
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────

  @Post()
  @RequirePermission(PERMISSIONS.CONTRACT_CREATE)
  async create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(ContractCreateInputSchema)) dto: ContractCreateInput,
  ): Promise<{ id: string }> {
    return this.contracts.createDraft(dto, user.userId);
  }

  @Get()
  @RequirePermission(PERMISSIONS.CONTRACT_READ)
  async list(
    @Query(new ZodValidationPipe(ContractListQuerySchema)) q: ContractListQuery,
  ): Promise<ContractListResponse> {
    return this.query.list(q);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.CONTRACT_READ)
  async detail(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<ContractDetailResponse> {
    return this.query.detail(id, user.userId);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.CONTRACT_CREATE)
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ContractUpdateInputSchema)) dto: ContractUpdateInput,
  ): Promise<{ ok: true }> {
    return this.contracts.updateDraft(id, dto, user.userId);
  }

  @Get(':id/pdf')
  @RequirePermission(PERMISSIONS.CONTRACT_READ)
  async pdfDownload(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const { buffer } = await this.pdf.generate(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="contract-${id}.pdf"`);
    res.send(buffer);
  }

  // ── Clauses ────────────────────────────────────────────────────────────────

  @Post(':id/clauses')
  @RequirePermission(PERMISSIONS.CONTRACT_CREATE)
  async addClause(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AddClauseInputSchema)) dto: AddClauseInput,
  ): Promise<{ id: string }> {
    return this.contracts.addClause(id, dto, user.userId);
  }

  @Delete(':id/clauses/:clauseId')
  @RequirePermission(PERMISSIONS.CONTRACT_CREATE)
  async removeClause(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('clauseId') clauseId: string,
  ): Promise<{ ok: true }> {
    return this.contracts.removeClause(id, clauseId, user.userId);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  @Post(':id/submit')
  @RequirePermission(PERMISSIONS.CONTRACT_SUBMIT)
  async submit(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    return this.contracts.submitForApproval(id, user.userId);
  }

  @Post(':id/decide')
  @RequirePermission(PERMISSIONS.APPROVAL_DECIDE)
  async decide(
    @CurrentUser() user: AuthUser,
    @Param('id') _id: string,
    @Body(new ZodValidationPipe(ContractDecisionInputSchema)) dto: ContractDecisionInput,
  ): Promise<{ ok: true }> {
    return this.contracts.decide(
      dto.approvalId,
      dto.decision,
      dto.comment ?? null,
      user.userId,
    );
  }

  @Post(':id/execute')
  @RequirePermission(PERMISSIONS.CONTRACT_EXECUTE)
  async execute(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<{ ok: true; status: string }> {
    return this.contracts.execute(id, user.userId);
  }

  // ── Amendments ───────────────────────────────────────────────────────────

  @Post(':id/amendments')
  @RequirePermission(PERMISSIONS.CONTRACT_AMEND)
  async amend(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AmendmentInputSchema)) dto: AmendmentInput,
  ): Promise<{ id: string }> {
    return this.contracts.amend(id, dto, user.userId);
  }

  @Post(':id/amendments/:amendId/decide')
  @RequirePermission(PERMISSIONS.APPROVAL_DECIDE)
  async decideAmendment(
    @CurrentUser() user: AuthUser,
    @Param('id') _id: string,
    @Param('amendId') _amendId: string,
    @Body(new ZodValidationPipe(ContractDecisionInputSchema)) dto: ContractDecisionInput,
  ): Promise<{ ok: true }> {
    return this.contracts.decideAmendment(
      dto.approvalId,
      dto.decision,
      dto.comment ?? null,
      user.userId,
    );
  }

  @Post(':id/escalation/apply-index')
  @RequirePermission(PERMISSIONS.CONTRACT_ESCALATION_MANAGE)
  async applyIndex(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ApplyIndexInputSchema)) dto: ApplyIndexInput,
  ): Promise<EscalationProposalResponse> {
    return this.escalation.applyIndex(id, dto.indexValue, user.userId);
  }

  // ── Renew / terminate ──────────────────────────────────────────────────────

  @Post(':id/renew')
  @RequirePermission(PERMISSIONS.CONTRACT_RENEW)
  async renew(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RenewInputSchema)) dto: RenewInput,
  ): Promise<{ id: string }> {
    return this.contracts.initiateRenewal(id, dto, user.userId);
  }

  @Post(':id/terminate')
  @RequirePermission(PERMISSIONS.CONTRACT_TERMINATE)
  async terminate(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(TerminateInputSchema)) dto: TerminateInput,
  ): Promise<{ ok: true }> {
    return this.contracts.terminate(id, dto, user.userId, user.roles);
  }

  // ── Call-offs + volume tracking ──────────────────────────────────────────────

  @Get(':id/volume-tracking')
  @RequirePermission(PERMISSIONS.CONTRACT_READ)
  async volumeTracking(@Param('id') id: string): Promise<VolumeTrackingView | null> {
    return this.callOffs.getVolumeTrackingStatus(id);
  }

  @Post(':id/call-offs')
  @RequirePermission(PERMISSIONS.CONTRACT_CALL_OFF)
  async createCallOff(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CallOffInputSchema)) dto: CallOffInput,
  ): Promise<{ id: string; poId: string }> {
    return this.callOffs.createCallOff(id, dto, user.userId);
  }

  @Get(':id/call-offs')
  @RequirePermission(PERMISSIONS.CONTRACT_READ)
  async listCallOffs(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<ContractDetailResponse['callOffs']> {
    return (await this.query.detail(id, user.userId)).callOffs;
  }
}
