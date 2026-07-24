import Decimal from 'decimal.js';
import { describe, expect, it, vi } from 'vitest';

import type { NotificationService } from '../approvals/notification.service';
import type { AuditLogService } from '../audit/audit.service';
import type { DomainEventService } from '../common/events/domain-event.service';
import type { StorageService } from '../common/storage/storage.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { RmaDocumentService } from './rma-document.service';
import { RmaService } from './rma.service';
import { RmaStateError } from './grn.errors';

const D = (v: string) =>
  new Decimal(v) as unknown as import('@procureflow/db').Prisma.Decimal;

type MockClient = Record<string, Record<string, ReturnType<typeof vi.fn>>>;

function build(client: MockClient) {
  const prisma = { client, currentTenantId: 'ten_1' } as unknown as PrismaService;
  const audit = { record: vi.fn() };
  const events = { emit: vi.fn() };
  const notifications = { notify: vi.fn() };
  const storage = { put: vi.fn().mockResolvedValue('key') };
  const pdf = {
    generate: vi.fn().mockResolvedValue({ buffer: Buffer.from('pdf'), hash: 'abc123' }),
  };
  const service = new RmaService(
    prisma,
    audit as unknown as AuditLogService,
    events as unknown as DomainEventService,
    notifications as unknown as NotificationService,
    storage as unknown as StorageService,
    pdf as unknown as RmaDocumentService,
  );
  return { service, audit, events, notifications, storage, pdf };
}

describe('RmaService.autoCreateFromGrn', () => {
  it('creates a DRAFT RMA for the rejected lines only', async () => {
    const client = {
      returnMaterialAuth: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'rma_1' }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      goodsReceiptNote: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'grn_1',
          number: 'GRN-0312',
          poId: 'po_1',
          po: { vendorId: 'ven_1' },
          lines: [
            {
              id: 'grnl_1',
              qtyRejected: D('0.2'),
              rejectionReason: 'VISIBLE_DAMAGE',
              poLine: { unitPrice: D('128500') },
            },
            { id: 'grnl_2', qtyRejected: D('0'), poLine: { unitPrice: D('100') } },
          ],
        }),
      },
    };
    const { service } = build(client);
    const res = await service.autoCreateFromGrn('grn_1', 'usr_1');
    expect(res?.id).toMatch(/^rma_/);
    const data = client.returnMaterialAuth.create.mock.calls[0][0].data;
    expect(data.status).toBe('DRAFT');
    expect(data.reasonCode).toBe('DAMAGED');
    expect(data.lines.createMany.data).toHaveLength(1);
    // 0.2 * 128500 = 25700
    expect(new Decimal(data.totalReturnValue.toString()).toFixed(0)).toBe('25700');
  });

  it('returns null when there are no rejections', async () => {
    const client = {
      returnMaterialAuth: { findFirst: vi.fn().mockResolvedValue(null) },
      goodsReceiptNote: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'grn_1',
          poId: 'po_1',
          po: { vendorId: 'ven_1' },
          lines: [{ id: 'grnl_1', qtyRejected: D('0'), poLine: { unitPrice: D('1') } }],
        }),
      },
    };
    const { service } = build(client);
    expect(await service.autoCreateFromGrn('grn_1', 'usr_1')).toBeNull();
  });
});

describe('RmaService.issue', () => {
  function client(status: string) {
    return {
      returnMaterialAuth: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'rma_1',
          number: 'RMA-0001',
          tenantId: 'ten_1',
          vendorId: 'ven_1',
          grnId: 'grn_1',
          status,
          totalReturnValue: D('25700'),
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      vendorContact: {
        findMany: vi.fn().mockResolvedValue([{ email: 'k@patel.example' }]),
      },
      user: { findMany: vi.fn().mockResolvedValue([{ id: 'usr_v' }]) },
    };
  }

  it('generates a PDF, uploads it, notifies the vendor, sets ISSUED', async () => {
    const c = client('DRAFT');
    const { service, pdf, storage, notifications } = build(c);
    await service.issue('rma_1', 'usr_1');
    expect(pdf.generate).toHaveBeenCalledWith('rma_1');
    expect(storage.put).toHaveBeenCalled();
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'usr_v', type: 'RMA_ISSUED' }),
    );
    const data = c.returnMaterialAuth.update.mock.calls[0][0].data;
    expect(data.status).toBe('ISSUED');
    expect(data.pdfGeneratedHash).toBe('abc123');
  });

  it('rejects issuing a non-draft RMA', async () => {
    const { service } = build(client('ISSUED'));
    await expect(service.issue('rma_1', 'usr_1')).rejects.toBeInstanceOf(RmaStateError);
  });
});

describe('RmaService lifecycle guards', () => {
  const findUnique = (status: string) =>
    vi
      .fn()
      .mockResolvedValue({ id: 'rma_1', status, vendorId: 'ven_1', creditNoteRef: null });

  it('recordPickup requires ISSUED', async () => {
    const { service } = build({
      returnMaterialAuth: { findUnique: findUnique('DRAFT') },
    });
    await expect(
      service.recordPickup('rma_1', 'V1', 'GP1', 'usr_1'),
    ).rejects.toBeInstanceOf(RmaStateError);
  });

  it('close requires CREDIT_NOTE_RECEIVED', async () => {
    const { service } = build({
      returnMaterialAuth: { findUnique: findUnique('PICKED_UP') },
    });
    await expect(service.close('rma_1', 'usr_1')).rejects.toBeInstanceOf(RmaStateError);
  });
});
