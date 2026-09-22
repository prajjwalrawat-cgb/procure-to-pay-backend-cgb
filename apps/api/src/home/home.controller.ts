import { Controller, Get, Query } from '@nestjs/common';
import {
  ActivityQuerySchema,
  PERMISSIONS,
  type ActivityQuery,
  type ActivityResponse,
  type ApprovalPipelineResponse,
  type HomeSummaryResponse,
  type UpcomingPaymentRunsResponse,
} from '@procureflow/shared';

import { RequirePermission } from '../auth/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { HomeActivityService } from './home-activity.service';
import { HomeService } from './home.service';

/** Home command center (buyer console landing page). */
@Controller('home')
export class HomeController {
  constructor(
    private readonly home: HomeService,
    private readonly activity: HomeActivityService,
  ) {}

  @Get('summary')
  @RequirePermission(PERMISSIONS.ANALYTICS_READ)
  summary(): Promise<HomeSummaryResponse> {
    return this.home.getSummary();
  }

  @Get('activity')
  @RequirePermission(PERMISSIONS.ANALYTICS_READ)
  feed(
    @Query(new ZodValidationPipe(ActivityQuerySchema)) q: ActivityQuery,
  ): Promise<ActivityResponse> {
    return this.activity.getActivity(q);
  }

  @Get('approval-pipeline')
  @RequirePermission(PERMISSIONS.ANALYTICS_READ)
  approvalPipeline(): Promise<ApprovalPipelineResponse> {
    return this.home.getApprovalPipeline();
  }

  @Get('upcoming-payment-runs')
  @RequirePermission(PERMISSIONS.ANALYTICS_READ)
  upcomingPaymentRuns(): Promise<UpcomingPaymentRunsResponse> {
    return this.home.getUpcomingPaymentRuns();
  }
}
