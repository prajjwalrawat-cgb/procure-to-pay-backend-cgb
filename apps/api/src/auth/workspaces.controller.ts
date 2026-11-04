import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Ip,
  Post,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { newId, Prisma } from '@procureflow/db';
import { PERMISSIONS, type LoginResponse } from '@procureflow/shared';
import type { Request } from 'express';
import { z } from 'zod';

import { AuditLogService } from '../audit/audit.service';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import type { AuthUser } from './auth.types';
import { CurrentUser, Public, RequirePermission } from './decorators';

const CreateWorkspaceSchema = z.object({
  name: z.string().trim().min(2).max(120),
});
type CreateWorkspaceDto = z.infer<typeof CreateWorkspaceSchema>;

const SwitchWorkspaceSchema = z.object({
  refreshToken: z.string().min(1),
  tenantId: z.string().uuid(),
});
type SwitchWorkspaceDto = z.infer<typeof SwitchWorkspaceSchema>;

export interface Workspace {
  tenantId: string;
  name: string;
  current: boolean;
}

/**
 * Organisations (workspaces). One person can belong to several tenants — one
 * User row per tenant under the same verified email — and switch between them
 * from the header. A TENANT_ADMIN can create a new organisation and becomes
 * its admin.
 */
@Controller()
export class WorkspacesController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  @Get('workspaces')
  async list(@CurrentUser() user: AuthUser): Promise<Workspace[]> {
    const rows = await this.auth.listWorkspaces(user.userId);
    return rows.map((w) => ({
      tenantId: w.tenantId,
      name: w.tenantName,
      current: w.tenantId === user.tenantId,
    }));
  }

  @Post('workspaces')
  @RequirePermission(PERMISSIONS.TENANT_CREATE)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CreateWorkspaceSchema)) dto: CreateWorkspaceDto,
  ): Promise<Workspace> {
    // The new organisation is reached by switching, which links accounts only
    // through a verified email — an unverified creator could never get there.
    const me = await this.prisma.client.user.findUnique({
      where: { id: user.userId },
      select: { emailVerifiedAt: true },
    });
    if (!me?.emailVerifiedAt) {
      throw new ForbiddenException(
        'Verify your email first: use "Forgot password" once to set your password from the emailed link.',
      );
    }

    const rows = await this.prisma.client.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT create_workspace(${dto.name}, ${user.userId}, ${newId(
        'user',
      )}, ${newId('userRole')}) AS id`,
    );
    const tenantId = rows[0]!.id;

    await this.audit.record({
      action: 'tenant.created',
      entityType: 'Tenant',
      entityId: tenantId,
      actorId: user.userId,
      after: { name: dto.name },
    });

    return { tenantId, name: dto.name, current: false };
  }

  /** Public at the guard: the refresh token is the credential (see
   *  AuthService.switchWorkspace). Called by the web app's /api/auth/switch
   *  route, which reads the httpOnly cookie. */
  @Public()
  @Post('auth/switch-workspace')
  async switch(
    @Body(new ZodValidationPipe(SwitchWorkspaceSchema)) dto: SwitchWorkspaceDto,
    @Ip() ip: string,
    @Req() req: Request,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<LoginResponse> {
    return this.auth.switchWorkspace(dto.refreshToken, dto.tenantId, {
      ipAddress: ip,
      userAgent: userAgent ?? req.headers['user-agent'],
    });
  }
}
