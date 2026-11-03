import { Module } from '@nestjs/common';

import { ApprovalsModule } from '../../approvals/approvals.module';
import { AuthModule } from '../../auth/auth.module';
import { AskmiraController } from './askmira.controller';
import { AskmiraService } from './askmira.service';

/** The link with AskMira, the company's HRMS (askmira.service.ts). */
@Module({
  imports: [AuthModule, ApprovalsModule],
  controllers: [AskmiraController],
  providers: [AskmiraService],
})
export class AskmiraModule {}
