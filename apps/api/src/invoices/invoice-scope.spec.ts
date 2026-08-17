import { PERMISSIONS } from '@procureflow/shared';
import { describe, expect, it } from 'vitest';

import type { AuthUser } from '../auth/auth.types';
import { invoiceScope } from './invoice-scope';

const user = (perms: string[]): AuthUser => ({
  userId: 'usr_1',
  tenantId: 'ten_1',
  audience: 'buyer',
  roles: [],
  perms,
});

describe('invoice read scope', () => {
  it('does not narrow a tenant-wide reader', () => {
    expect(invoiceScope(user([PERMISSIONS.INVOICE_READ_TENANT]))).toBeNull();
  });

  it('narrows a caller who only holds the assigned scope', () => {
    expect(invoiceScope(user([PERMISSIONS.INVOICE_READ_ASSIGNED]))).toEqual({
      userId: 'usr_1',
      team: false,
    });
  });

  it('flags the team scope for a head', () => {
    const head = [PERMISSIONS.INVOICE_READ_ASSIGNED, PERMISSIONS.INVOICE_READ_TEAM];
    expect(invoiceScope(user(head))).toEqual({ userId: 'usr_1', team: true });
  });

  it('keeps the tenant scope when a caller holds both', () => {
    const both = [PERMISSIONS.INVOICE_READ_TENANT, PERMISSIONS.INVOICE_READ_ASSIGNED];
    expect(invoiceScope(user(both))).toBeNull();
  });
});
