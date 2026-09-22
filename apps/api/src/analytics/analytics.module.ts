import { Module } from '@nestjs/common';

import { ApprovalsModule } from '../approvals/approvals.module';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsDailyService } from './analytics-daily.service';
import { AnalyticsInsightsService } from './analytics-insights.service';
import { AnalyticsRefreshService } from './analytics-refresh.service';
import { ApPerformanceService } from './ap-performance.service';
import { MsmeComplianceService } from './msme-compliance.service';
import { MsmeReportService } from './msme-report.service';
import { SavingsTrackerService } from './savings-tracker.service';
import { SpendAnalyticsService } from './spend-analytics.service';
import { VendorAnalyticsService } from './vendor-analytics.service';

/**
 * Analytics (Slice 8). Read-heavy aggregation over Slices 1/3/4/5/6/7 data via
 * RLS-protected summary tables (job-refreshed) + live drill-down queries. Savings
 * tracker + refresh service register approval hooks (RFQ award / payment run), so
 * this module imports ApprovalsModule.
 */
@Module({
  imports: [ApprovalsModule],
  controllers: [AnalyticsController],
  providers: [
    SpendAnalyticsService,
    MsmeComplianceService,
    MsmeReportService,
    SavingsTrackerService,
    ApPerformanceService,
    VendorAnalyticsService,
    AnalyticsRefreshService,
    AnalyticsDailyService,
    AnalyticsInsightsService,
  ],
  exports: [SavingsTrackerService, AnalyticsRefreshService, AnalyticsDailyService],
})
export class AnalyticsModule {}
