import { describe, expect, it, vi } from 'vitest';

import { InventoryIssueService } from './inventory-issue.service';
import { InventoryValidationError, LedgerStateError } from './inventory.errors';

const baseIssue = {
  productId: 'prd_1',
  locationId: 'loc_1',
  qty: 10,
  issueDept: 'PHOTOSHOOT' as const,
  issuedToName: 'Mr. Shivam',
};

function makeService(
  opts: {
    tenant?: { inventoryIssueApprovalQty: number; inventoryIssueApprovalValue: number };
    lastRate?: string | null;
    issue?: Record<string, unknown> | null;
    openBalance?: number;
  } = {},
) {
  const posts: Record<string, unknown>[] = [];
  let n = 0;

  const client = {
    tenant: {
      findUnique: vi.fn(async () => ({
        inventoryIssueApprovalQty: opts.tenant?.inventoryIssueApprovalQty ?? 50,
        inventoryIssueApprovalValue: opts.tenant?.inventoryIssueApprovalValue ?? 25_000,
      })),
    },
    stockLedgerEntry: {
      findFirst: vi.fn(async () =>
        opts.lastRate === undefined || opts.lastRate === null
          ? null
          : { rate: opts.lastRate },
      ),
      findUnique: vi.fn(async () =>
        opts.issue === undefined
          ? {
              id: 'sle_1',
              txnType: 'INTERNAL_ISSUE',
              qty: 20,
              productId: 'prd_1',
              locationId: 'loc_1',
              issueDept: 'SALES',
              issuedToName: 'Mr. Gaurav',
            }
          : opts.issue,
      ),
    },
  };

  const ledger = {
    post: vi.fn(async (input: Record<string, unknown>) => {
      posts.push(input);
      n += 1;
      return `sle_ret_${n}`;
    }),
    openBalanceForIssue: vi.fn(async () => opts.openBalance ?? 20),
  } as never;

  const service = new InventoryIssueService(
    { client, currentTenantId: 'ten_1' } as never,
    ledger,
    { require: vi.fn(async () => ({ id: 'prd_1' })) } as never,
    { require: vi.fn(async () => ({ id: 'loc_1' })) } as never,
    { record: vi.fn(async () => undefined) } as never,
  );
  return { service, posts };
}

describe('issue — approval threshold (business rule 3)', () => {
  it('allows a small issue with no approver', async () => {
    const { service, posts } = makeService();
    await service.issue(baseIssue, 'usr_1');
    expect(posts[0]).toMatchObject({ txnType: 'INTERNAL_ISSUE', qty: 10, balanceQty: 10 });
  });

  it('requires an approver at or above the quantity threshold', async () => {
    const { service } = makeService({
      tenant: { inventoryIssueApprovalQty: 50, inventoryIssueApprovalValue: 25_000 },
    });
    await expect(
      service.issue({ ...baseIssue, qty: 50 }, 'usr_1'),
    ).rejects.toBeInstanceOf(InventoryValidationError);
  });

  it('accepts a large issue once an approver is named', async () => {
    const { service, posts } = makeService();
    await service.issue({ ...baseIssue, qty: 200, approvedById: 'usr_boss' }, 'usr_1');
    expect(posts[0]).toMatchObject({ approvedById: 'usr_boss' });
  });

  it('requires an approver at or above the value threshold', async () => {
    // 10 units at 3000 each = 30,000, over the 25,000 default.
    const { service } = makeService({ lastRate: '3000' });
    await expect(service.issue(baseIssue, 'usr_1')).rejects.toThrow(/valued at/i);
  });

  it('applies only the quantity gate when the product has never had a rate', async () => {
    const { service, posts } = makeService({ lastRate: null });
    await service.issue(baseIssue, 'usr_1');
    expect(posts).toHaveLength(1);
  });

  it('records the issued quantity as the immutable balance snapshot', async () => {
    const { service, posts } = makeService();
    await service.issue({ ...baseIssue, qty: 7 }, 'usr_1');
    expect(posts[0]).toMatchObject({ qty: 7, balanceQty: 7 });
  });
});

describe('recordReturn — balance math across partial returns', () => {
  it('links the return to its issue and reports the new balance', async () => {
    const { service, posts } = makeService({ openBalance: 20 });
    const res = await service.recordReturn('sle_1', { qty: 5 }, 'usr_1');

    expect(posts[0]).toMatchObject({
      txnType: 'INTERNAL_RETURN',
      qty: 5,
      issueEntryId: 'sle_1',
    });
    expect(res).toMatchObject({ balanceQty: 15, status: 'OPEN' });
  });

  it('closes the issue when the last unit comes back', async () => {
    const { service } = makeService({ openBalance: 5 });
    const res = await service.recordReturn('sle_1', { qty: 5 }, 'usr_1');
    expect(res).toMatchObject({ balanceQty: 0, status: 'CLOSED' });
  });

  it('refuses to return more than is outstanding', async () => {
    const { service } = makeService({ openBalance: 3 });
    await expect(service.recordReturn('sle_1', { qty: 4 }, 'usr_1')).rejects.toThrow(
      /exceeds the outstanding balance/i,
    );
  });

  it('refuses a return against an already-closed issue', async () => {
    const { service } = makeService({ openBalance: 0 });
    await expect(service.recordReturn('sle_1', { qty: 1 }, 'usr_1')).rejects.toThrow(
      /already fully returned/i,
    );
  });

  it('defaults the return location to where the stock was issued from', async () => {
    const { service, posts } = makeService();
    await service.recordReturn('sle_1', { qty: 2 }, 'usr_1');
    expect(posts[0]).toMatchObject({ locationId: 'loc_1' });
  });

  it('accepts an explicit different return location', async () => {
    const { service, posts } = makeService();
    await service.recordReturn('sle_1', { qty: 2, locationId: 'loc_9' }, 'usr_1');
    expect(posts[0]).toMatchObject({ locationId: 'loc_9' });
  });

  it('refuses a return against a movement that is not an issue', async () => {
    const { service } = makeService({
      issue: { id: 'sle_1', txnType: 'VENDOR_INWARD', qty: 20 },
    });
    await expect(service.recordReturn('sle_1', { qty: 1 }, 'usr_1')).rejects.toBeInstanceOf(
      LedgerStateError,
    );
  });

  it('refuses a return against an unknown entry', async () => {
    const { service } = makeService({ issue: null });
    await expect(service.recordReturn('sle_x', { qty: 1 }, 'usr_1')).rejects.toThrow(
      /not found/i,
    );
  });
});
