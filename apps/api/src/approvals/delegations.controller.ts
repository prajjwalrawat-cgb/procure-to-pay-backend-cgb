import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  DelegationCreateInputSchema,
  PERMISSIONS,
  type DelegationCreateInput,
} from '@procureflow/shared';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { DelegationService, type DelegationView } from './delegation.service';

@Controller('delegations')
export class DelegationsController {
  constructor(private readonly delegations: DelegationService) {}

  @Get()
  @RequirePermission(PERMISSIONS.APPROVAL_READ)
  async list(@CurrentUser() user: AuthUser): Promise<DelegationView[]> {
    return this.delegations.listFor(user.userId);
  }

  @Post()
  @RequirePermission(PERMISSIONS.APPROVAL_DELEGATE)
  async create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(DelegationCreateInputSchema)) dto: DelegationCreateInput,
  ): Promise<DelegationView> {
    return this.delegations.create(user.tenantId, user.userId, user.userId, dto);
  }

  @Post(':id/revoke')
  @RequirePermission(PERMISSIONS.APPROVAL_DELEGATE)
  async revoke(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    await this.delegations.revoke(user.userId, id);
    return { ok: true };
  }
}
