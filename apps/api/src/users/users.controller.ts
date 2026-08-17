import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { PERMISSIONS, type RoleName } from '@procureflow/shared';
import { z } from 'zod';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Public, RequirePermission } from '../auth/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import {
  UsersService,
  type PendingInvite,
  type TeamMember,
  type MyProfile,
  type UserProfile,
} from './users.service';

const CreateUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  password: z.string().min(8),
  roles: z.array(z.string()).min(1),
});
type CreateUserDto = z.infer<typeof CreateUserSchema>;

const InviteUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  roles: z.array(z.string()).min(1),
});
type InviteUserDto = z.infer<typeof InviteUserSchema>;

const AcceptInviteSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
});
type AcceptInviteDto = z.infer<typeof AcceptInviteSchema>;

const UpdateRolesSchema = z.object({
  roles: z.array(z.string()).min(1),
});
type UpdateRolesDto = z.infer<typeof UpdateRolesSchema>;

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  async me(@CurrentUser() user: AuthUser): Promise<MyProfile> {
    return this.users.findProfile(user.userId);
  }

  /** Active team roster for the current tenant. */
  @Get()
  @RequirePermission(PERMISSIONS.USER_READ)
  async list(@CurrentUser() actor: AuthUser): Promise<TeamMember[]> {
    return this.users.list(actor.tenantId);
  }

  /** Pending (not-yet-accepted) invitations. */
  @Get('pending')
  @RequirePermission(PERMISSIONS.USER_READ)
  async pending(@CurrentUser() actor: AuthUser): Promise<PendingInvite[]> {
    return this.users.listPending(actor.tenantId);
  }

  /** Admin creates a user directly (password set explicitly). */
  @Post()
  @RequirePermission(PERMISSIONS.USER_CREATE)
  async create(
    @CurrentUser() actor: AuthUser,
    @Body(new ZodValidationPipe(CreateUserSchema)) dto: CreateUserDto,
  ): Promise<UserProfile> {
    return this.users.create(
      actor.tenantId,
      { ...dto, roles: dto.roles as RoleName[] },
      actor.userId,
    );
  }

  /** Admin invites a teammate by email + role(s); they set their own password. */
  @Post('invite')
  @RequirePermission(PERMISSIONS.USER_CREATE)
  async invite(
    @CurrentUser() actor: AuthUser,
    @Body(new ZodValidationPipe(InviteUserSchema)) dto: InviteUserDto,
  ): Promise<UserProfile> {
    return this.users.invite(
      actor.tenantId,
      { ...dto, roles: dto.roles as RoleName[] },
      actor.userId,
    );
  }

  /** Public: invitee sets their password from the emailed magic link. */
  @Public()
  @Post('accept-invite')
  async acceptInvite(
    @Body(new ZodValidationPipe(AcceptInviteSchema)) dto: AcceptInviteDto,
  ): Promise<{ email: string }> {
    return this.users.acceptInvite(dto.token, dto.password);
  }

  /** Change a user's roles inline from the Team page. */
  @Patch(':id/roles')
  @RequirePermission(PERMISSIONS.USER_UPDATE)
  async updateRoles(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateRolesSchema)) dto: UpdateRolesDto,
  ): Promise<TeamMember> {
    return this.users.updateRoles(
      actor.tenantId,
      id,
      dto.roles as RoleName[],
      actor.userId,
    );
  }

  /** Revoke a pending invitation (kills the emailed link). */
  @Post(':id/revoke')
  @RequirePermission(PERMISSIONS.USER_UPDATE)
  async revoke(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
  ): Promise<{ id: string }> {
    return this.users.revokeInvite(actor.tenantId, id, actor.userId);
  }

  /** Soft-remove (deactivate) an active user. */
  @Delete(':id')
  @RequirePermission(PERMISSIONS.USER_UPDATE)
  async remove(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
  ): Promise<{ id: string }> {
    return this.users.deactivate(actor.tenantId, id, actor.userId);
  }
}
