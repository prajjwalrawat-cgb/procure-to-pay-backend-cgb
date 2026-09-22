import { describe, expect, it, vi } from 'vitest';

import type { AnalyticsDailyService } from '../analytics/analytics-daily.service';
import type { PrismaService } from '../prisma/prisma.service';
import { HomeActivityService } from './home-activity.service';

const TENANT = '00000000-0000-0000-0000-00000000000a';

function build() {
  const audits = [
    {
      id: 'aud_2',
      timestamp: new Date('2026-09-21T10:00:00Z'),
      action: 'PO_ISSUED',
      entityType: 'PurchaseOrder',
      entityId: 'po_1',
      actorId: 'usr_1',
      actorType: 'USER',
      before: null,
      after: { number: 'PO-0502' },
    },
    {
      id: 'aud_1',
      timestamp: new Date('2026-09-21T08:00:00Z'),
      action: 'APPROVAL_DECIDED',
      entityType: 'Requisition',
      entityId: 'pr_1',
      actorId: 'usr_2',
      actorType: 'USER',
      before: { stepNo: 1 },
      after: { decision: 'REJECTED' },
    },
  ];
  const exceptions = [
    {
      id: 'exc_1',
      invoiceId: 'inv_1',
      exceptionType: 'QTY_VARIANCE',
      severity: 'MEDIUM',
      raisedAt: new Date('2026-09-21T09:00:00Z'),
      raisedBy: 'system',
    },
  ];
  const client = {
    auditLog: { findMany: vi.fn().mockResolvedValue(audits) },
    invoiceException: { findMany: vi.fn().mockResolvedValue(exceptions) },
    purchaseOrder: { findMany: vi.fn().mockResolvedValue([{ id: 'po_1', number: 'PO-0502' }]) },
    requisition: { findMany: vi.fn().mockResolvedValue([{ id: 'pr_1', number: 'PR-0101' }]) },
    invoice: { findMany: vi.fn().mockResolvedValue([{ id: 'inv_1', number: 'INV-0042' }]) },
    user: {
      findMany: vi.fn().mockResolvedValue([
        { id: 'usr_1', name: 'Rakesh Das' },
        { id: 'usr_2', name: 'Harpreet Kaur' },
      ]),
    },
  };
  const prisma = { client, currentTenantId: TENANT } as unknown as PrismaService;
  const daily = { ensureFresh: vi.fn().mockResolvedValue(new Date()) } as unknown as AnalyticsDailyService;
  return { svc: new HomeActivityService(prisma, daily), client };
}

describe('HomeActivityService.getActivity', () => {
  it('merges audit events and exceptions newest-first with numbers, actors and links', async () => {
    const { svc, client } = build();
    const res = await svc.getActivity({ limit: 2 });

    expect(res.items.map((i) => [i.kind, i.title, i.detail, i.href])).toEqual([
      ['order', 'PO-0502 issued to vendor', 'by R. Das · Purchase order', '/purchase-orders/po_1'],
      ['exception', 'Qty variance on INV-0042', 'Auto-detected · Medium severity', '/invoices/inv_1'],
    ]);
    // 3 candidates for a page of 2 → a cursor to the oldest item shown.
    expect(res.nextBefore).toBe('2026-09-21T09:00:00.000Z');

    // One lookup per entity type, never per row; each source fetched limit + 1.
    expect(client.purchaseOrder.findMany).toHaveBeenCalledTimes(1);
    expect(client.invoice.findMany).toHaveBeenCalledTimes(1);
    expect(client.auditLog.findMany.mock.calls[0]![0].take).toBe(3);
    expect(client.auditLog.findMany.mock.calls[0]![0].where.tenantId).toBe(TENANT);
  });

  it('passes the `before` cursor to both sources', async () => {
    const { svc, client } = build();
    await svc.getActivity({ limit: 20, before: '2026-09-21T09:30:00.000Z' });
    expect(client.auditLog.findMany.mock.calls[0]![0].where.timestamp.lt.toISOString()).toBe(
      '2026-09-21T09:30:00.000Z',
    );
    expect(client.invoiceException.findMany.mock.calls[0]![0].where.raisedAt.lt.toISOString()).toBe(
      '2026-09-21T09:30:00.000Z',
    );
  });
});
