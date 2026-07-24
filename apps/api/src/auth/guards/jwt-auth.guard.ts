import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Portal } from '@procureflow/shared';
import type { Request } from 'express';

import type { AuthUser } from '../auth.types';
import { IS_PUBLIC_KEY, REQUIRED_AUDIENCE_KEY } from '../decorators';
import { TokenService } from '../token.service';

/**
 * Authenticates every request except @Public() ones. Enforces the buyer/vendor
 * audience split (Master Context §3 rule #11): a route defaults to the `buyer`
 * audience and rejects tokens minted for the other portal.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractToken(request);
    if (!token) throw new UnauthorizedException('Missing bearer token');

    const requiredAudience =
      this.reflector.getAllAndOverride<Portal>(REQUIRED_AUDIENCE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'buyer';

    try {
      const payload = await this.tokens.verify(token, requiredAudience);
      if (payload.type !== 'access') {
        throw new UnauthorizedException('Not an access token');
      }
      const user: AuthUser = {
        userId: payload.sub,
        tenantId: payload.tid,
        audience: payload.aud,
        roles: payload.roles,
        perms: payload.perms,
      };
      (request as Request & { user: AuthUser }).user = user;
      return true;
    } catch {
      // Generic message — no audience/expiry disclosure.
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  private extractToken(request: Request): string | null {
    const header = request.headers.authorization;
    if (!header) return null;
    const [scheme, value] = header.split(' ');
    return scheme === 'Bearer' && value ? value : null;
  }
}
