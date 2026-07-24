import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  PERMISSIONS,
  SetCredentialSchema,
  UsageQuerySchema,
  type CredentialStatusItem,
  type IntegrationProvider,
  type IntegrationUsageResponse,
  type SetCredential,
  type UsageQuery,
} from '@procureflow/shared';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { IntegrationUsageService } from './integration-usage.service';
import { TenantCredentialService } from './tenant-credential.service';

/** Integration administration — credential vault + usage/cost visibility (Slice 10). */
@Controller('integrations')
export class IntegrationsController {
  constructor(
    private readonly credentials: TenantCredentialService,
    private readonly usage: IntegrationUsageService,
  ) {}

  @Post('credentials')
  @RequirePermission(PERMISSIONS.INTEGRATION_MANAGE)
  async setCredential(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(SetCredentialSchema)) dto: SetCredential,
  ): Promise<{ ok: true }> {
    return this.credentials.setCredential(
      dto.provider,
      dto.label ?? null,
      dto.payload,
      user.userId,
    );
  }

  @Get('credentials')
  @RequirePermission(PERMISSIONS.INTEGRATION_READ)
  async status(): Promise<CredentialStatusItem[]> {
    return this.credentials.getStatus();
  }

  @Get('usage')
  @RequirePermission(PERMISSIONS.INTEGRATION_READ)
  async usageSummary(
    @Query(new ZodValidationPipe(UsageQuerySchema)) q: UsageQuery,
  ): Promise<IntegrationUsageResponse> {
    const month = q.month ?? new Date().toISOString().slice(0, 7);
    return this.usage.summary(month, (q.provider as IntegrationProvider) ?? null);
  }
}
