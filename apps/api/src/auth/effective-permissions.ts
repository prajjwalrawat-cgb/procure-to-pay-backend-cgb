import {
  ROLE_PERMISSIONS,
  permissionsFromApprovalMatrices,
  type RoleName,
} from '@procureflow/shared';

/**
 * The slice of Prisma this resolver needs. Typed structurally so it can be
 * handed either the request client or a tenant-context transaction.
 */
export interface ApprovalMatrixReader {
  approvalMatrix: {
    findMany(args: {
      where: { isActive: boolean };
      select: { documentType: true; isActive: true; steps: true };
    }): Promise<{ documentType: string; isActive: boolean; steps: unknown }[]>;
  };
}

/**
 * A user's effective permissions: the union of their role bundles, plus the
 * authority the tenant's own approval matrices confer on those roles.
 *
 * The second half is what keeps reviewer authority in step with the matrix. A
 * tenant that re-points VENDOR_ONBOARDING from PROCUREMENT_OFFICER to
 * FINANCE_OFFICER moves the document-verification and bank-override rights with
 * it, because those are the acts the routed approver must perform before the
 * decision it is being asked for is possible at all.
 *
 * Resolved at token issue (login and refresh) and on /users/me, so a matrix
 * edit reaches a signed-in user at their next access-token refresh rather than
 * instantly. Everything here is additive; the route guards are unchanged.
 */
export async function resolveEffectivePermissions(
  db: ApprovalMatrixReader,
  roles: readonly string[],
): Promise<string[]> {
  const perms = new Set<string>();
  for (const role of roles) {
    for (const p of ROLE_PERMISSIONS[role as RoleName] ?? []) perms.add(p);
  }
  const matrices = await db.approvalMatrix.findMany({
    where: { isActive: true },
    select: { documentType: true, isActive: true, steps: true },
  });
  for (const p of permissionsFromApprovalMatrices(roles, matrices)) perms.add(p);
  return [...perms];
}
