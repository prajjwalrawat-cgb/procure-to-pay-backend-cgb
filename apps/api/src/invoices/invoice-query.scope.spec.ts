import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import { InvoiceQueryService } from './invoice-query.service';
import type { InvoiceScope } from './invoice-scope';

/** Only the models the scope path touches. */
function build(opts: {
  approvalDocIds?: string[];
  teamUserIds?: string[];
  visible?: boolean;
}) {
  const count = vi.fn().mockResolvedValue(0);
  const findFirst = vi.fn().mockResolvedValue(opts.visible === false ? null : { id: 'i1' });
  const prisma = {
    client: {
      invoice: { count, findFirst },
      approval: {
        findMany: vi
          .fn()
          .mockResolvedValue((opts.approvalDocIds ?? []).map((documentId) => ({ documentId }))),
      },
      userRole: {
        findMany: vi
          .fn()
          .mockResolvedValue((opts.teamUserIds ?? []).map((userId) => ({ userId }))),
      },
    },
  } as unknown as PrismaService;

  const service = new InvoiceQueryService(
    prisma,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, prisma, count, findFirst };
}

/** The OR branches applied to every tab of a scoped caller's counts. */
const branchesOf = (count: ReturnType<typeof vi.fn>): Record<string, unknown>[] => {
  const where = count.mock.calls[0]?.[0]?.where as Record<string, unknown>;
  const and = where.AND as [{ OR: Record<string, unknown>[] }];
  return and[0].OR;
};

const scoped: InvoiceScope = { userId: 'usr_1', team: false };
const head: InvoiceScope = { userId: 'usr_head', team: true };

describe('InvoiceQueryService scoping', () => {
  it('leaves a tenant-wide reader unnarrowed', async () => {
    const { service, count } = build({});
    await service.getTabCounts(null);
    expect(count.mock.calls[0]?.[0]?.where).not.toHaveProperty('AND');
  });

  it('narrows to invoices assigned to me or billed against my POs', async () => {
    const { service, count } = build({});
    await service.getTabCounts(scoped);
    expect(branchesOf(count)).toEqual([
      { assignedToId: 'usr_1' },
      { po: { createdBy: 'usr_1' } },
    ]);
  });

  it('includes invoices routed to me for approval', async () => {
    const { service, count } = build({ approvalDocIds: ['inv_9', 'inv_9', 'inv_10'] });
    await service.getTabCounts(scoped);
    expect(branchesOf(count)).toContainEqual({ id: { in: ['inv_9', 'inv_10'] } });
  });

  it("adds the team's POs for a head, and keeps the tab filter intact", async () => {
    const { service, count } = build({ teamUserIds: ['usr_a', 'usr_b'] });
    await service.getTabCounts(head);
    expect(branchesOf(count)).toContainEqual({
      po: { createdBy: { in: ['usr_a', 'usr_b'] } },
    });
    expect(count.mock.calls[1]?.[0]?.where).toMatchObject({ status: 'MATCH_EXCEPTION' });
  });

  it('does not look up the team for a plain officer', async () => {
    const { service, prisma } = build({});
    await service.getTabCounts(scoped);
    expect(prisma.client.userRole.findMany).not.toHaveBeenCalled();
  });

  it('404s an invoice outside the scope and passes anything through for tenant readers', async () => {
    const denied = build({ visible: false });
    await expect(denied.service.assertVisible('inv_x', scoped)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    const wide = build({ visible: false });
    await expect(wide.service.assertVisible('inv_x', null)).resolves.toBeUndefined();
    expect(wide.findFirst).not.toHaveBeenCalled();
  });
});
