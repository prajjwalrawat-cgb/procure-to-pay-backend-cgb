import { ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import { VendorPoService } from './vendor-po.service';

const ISSUED_AT = new Date('2026-11-19T10:00:00Z');

function po(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'po_1',
    tenantId: 'ten_1',
    number: 'PO-0530',
    vendorId: 'ven_1',
    status,
    issuedAt: ISSUED_AT,
    acknowledgedAt: null,
    createdBy: 'usr_buyer',
    lines: [],
    vendor: { gstin: null },
    billToPlant: null,
    comments: [],
    ...extra,
  };
}

function build(row: ReturnType<typeof po> | null) {
  const update = vi.fn().mockResolvedValue({});
  const findMany = vi.fn().mockResolvedValue([]);
  const prisma = {
    client: {
      user: { findUnique: vi.fn().mockResolvedValue({ email: 'sales@vendor.test' }) },
      vendorContact: { findFirst: vi.fn().mockResolvedValue({ vendorId: 'ven_1' }) },
      plant: { findFirst: vi.fn().mockResolvedValue({ stateCode: '07' }) },
      purchaseOrder: {
        findUnique: vi.fn().mockResolvedValue(row),
        findMany,
        update,
      },
    },
  } as unknown as PrismaService;
  const record = vi.fn().mockResolvedValue(undefined);
  const service = new VendorPoService(
    prisma,
    { record } as never,
    { notify: vi.fn() } as never,
    { list: vi.fn().mockResolvedValue([]) } as never,
  );
  return { service, update, findMany, record };
}

describe('VendorPoService.acknowledge — only an issued order', () => {
  it('acknowledges an ISSUED order', async () => {
    const { service, update } = build(po('ISSUED'));
    await service.acknowledge('usr_v', 'po_1');
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'ACKNOWLEDGED' }),
      }),
    );
  });

  // PO-0530: cancelled by the buyer, then acknowledged from the portal — which
  // overwrote CANCELLED with ACKNOWLEDGED and reopened it for invoicing.
  it.each(['CANCELLED', 'CLOSED', 'RECEIVED', 'PARTIALLY_RECEIVED', 'INVOICED'])(
    'refuses a %s order and leaves its status alone',
    async (status) => {
      const { service, update, record } = build(po(status));
      await expect(service.acknowledge('usr_v', 'po_1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(update).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    },
  );
});

describe('VendorPoService — an order the vendor was never issued is invisible', () => {
  it('hides an order cancelled before it was issued', async () => {
    const { service } = build(po('CANCELLED', { issuedAt: null }));
    await expect(service.detail('usr_v', 'po_1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.acknowledge('usr_v', 'po_1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it.each(['DRAFT', 'AWAITING_APPROVAL', 'APPROVED'])(
    'hides a %s order',
    async (status) => {
      const { service } = build(po(status, { issuedAt: null }));
      await expect(service.detail('usr_v', 'po_1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    },
  );

  it('still shows an order cancelled after it was issued', async () => {
    const { service } = build(po('CANCELLED'));
    await expect(service.detail('usr_v', 'po_1')).resolves.toMatchObject({
      status: 'CANCELLED',
    });
  });

  it('lists only orders that were issued', async () => {
    const { service, findMany } = build(null);
    await service.list('usr_v');
    const where = findMany.mock.calls[0][0].where;
    expect(where.vendorId).toBe('ven_1');
    expect(where.issuedAt).toEqual({ not: null });
  });
});
