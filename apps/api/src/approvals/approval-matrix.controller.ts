import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  ApprovalMatrixCreateInputSchema,
  ApprovalMatrixUpdateInputSchema,
  DOCUMENT_TYPE,
  PERMISSIONS,
  SimulateInputSchema,
  type ApprovalMatrixCreateInput,
  type ApprovalMatrixListResponse,
  type ApprovalMatrixUpdateInput,
  type ApprovalMatrixView,
  type DocumentType,
  type SimulateInput,
  type SimulateResult,
} from '@procureflow/shared';
import { z } from 'zod';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { ApprovalMatrixService } from './approval-matrix.service';

/** Every routed document type is configurable — the matrix page has a tab per
 *  type (vendor onboarding, vendor change, awards and amendments included). */
const DocTypeQuerySchema = z.object({
  documentType: z.enum(DOCUMENT_TYPE as unknown as [DocumentType, ...DocumentType[]]),
});

@Controller('approvals/matrices')
export class ApprovalMatrixController {
  constructor(private readonly matrices: ApprovalMatrixService) {}

  @Get()
  @RequirePermission(PERMISSIONS.APPROVAL_MATRIX_READ)
  async list(
    @Query(new ZodValidationPipe(DocTypeQuerySchema))
    q: z.infer<typeof DocTypeQuerySchema>,
  ): Promise<ApprovalMatrixListResponse> {
    const items = await this.matrices.list(q.documentType as DocumentType);
    return { documentType: q.documentType as DocumentType, items };
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.APPROVAL_MATRIX_READ)
  async get(@Param('id') id: string): Promise<ApprovalMatrixView> {
    return this.matrices.get(id);
  }

  @Get(':id/versions')
  @RequirePermission(PERMISSIONS.APPROVAL_MATRIX_READ)
  async versions(@Param('id') id: string): Promise<ApprovalMatrixView[]> {
    return this.matrices.versions(id);
  }

  @Post()
  @RequirePermission(PERMISSIONS.APPROVAL_MATRIX_WRITE)
  async create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(ApprovalMatrixCreateInputSchema))
    dto: ApprovalMatrixCreateInput,
  ): Promise<ApprovalMatrixView> {
    return this.matrices.create(user.tenantId, user.userId, dto);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.APPROVAL_MATRIX_WRITE)
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ApprovalMatrixUpdateInputSchema))
    dto: ApprovalMatrixUpdateInput,
  ): Promise<ApprovalMatrixView> {
    return this.matrices.update(user.tenantId, user.userId, id, dto);
  }

  @Post(':id/activate')
  @RequirePermission(PERMISSIONS.APPROVAL_MATRIX_WRITE)
  async activate(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<ApprovalMatrixView> {
    return this.matrices.activate(user.userId, id);
  }

  @Post(':id/deactivate')
  @RequirePermission(PERMISSIONS.APPROVAL_MATRIX_WRITE)
  async deactivate(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<ApprovalMatrixView> {
    return this.matrices.deactivate(user.userId, id);
  }

  @Post(':id/duplicate')
  @RequirePermission(PERMISSIONS.APPROVAL_MATRIX_WRITE)
  async duplicate(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<ApprovalMatrixView> {
    return this.matrices.duplicate(user.tenantId, user.userId, id);
  }

  /** Dry-run a saved matrix against a document/sample. */
  @Post(':id/simulate')
  @RequirePermission(PERMISSIONS.APPROVAL_MATRIX_READ)
  async simulateSaved(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(SimulateInputSchema)) dto: SimulateInput,
  ): Promise<SimulateResult> {
    const matrix = await this.matrices.get(id);
    return this.matrices.simulate({
      documentType: matrix.documentType,
      conditions: matrix.conditions,
      steps: matrix.steps,
      matrixId: matrix.id,
      matrixName: matrix.name,
      documentId: dto.documentId,
      sampleDocument: dto.sampleDocument,
    });
  }
}

@Controller('approvals')
export class ApprovalSimulateController {
  constructor(private readonly matrices: ApprovalMatrixService) {}

  /** Dry-run an unsaved rule (builder "Test with sample"). */
  @Post('simulate')
  @RequirePermission(PERMISSIONS.APPROVAL_MATRIX_READ)
  async simulate(
    @Body(new ZodValidationPipe(SimulateInputSchema)) dto: SimulateInput,
  ): Promise<SimulateResult> {
    return this.matrices.simulate({
      documentType: dto.documentType,
      conditions: dto.conditions ?? {},
      steps: dto.steps ?? [],
      matrixId: null,
      matrixName: null,
      documentId: dto.documentId,
      sampleDocument: dto.sampleDocument,
    });
  }
}
