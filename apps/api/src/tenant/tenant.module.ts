import { Module } from '@nestjs/common';

import { TenantInterceptor } from './tenant.interceptor';

@Module({
  providers: [TenantInterceptor],
  exports: [TenantInterceptor],
})
export class TenantModule {}
