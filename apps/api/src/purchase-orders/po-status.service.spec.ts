import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import { PoStatusService } from './po-status.service';

interface Line {
  id: string;
  qtyOrdered: string;
  qtyReceived?: string;
}
interface Inv {
  status: string;
  grossAmount: string;
  lines?: { poLineId: string | null; qty: string }[];
}

function build(opts: {
  status?: string;
  acknowledged?: boolean;
  total?: string;
  lines?: Line[];
  invoices?: Inv[];
}) {
  const po = {
    id: 'po_1',
    tenantId: 'ten_1',
    status: opts.status ?? 'ACKNOWLEDGED',
    acknowledgedAt: opts.acknowledged === false ? null : new Date(),
    totalAmount: opts.total ?? '1000',
    lines: (opts.lines ?? [{ id: 'pol_1', qtyOrdered: '10' }]).map((l) => ({
      id: l.id,
      qtyOrdered: l.qtyOrdered,
      qtyReceived: l.qtyReceived ?? '0',
    })),
  };
  const update = vi.fn().mockResolvedValue({});
  const record = vi.fn().mockResolvedValue(undefined);
  // Applies the status filter the service asks Prisma for.
  const findMany = vi.fn(async (args: { where: { status?: { not: string } } }) =>
    (opts.invoices ?? [])
      .filter((i) => i.status !== args.where.status?.not)
      .map((i) => ({ ...i, lines: i.lines ?? [] })),
  );
  const prisma = {
    client: {
      purchaseOrder: { findUnique: vi.fn().mockResolvedValue(po), update },
      invoice: { findMany },
    },
  } as unknown as PrismaService;
  const service = new PoStatusService(prisma, { record } as never);
  return { service, update, record, findMany };
}

const newStatus = (update: ReturnType<typeof vi.fn>): string | undefined =>
  update.mock.calls[0]?.[0]?.data?.status;

describe('PoStatusService.recompute — billing and payment drive the status', () => {
  it('moves to PARTIALLY_INVOICED when an invoice covers part of the order', async () => {
    const { service, update } = build({
      invoices: [
        {
          status: 'OCR_DONE',
          grossAmount: '400',
          lines: [{ poLineId: 'pol_1', qty: '4' }],
        },
      ],
    });
    await service.recompute('po_1');
    expect(newStatus(update)).toBe('PARTIALLY_INVOICED');
  });

  it('moves to INVOICED when invoices cover the ordered quantity', async () => {
    const { service, update } = build({
      invoices: [
        {
          status: 'APPROVED',
          grossAmount: '1000',
          lines: [{ poLineId: 'pol_1', qty: '10' }],
        },
      ],
    });
    await service.recompute('po_1');
    expect(newStatus(update)).toBe('INVOICED');
  });

  // OCR-read and hand-typed invoice lines carry no PO-line link; the order is
  // still billed in full when the invoice value reaches the order value.
  it('counts an unlinked invoice as full billing when its value covers the order', async () => {
    const { service, update } = build({
      invoices: [
        {
          status: 'APPROVED',
          grossAmount: '999.50',
          lines: [{ poLineId: null, qty: '10' }],
        },
      ],
    });
    await service.recompute('po_1');
    expect(newStatus(update)).toBe('INVOICED');
  });

  it('stays INVOICED while an invoice is only part-paid', async () => {
    const { service, update } = build({
      invoices: [
        {
          status: 'PARTIALLY_PAID',
          grossAmount: '1000',
          lines: [{ poLineId: 'pol_1', qty: '10' }],
        },
      ],
    });
    await service.recompute('po_1');
    expect(newStatus(update)).toBe('INVOICED');
  });

  // The production case: no GRNs are being posted yet, so a fully invoiced and
  // fully paid order must close without a receipt.
  it('closes a fully invoiced order once every live invoice is paid — no GRN needed', async () => {
    const { service, update, record } = build({
      invoices: [
        { status: 'PAID', grossAmount: '600', lines: [{ poLineId: 'pol_1', qty: '6' }] },
        { status: 'PAID', grossAmount: '400', lines: [{ poLineId: 'pol_1', qty: '4' }] },
        {
          status: 'REJECTED',
          grossAmount: '1000',
          lines: [{ poLineId: 'pol_1', qty: '10' }],
        },
      ],
    });
    await service.recompute('po_1', 'usr_fin');
    expect(newStatus(update)).toBe('CLOSED');
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PO_STATUS_CHANGED',
        entityId: 'po_1',
        before: { status: 'ACKNOWLEDGED' },
        after: expect.objectContaining({ status: 'CLOSED' }),
      }),
    );
  });

  it('does not close a part-invoiced order even if what was billed is paid', async () => {
    const { service, update } = build({
      invoices: [
        { status: 'PAID', grossAmount: '400', lines: [{ poLineId: 'pol_1', qty: '4' }] },
      ],
    });
    await service.recompute('po_1');
    expect(newStatus(update)).toBe('PARTIALLY_INVOICED');
  });

  it('ignores rejected invoices', async () => {
    const { service, update } = build({
      status: 'PARTIALLY_INVOICED',
      invoices: [
        {
          status: 'REJECTED',
          grossAmount: '400',
          lines: [{ poLineId: 'pol_1', qty: '4' }],
        },
      ],
    });
    await service.recompute('po_1');
    expect(newStatus(update)).toBe('ACKNOWLEDGED');
  });

  it('falls back to ISSUED when the vendor never acknowledged', async () => {
    const { service, update } = build({ status: 'INVOICED', acknowledged: false });
    await service.recompute('po_1');
    expect(newStatus(update)).toBe('ISSUED');
  });
});

describe('PoStatusService.recompute — receipt when nothing is billed', () => {
  it('reports RECEIVED / PARTIALLY_RECEIVED from GRN quantities', async () => {
    const full = build({ lines: [{ id: 'pol_1', qtyOrdered: '10', qtyReceived: '10' }] });
    await full.service.recompute('po_1');
    expect(newStatus(full.update)).toBe('RECEIVED');

    const part = build({ lines: [{ id: 'pol_1', qtyOrdered: '10', qtyReceived: '3' }] });
    await part.service.recompute('po_1');
    expect(newStatus(part.update)).toBe('PARTIALLY_RECEIVED');
  });

  it('writes nothing when the status is already right', async () => {
    const { service, update, record } = build({ status: 'ACKNOWLEDGED' });
    await service.recompute('po_1');
    expect(update).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});

describe('PoStatusService.recompute — leaves non-derived states alone', () => {
  it.each(['DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'ON_HOLD', 'CANCELLED'])(
    'never touches a %s order',
    async (status) => {
      const { service, update } = build({
        status,
        invoices: [
          {
            status: 'PAID',
            grossAmount: '1000',
            lines: [{ poLineId: 'pol_1', qty: '10' }],
          },
        ],
      });
      await service.recompute('po_1');
      expect(update).not.toHaveBeenCalled();
    },
  );
});
