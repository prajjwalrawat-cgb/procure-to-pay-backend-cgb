import { Injectable, NotFoundException } from '@nestjs/common';
import { newId } from '@procureflow/db';
import type { RoleName } from '@procureflow/shared';
import { hash as argonHash } from 'argon2';

import { AuditLogService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateUserInput {
  email: string;
  name: string;
  password: string;
  roles: RoleName[];
}

export interface UserProfile {
  id: string;
  email: string;
  name: string;
  roles: string[];
  mfaEnabled: boolean;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /** Create a user in the current tenant context and audit it (§3 rules #2, #3). */
  async create(
    tenantId: string,
    input: CreateUserInput,
    actorId: string,
  ): Promise<UserProfile> {
    const argon = await argonHash(input.password, { type: 2 });
    const user = await this.prisma.client.user.create({
      data: {
        id: newId('user'),
        tenantId,
        email: input.email.toLowerCase(),
        name: input.name,
        argonHash: argon,
      },
    });

    for (const roleName of input.roles) {
      const role = await this.prisma.client.role.findUniqueOrThrow({
        where: { name: roleName },
      });
      await this.prisma.client.userRole.create({
        data: { id: newId('userRole'), tenantId, userId: user.id, roleId: role.id },
      });
    }

    await this.audit.record({
      action: 'user.created',
      entityType: 'User',
      entityId: user.id,
      actorId,
      after: { email: user.email, name: user.name, roles: input.roles },
    });

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      roles: input.roles,
      mfaEnabled: false,
    };
  }

  async findProfile(userId: string): Promise<UserProfile> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      include: { userRoles: { include: { role: true } } },
    });
    if (!user) throw new NotFoundException('User not found');
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      roles: user.userRoles.map((ur) => ur.role.name),
      mfaEnabled: user.mfaEnabled,
    };
  }
}
