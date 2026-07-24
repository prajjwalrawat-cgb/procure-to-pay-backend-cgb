import { Body, Controller, Get, Post } from '@nestjs/common';
import { PERMISSIONS, type RoleName } from '@procureflow/shared';
import { z } from 'zod';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { UsersService, type UserProfile } from './users.service';

const CreateUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  password: z.string().min(8),
  roles: z.array(z.string()).min(1),
});
type CreateUserDto = z.infer<typeof CreateUserSchema>;

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  async me(@CurrentUser() user: AuthUser): Promise<UserProfile> {
    return this.users.findProfile(user.userId);
  }

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
}
