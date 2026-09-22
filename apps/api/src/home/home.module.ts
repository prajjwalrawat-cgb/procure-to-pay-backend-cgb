import { Module } from '@nestjs/common';

import { AnalyticsModule } from '../analytics/analytics.module';
import { HomeActivityService } from './home-activity.service';
import { HomeController } from './home.controller';
import { HomeService } from './home.service';

/**
 * Home command center: summary tiles over the AnalyticsDaily rollup, the
 * activity feed, the approval pipeline and upcoming payment runs.
 */
@Module({
  imports: [AnalyticsModule],
  controllers: [HomeController],
  providers: [HomeService, HomeActivityService],
})
export class HomeModule {}
