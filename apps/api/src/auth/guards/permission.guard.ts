import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import type { AuthUser } from '../auth.types';
import { REQUIRED_PERMISSION_KEY, type RequiredPermissionMeta } from '../decorators';

/**
 * Enforces @RequirePermission (Master Context §5). Checks the permission string
 * against the JWT's `perms`, then — for scoped permissions — runs the supplied
 * ownership predicate against the route params. Runs after JwtAuthGuard.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.getAllAndOverride<RequiredPermissionMeta | undefined>(
      REQUIRED_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!meta) return true; // No permission required on this route.

    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const user = request.user;
    if (!user) throw new ForbiddenException('Not authenticated');

    const accepted = Array.isArray(meta.permission) ? meta.permission : [meta.permission];
    if (!accepted.some((p) => user.perms.includes(p))) {
      throw new ForbiddenException(`Missing permission: ${accepted.join(' or ')}`);
    }

    if (meta.predicate) {
      const params = (request.params ?? {}) as Record<string, string>;
      const allowed = await meta.predicate(user, params);
      if (!allowed) throw new ForbiddenException('Not permitted for this record');
    }

    return true;
  }
}
