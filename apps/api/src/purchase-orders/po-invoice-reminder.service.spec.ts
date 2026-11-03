import { describe, expect, it, vi } from 'vitest';

import {
  NO_INVOICE_REMINDER_DAYS,
  PO_NO_INVOICE_NOTIFICATION,
  PoInvoiceReminderService,
} from './po-invoice-reminder.service';

const NOW = new Date('2026-10-17T03:30:00Z');
const DAY = 24 * 60 * 60 * 1000;

function po(over: Record<string, unknown> = {}) {
  return {
    id: 'po_1',
    number: 'PO-0001',
    totalAmount: { toString: () => '118000' },
    currency: 'INR',
    issuedAt: new Date(NOW.getTime() - 6 * DAY),
    createdAt: new Date(NOW.getTime() - 7 * DAY),
    createdBy: 'u_buyer',
    issuedBy: 'u_buyer',
    billToPlantId: 'plant_a',
    vendor: { name: 'Acme Supplies' },
    ...over,
  };
}

function build(opts: {
  pos?: unknown[];
  financeRoles?: { userId: string; plantId: string | null }[];
  alreadySent?: { userId: string; entityId: string }[];
  users?: { id: string; email: string; name: string }[];
}) {
  const purchaseOrderFindMany = vi.fn().mockResolvedValue(opts.pos ?? [po()]);
  const client = {
    purchaseOrder: { findMany: purchaseOrderFindMany },
    userRole: { findMany: vi.fn().mockResolvedValue(opts.financeRoles ?? []) },
    notification: { findMany: vi.fn().mockResolvedValue(opts.alreadySent ?? []) },
    user: {
      findMany: vi.fn().mockResolvedValue(
        opts.users ?? [
          { id: 'u_buyer', email: 'buyer@x.test', name: 'Bina Buyer' },
          { id: 'u_fin', email: 'fin@x.test', name: 'Farah Finance' },
          { id: 'u_fin_b', email: 'finb@x.test', name: 'Plant B Finance' },
        ],
      ),
    },
    tenant: { findUnique: vi.fn().mockResolvedValue({ name: 'Star Cement Ltd' }) },
  };
  const prisma = {
    client,
    tenant: { findMany: vi.fn().mockResolvedValue([{ id: 't1' }]) },
    runInTenantContext: vi.fn((_t: string, fn: () => Promise<unknown>) => fn()),
  };
  const notify = vi.fn().mockResolvedValue(undefined);
  const send = vi.fn().mockResolvedValue(undefined);
  const config = { get: vi.fn().mockReturnValue('https://app.test') };
  const logger = { setContext: vi.fn(), error: vi.fn() };
  const svc = new PoInvoiceReminderService(
    config as never,
    prisma as never,
    { notify } as never,
    { send } as never,
    logger as never,
  );
  return { svc, notify, send, purchaseOrderFindMany };
}

describe('PoInvoiceReminderService.sweepAll', () => {
  it('only looks at issued POs past the cutoff with no live invoice', async () => {
    const { svc, purchaseOrderFindMany } = build({});
    await svc.sweepAll(NOW);

    const where = purchaseOrderFindMany.mock.calls[0]![0].where;
    const cutoff = new Date(NOW.getTime() - NO_INVOICE_REMINDER_DAYS * DAY);
    expect(where.status.in).toEqual(['ISSUED', 'ACKNOWLEDGED', 'PARTIALLY_RECEIVED', 'RECEIVED']);
    expect(where.OR[0]).toEqual({ issuedAt: { lte: cutoff } });
    // A rejected invoice does not count as one uploaded.
    expect(where.invoices).toEqual({ none: { status: { not: 'REJECTED' } } });
  });

  it('notifies the buyer and in-scope finance officers, one digest email each', async () => {
    const { svc, notify, send } = build({
      pos: [po(), po({ id: 'po_2', number: 'PO-0002' })],
      financeRoles: [
        { userId: 'u_fin', plantId: null },
        { userId: 'u_fin_b', plantId: 'plant_b' },
      ],
    });
    const res = await svc.sweepAll(NOW);

    // 2 POs × (buyer + tenant-wide finance); the plant-B officer is out of scope.
    expect(notify).toHaveBeenCalledTimes(4);
    expect(notify.mock.calls.map((c) => c[0].userId).sort()).toEqual([
      'u_buyer',
      'u_buyer',
      'u_fin',
      'u_fin',
    ]);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: PO_NO_INVOICE_NOTIFICATION,
        entityId: 'po_1',
        href: '/purchase-orders/po_1',
        title: 'PO-0001 has no invoice after 6 days',
      }),
    );
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map((c) => c[0].to).sort()).toEqual(['buyer@x.test', 'fin@x.test']);
    expect(send.mock.calls[0]![0].subject).toBe('2 purchase orders have no invoice after 5+ days');
    expect(res).toEqual({ tenants: 1, pos: 2, emails: 2 });
  });

  it('does not remind the same person about the same PO twice', async () => {
    const { svc, notify, send } = build({
      financeRoles: [{ userId: 'u_fin', plantId: null }],
      alreadySent: [{ userId: 'u_buyer', entityId: 'po_1' }],
    });
    await svc.sweepAll(NOW);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0].userId).toBe('u_fin');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].to).toBe('fin@x.test');
  });

  it('keeps going when an email fails — the notification already stands', async () => {
    const { svc, send, notify } = build({ financeRoles: [{ userId: 'u_fin', plantId: null }] });
    send.mockRejectedValueOnce(new Error('SMTP down'));
    const res = await svc.sweepAll(NOW);

    expect(notify).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(res.emails).toBe(2);
  });
});
