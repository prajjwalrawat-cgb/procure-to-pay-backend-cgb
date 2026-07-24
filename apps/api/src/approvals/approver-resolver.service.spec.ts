import type { ApprovalContext } from '@procureflow/shared';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import { AmbiguousApproverError } from './approval.errors';
import { ApproverResolver } from './approver-resolver.service';

interface FakeUserRole {
  userId: string;
  deptId?: string | null;
  plantId?: string | null;
}

function makePrisma(opts: {
  userRoles: FakeUserRole[];
  delegations?: Array<{
    delegateUserId: string;
    scope: string;
    documentTypes: string[];
  }>;
}): PrismaService {
  return {
    client: {
      role: { findUnique: vi.fn().mockResolvedValue({ id: 'role_dept_head' }) },
      userRole: {
        findMany: vi.fn().mockResolvedValue(opts.userRoles),
        findFirst: vi
          .fn()
          .mockResolvedValue(
            opts.userRoles[0] ? { userId: opts.userRoles[0].userId } : null,
          ),
      },
      delegation: { findMany: vi.fn().mockResolvedValue(opts.delegations ?? []) },
    },
  } as unknown as PrismaService;
}

const ctx: ApprovalContext = {
  documentType: 'INVOICE',
  total_amount: '100000',
  dept_id: 'dep_1',
  assigned_to_id: 'usr_officer',
};

describe('ApproverResolver.resolve', () => {
  it('resolves DEPT_HEAD + dept scope to the single matching user', async () => {
    const resolver = new ApproverResolver(
      makePrisma({ userRoles: [{ userId: 'usr_head', deptId: 'dep_1' }] }),
    );
    const result = await resolver.resolve('DEPT_HEAD', 'dept', ctx, {
      documentType: 'INVOICE',
      tenantId: 'ten_1',
    });
    expect(result.approverId).toBe('usr_head');
    expect(result.delegatedFromId).toBeNull();
  });

  it('throws AmbiguousApproverError on zero candidates', async () => {
    const resolver = new ApproverResolver(makePrisma({ userRoles: [] }));
    await expect(
      resolver.resolve('DEPT_HEAD', 'dept', ctx, {
        documentType: 'INVOICE',
        tenantId: 'ten_1',
      }),
    ).rejects.toBeInstanceOf(AmbiguousApproverError);
  });

  it('throws AmbiguousApproverError on multiple candidates', async () => {
    const resolver = new ApproverResolver(
      makePrisma({
        userRoles: [
          { userId: 'usr_a', deptId: 'dep_1' },
          { userId: 'usr_b', deptId: 'dep_1' },
        ],
      }),
    );
    await expect(
      resolver.resolve('DEPT_HEAD', 'dept', ctx, {
        documentType: 'INVOICE',
        tenantId: 'ten_1',
      }),
    ).rejects.toBeInstanceOf(AmbiguousApproverError);
  });

  it('redirects to the delegate when an active delegation covers the doc type', async () => {
    const resolver = new ApproverResolver(
      makePrisma({
        userRoles: [{ userId: 'usr_head', deptId: 'dep_1' }],
        delegations: [
          { delegateUserId: 'usr_delegate', scope: 'ALL', documentTypes: [] },
        ],
      }),
    );
    const result = await resolver.resolve('DEPT_HEAD', 'dept', ctx, {
      documentType: 'INVOICE',
      tenantId: 'ten_1',
    });
    expect(result.approverId).toBe('usr_delegate');
    expect(result.delegatedFromId).toBe('usr_head');
  });

  it('resolves assigned scope to the officer on the document', async () => {
    const resolver = new ApproverResolver(
      makePrisma({ userRoles: [{ userId: 'usr_officer' }] }),
    );
    const candidates = await resolver.candidatesForRole(
      'PROCUREMENT_OFFICER',
      'assigned',
      ctx,
    );
    expect(candidates).toEqual(['usr_officer']);
  });
});
