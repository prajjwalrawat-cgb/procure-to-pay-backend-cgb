import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';

import type { Env } from './config/env';
import { UserThrottlerGuard } from './common/throttling/user-throttler.guard';

import { ApprovalsModule } from './approvals/approvals.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { PermissionGuard } from './auth/guards/permission.guard';
import { DomainEventsModule } from './common/events/domain-event.service';
import { ProblemExceptionFilter } from './common/filters/problem.filter';
import { ZodValidationPipe } from './common/pipes/zod-validation.pipe';
import { StorageModule } from './common/storage/storage.service';
import { validateEnv } from './config/env';
import { buildLoggerParams } from './config/logger';
import { BudgetsModule } from './budgets/budgets.module';
import { GrnModule } from './grn/grn.module';
import { HealthModule } from './health/health.module';
import { InvoicesModule } from './invoices/invoices.module';
import { ItemMasterModule } from './item-master/item-master.module';
import { PaymentRunsModule } from './payment-runs/payment-runs.module';
import { PrismaModule } from './prisma/prisma.module';
import { PurchaseOrdersModule } from './purchase-orders/purchase-orders.module';
import { RequisitionsModule } from './requisitions/requisitions.module';
import { SourcingModule } from './sourcing/sourcing.module';
import { TenantInterceptor } from './tenant/tenant.interceptor';
import { TenantModule } from './tenant/tenant.module';
import { UsersModule } from './users/users.module';
import { VendorsModule } from './vendors/vendors.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { ContractsModule } from './contracts/contracts.module';
import { CryptoModule } from './common/crypto/crypto.service';
import { IntegrationsModule } from './integrations/integrations.module';
import { ComplianceModule } from './compliance/compliance.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      envFilePath: ['../../.env', '.env'],
    }),
    LoggerModule.forRoot(buildLoggerParams(process.env.LOG_LEVEL ?? 'info')),
    // Slice 11b — per-user rate limiting (§8). In-memory storage (per instance);
    // for multi-instance prod, swap to Redis storage (documented in security review).
    // Relaxed in test so the integration suite isn't throttled.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        throttlers: [
          {
            name: 'default',
            ttl: 60_000,
            limit:
              config.get('NODE_ENV', { infer: true }) === 'test'
                ? 1_000_000
                : config.get('API_RATE_LIMIT_DEFAULT', { infer: true }),
          },
        ],
      }),
    }),
    PrismaModule,
    AuditModule,
    DomainEventsModule,
    StorageModule,
    CryptoModule,
    IntegrationsModule,
    AuthModule,
    TenantModule,
    UsersModule,
    HealthModule,
    ApprovalsModule,
    InvoicesModule,
    PaymentRunsModule,
    BudgetsModule,
    ItemMasterModule,
    RequisitionsModule,
    PurchaseOrdersModule,
    GrnModule,
    SourcingModule,
    VendorsModule,
    AnalyticsModule,
    ContractsModule,
    ComplianceModule,
  ],
  providers: [
    // Order matters: authenticate first, then authorize.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Throttle after authn so the limit keys by user id (falls back to IP).
    { provide: APP_GUARD, useClass: UserThrottlerGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    // Open the tenant transaction (SET LOCAL app.tenant_id) around each handler.
    { provide: APP_INTERCEPTOR, useClass: TenantInterceptor },
    { provide: APP_FILTER, useClass: ProblemExceptionFilter },
    // Global no-op unless a controller param attaches a Zod schema.
    { provide: APP_PIPE, useValue: new ZodValidationPipe() },
  ],
})
export class AppModule {}
