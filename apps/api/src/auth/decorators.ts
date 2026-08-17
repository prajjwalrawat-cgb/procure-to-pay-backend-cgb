import {
  SetMetadata,
  createParamDecorator,
  type CustomDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import type { Portal } from '@procureflow/shared';

import type { AuthUser, OwnershipPredicate } from './auth.types';

export const IS_PUBLIC_KEY = 'isPublic';
/** Marks a route as not requiring authentication (e.g. /auth/login). */
export const Public = (): CustomDecorator => SetMetadata(IS_PUBLIC_KEY, true);

export const REQUIRED_AUDIENCE_KEY = 'requiredAudience';
/** Restrict a route (or controller) to a JWT audience — buyer endpoints reject
 *  vendor tokens and vice versa (Master Context §3 rule #11). Defaults to 'buyer'. */
export const RequireAudience = (audience: Portal): CustomDecorator =>
  SetMetadata(REQUIRED_AUDIENCE_KEY, audience);

export const REQUIRED_PERMISSION_KEY = 'requiredPermission';
export interface RequiredPermissionMeta {
  /** One permission, or several of which the caller needs *any one* (§5). */
  permission: string | string[];
  predicate?: OwnershipPredicate;
}
/**
 * Require a permission string (Master Context §5). Scoped permissions may pass
 * an ownership predicate that is evaluated against the route params.
 *
 * An array means "any one of these" — the shape a resource readable at more
 * than one scope needs (`invoice:read:tenant` OR `invoice:read:assigned`). The
 * guard only decides admission; a handler let in on the narrower permission is
 * responsible for narrowing what it returns.
 */
export const RequirePermission = (
  permission: string | string[],
  predicate?: OwnershipPredicate,
): CustomDecorator => SetMetadata(REQUIRED_PERMISSION_KEY, { permission, predicate });

/** Inject the authenticated principal into a handler param. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const request = ctx.switchToHttp().getRequest<{ user: AuthUser }>();
    return request.user;
  },
);
