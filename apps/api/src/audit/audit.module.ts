import { Global, Module } from '@nestjs/common';

import { AuditController } from './audit.controller';
import { AuditExportService } from './audit-export.service';
import { AuditLogService } from './audit.service';
import { AuditQueryService } from './audit-query.service';

@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditLogService, AuditQueryService, AuditExportService],
  exports: [AuditLogService, AuditQueryService],
})
export class AuditModule {}
