import type { Portal } from '@procureflow/shared';

/** The authenticated principal attached to `request.user` by JwtAuthGuard. */
export interface AuthUser {
  userId: string;
  tenantId: string;
  audience: Portal;
  roles: string[];
  perms: string[];
}

/** Predicate used by scoped permissions to check record ownership (§5). */
export type OwnershipPredicate = (
  user: AuthUser,
  params: Record<string, string>,
) => boolean | Promise<boolean>;
