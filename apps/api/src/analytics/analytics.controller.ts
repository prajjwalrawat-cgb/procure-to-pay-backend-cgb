import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import {
  AnalyticsPeriodQuerySchema,
  AvoidedCostInputSchema,
  MsmeBucketParamSchema,
  PERMISSIONS,
  TopVendorsQuerySchema,
  type AnalyticsPeriodQuery,
  type AvoidedCostInput,
  type MsmeBucketKey,
  type RefreshResponse,
  type TopVendorsQuery,
} from '@procureflow/shared';
import type { Response } from 'express';

import { AuditLogService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsRefreshService } from './analytics-refresh.service';
import { ApPerformanceService } from './ap-performance.service';
import { MsmeComplianceService } from './msme-compliance.service';
import { MsmeReportService } from './msme-report.service';
import { SavingsTrackerService } from './savings-tracker.service';
import { SpendAnalyticsService } from './spend-analytics.service';
import { VendorAnalyticsService } from './vendor-analytics.service';

const periodPipe = new ZodValidationPipe(AnalyticsPeriodQuerySchema);

@Controller('analytics')
export class AnalyticsController {
  constructor(
    private readonly spend: SpendAnalyticsService,
    private readonly msme: MsmeComplianceService,
    private readonly report: MsmeReportService,
    private readonly savings: SavingsTrackerService,
    private readonly ap: ApPerformanceService,
    private readonly vendors: VendorAnalyticsService,
    private readonly refresh: AnalyticsRefreshService,
    private readonly audit: AuditLogService,
    private readonly prisma: PrismaService,
  ) {}

  // ── Spend ──────────────────────────────────────────────────────────────────
  @Get('spend/total')
  @RequirePermission(PERMISSIONS.ANALYTICS_READ)
  spendTotal(@Query(periodPipe) q: AnalyticsPeriodQuery) {
    return this.spend.getTotalSpend(q);
  }

  @Get('spend/trend')
  @RequirePermission(PERMISSIONS.ANALYTICS_READ)
  spendTrend(@Query(periodPipe) q: AnalyticsPeriodQuery) {
    return this.spend.getSpendTrend(q);
  }

  @Get('spend/by-category')
  @RequirePermission(PERMISSIONS.ANALYTICS_READ)
  spendByCategory(@Query(periodPipe) q: AnalyticsPeriodQuery) {
    return this.spend.getSpendByCategory(q);
  }

  @Get('spend/top-vendors')
  @RequirePermission(PERMISSIONS.ANALYTICS_READ)
  topVendors(@Query(new ZodValidationPipe(TopVendorsQuerySchema)) q: TopVendorsQuery) {
    return this.spend.getTopVendors(q);
  }

  @Get('spend/concentration')
  @RequirePermission(PERMISSIONS.ANALYTICS_READ)
  concentration(@Query(periodPipe) q: AnalyticsPeriodQuery) {
    return this.spend.getConcentrationRisk(q);
  }

  @Get('contracts/coverage')
  @RequirePermission(PERMISSIONS.ANALYTICS_READ)
  contractCoverage(@Query(periodPipe) q: AnalyticsPeriodQuery) {
    return this.spend.getContractCoverage(q);
  }

  // ── MSME ───────────────────────────────────────────────────────────────────
  @Get('msme/dashboard')
  @RequirePermission(PERMISSIONS.ANALYTICS_READ)
  msmeDashboard() {
    return this.msme.getAgingDashboard();
  }

  @Get('msme/trend')
  @RequirePermission(PERMISSIONS.ANALYTICS_READ)
  msmeTrend(@Query(periodPipe) q: AnalyticsPeriodQuery) {
    return this.msme.getComplianceTrend(q);
  }

  @Get('msme/report.pdf')
  @RequirePermission(PERMISSIONS.ANALYTICS_READ)
  async msmeReport(@CurrentUser() user: AuthUser, @Res() res: Response): Promise<void> {
    const tenant = await this.prisma.client.tenant.findUnique({
      where: { id: user.tenantId },
      select: { name: true },
    });
    const pdf = await this.report.buildReport(tenant?.name ?? 'Tenant');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="msme-compliance-report.pdf"',
    );
    res.send(pdf);
  }

  @Get('msme/exposure/:bucket')
  @RequirePermission(PERMISSIONS.ANALYTICS_READ)
  msmeExposure(
    @Param('bucket', new ZodValidationPipe(MsmeBucketParamSchema)) bucket: MsmeBucketKey,
  ) {
    return this.msme.getExposureDetail(bucket);
  }

  // ── Savings ────────────────────────────────────────────────────────────────
  @Get('savings/summary')
  @RequirePermission(PERMISSIONS.ANALYTICS_READ)
  savingsSummary(@Query(periodPipe) q: AnalyticsPeriodQuery) {
    return this.savings.getSavingsSummary(q);
  }

  @Get('savings/leaderboard')
  @RequirePermission(PERMISSIONS.ANALYTICS_VIEW_BUYER_LEADERBOARD)
  savingsLeaderboard(@Query(periodPipe) q: AnalyticsPeriodQuery) {
    return this.savings.getBuyerLeaderboard(q);
  }

  @Post('savings/avoided-cost')
  @RequirePermission(PERMISSIONS.ANALYTICS_MANAGE)
  avoidedCost(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(AvoidedCostInputSchema)) dto: AvoidedCostInput,
  ) {
    return this.savings.recordAvoidedCost(dto, user.userId);
  }

  // ── AP performance ─────────────────────────────────────────────────────────
  @Get('ap-performance')
  @RequirePermission(PERMISSIONS.ANALYTICS_READ)
  apPerformance(@Query(periodPipe) q: AnalyticsPeriodQuery) {
    return this.ap.getPerformance(q);
  }

  // ── Vendor portfolio ───────────────────────────────────────────────────────
  @Get('vendors/category-performance')
  @RequirePermission(PERMISSIONS.ANALYTICS_READ)
  categoryPerformance() {
    return this.vendors.getCategoryPerformance();
  }

  @Get('vendors/risk-distribution')
  @RequirePermission(PERMISSIONS.ANALYTICS_READ)
  riskDistribution() {
    return this.vendors.getRiskDistribution();
  }

  @Get('vendors/msme-participation')
  @RequirePermission(PERMISSIONS.ANALYTICS_READ)
  msmeParticipation() {
    return this.vendors.getMsmeParticipation();
  }

  // ── Manual refresh ─────────────────────────────────────────────────────────
  @Post('refresh')
  @RequirePermission(PERMISSIONS.ANALYTICS_MANAGE)
  async manualRefresh(@CurrentUser() user: AuthUser): Promise<RefreshResponse> {
    await this.refresh.refreshTenant(user.tenantId, 'MANUAL');
    await this.audit.record({
      action: 'ANALYTICS_REFRESH_TRIGGERED',
      entityType: 'Tenant',
      entityId: user.tenantId,
      actorId: user.userId,
      after: { trigger: 'MANUAL' },
    });
    return {
      triggered: ['spend_monthly', 'vendor_monthly', 'msme_monthly'],
      refreshedAt: new Date().toISOString(),
    };
  }
}
