import { describe, expect, it } from 'vitest';

import { PERMISSIONS, ROLE_PERMISSIONS } from './permissions';
import { ROLES, type RoleName } from './roles';

function rolesWith(permission: string): RoleName[] {
  return (Object.keys(ROLE_PERMISSIONS) as RoleName[]).filter((role) =>
    ROLE_PERMISSIONS[role].includes(permission as never),
  );
}

describe('vendor onboarding cancel authority', () => {
  /**
   * Every procurement officer sees the whole onboarding queue, so a cancel that
   * came bundled with VENDOR_INVITE would let one officer withdraw another's
   * vendor. Pinned here because the natural next edit — dropping it into the
   * VENDOR_MASTER bundle alongside its neighbours — silently re-opens that.
   */
  it('is held only by the tenant admin (and the internal sysadmin)', () => {
    expect(rolesWith(PERMISSIONS.VENDOR_ONBOARDING_CANCEL).sort()).toEqual(
      [ROLES.SYSADMIN, ROLES.TENANT_ADMIN].sort(),
    );
  });

  it('is not implied by being able to invite', () => {
    for (const role of rolesWith(PERMISSIONS.VENDOR_INVITE)) {
      if (role === ROLES.SYSADMIN || role === ROLES.TENANT_ADMIN) continue;
      expect(ROLE_PERMISSIONS[role]).not.toContain(PERMISSIONS.VENDOR_ONBOARDING_CANCEL);
    }
  });

  it('leaves name corrections with the vendor-master roles', () => {
    // Renaming is not destructive and stays broad — only cancelling narrowed.
    expect(rolesWith(PERMISSIONS.VENDOR_UPDATE)).toContain(ROLES.PROCUREMENT_OFFICER);
  });
});

describe('vendor onboarding queue visibility', () => {
  /**
   * GET /vendors/onboarding is gated on VENDOR_ONBOARDING_READ, so a reviewer
   * without it would be able to decide on an onboarding it cannot open.
   */
  it('is held by every role that can review an onboarding', () => {
    for (const role of rolesWith(PERMISSIONS.VENDOR_ONBOARDING_REVIEW)) {
      expect(ROLE_PERMISSIONS[role]).toContain(PERMISSIONS.VENDOR_ONBOARDING_READ);
    }
  });

  /**
   * Finance reads the vendor master and watches the onboarding pipeline because
   * it pays these vendors. It must not pick up *master* authority on the way —
   * no invite, no edit, no document verification — even where it now decides.
   */
  it('gives finance the vendor master and the queue, without master authority', () => {
    for (const role of [ROLES.FINANCE_OFFICER, ROLES.FINANCE_HEAD] as const) {
      expect(ROLE_PERMISSIONS[role]).toContain(PERMISSIONS.VENDOR_READ);
      expect(ROLE_PERMISSIONS[role]).toContain(PERMISSIONS.VENDOR_ONBOARDING_READ);
      expect(ROLE_PERMISSIONS[role]).not.toContain(PERMISSIONS.VENDOR_INVITE);
      expect(ROLE_PERMISSIONS[role]).not.toContain(PERMISSIONS.VENDOR_UPDATE);
      expect(ROLE_PERMISSIONS[role]).not.toContain(PERMISSIONS.VENDOR_DOC_VERIFY);
    }
  });

  /**
   * The onboarding decision is the AP officer's when the matrix routes
   * VENDOR_ONBOARDING to FINANCE_OFFICER — the queue's Approve/Reject panel
   * posts to a _REVIEW-gated route, so APPROVAL_DECIDE alone would 403. Finance
   * *head* stays a watcher: it is not on that chain.
   */
  it('gives the onboarding decision to the finance officer, not the head', () => {
    expect(ROLE_PERMISSIONS[ROLES.FINANCE_OFFICER]).toContain(
      PERMISSIONS.VENDOR_ONBOARDING_REVIEW,
    );
    expect(ROLE_PERMISSIONS[ROLES.FINANCE_HEAD]).not.toContain(
      PERMISSIONS.VENDOR_ONBOARDING_REVIEW,
    );
  });
});
