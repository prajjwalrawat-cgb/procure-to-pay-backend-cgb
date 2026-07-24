import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import {
  AuditQueryInputSchema,
  AuditVerifyInputSchema,
  PERMISSIONS,
  type AuditListResponse,
  type AuditQueryInput,
  type AuditRecordView,
  type AuditVerifyInput,
  type AuditVerifyResult,
} from '@procureflow/shared';
import type { Response } from 'express';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { AuditExportService } from './audit-export.service';
import { AuditQueryService } from './audit-query.service';

@Controller('audit')
export class AuditController {
  constructor(
    private readonly query: AuditQueryService,
    private readonly exports: AuditExportService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @RequirePermission(PERMISSIONS.AUDIT_LOG_READ)
  async list(
    @Query(new ZodValidationPipe(AuditQueryInputSchema)) q: AuditQueryInput,
  ): Promise<AuditListResponse> {
    return this.query.find(q);
  }

  @Get('entity/:type/:id')
  @RequirePermission(PERMISSIONS.AUDIT_LOG_READ)
  async byEntity(
    @Param('type') type: string,
    @Param('id') id: string,
  ): Promise<AuditRecordView[]> {
    return this.query.getByEntity(type, id);
  }

  @Post('verify')
  @RequirePermission(PERMISSIONS.AUDIT_LOG_READ)
  async verify(
    @Body(new ZodValidationPipe(AuditVerifyInputSchema)) dto: AuditVerifyInput,
  ): Promise<AuditVerifyResult> {
    return this.query.verifyChain(dto.from ?? null, dto.to ?? null);
  }

  @Get('export/csv')
  @RequirePermission(PERMISSIONS.AUDIT_LOG_READ)
  exportCsv(
    @Query(new ZodValidationPipe(AuditQueryInputSchema)) q: AuditQueryInput,
    @Res() res: Response,
  ): void {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="audit-log.csv"');
    const stream = this.exports.exportCsv(q);
    stream.on('error', () => res.end());
    stream.pipe(res);
  }

  @Get('export/pdf')
  @RequirePermission(PERMISSIONS.AUDIT_LOG_READ)
  async exportPdf(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(AuditQueryInputSchema)) q: AuditQueryInput,
    @Res() res: Response,
  ): Promise<void> {
    const tenant = await this.prisma.client.tenant.findUnique({
      where: { id: user.tenantId },
      select: { name: true },
    });
    const pdf = await this.exports.buildReportPdf(tenant?.name ?? 'Tenant', q);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="audit-report.pdf"');
    res.send(pdf);
  }
}
