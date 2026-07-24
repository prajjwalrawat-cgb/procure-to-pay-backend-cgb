import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditLogService } from '../../audit/audit.service';
import { DomainEventService } from '../../common/events/domain-event.service';
import { StorageService } from '../../common/storage/storage.service';
import { PrismaService } from '../../prisma/prisma.service';
import { InvoiceService } from '../invoice.service';
import { EmailIntakeService } from './email-intake.service';

const pdf = () => ({
  filename: 'invoice.pdf',
  mimeType: 'application/pdf',
  contentBase64: Buffer.from('%PDF-1.4 hello').toString('base64'),
});

function build(vendor: { id: string } | null) {
  const created: { data: Record<string, unknown> }[] = [];
  const client = {
    vendor: { findFirst: vi.fn().mockResolvedValue(vendor) },
    inboundEmail: {
      create: vi.fn(async (a: { data: Record<string, unknown> }) => {
        created.push(a);
        return a.data;
      }),
    },
    invoiceAttachment: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    client,
    // Execute the callback immediately, no real transaction.
    runInTenantContext: (_tid: string, fn: () => Promise<unknown>) => fn(),
  } as unknown as PrismaService;
  const storage = { put: vi.fn().mockResolvedValue('k') } as unknown as StorageService;
  const createFromUpload = vi.fn().mockResolvedValue('inv_1');
  const invoices = { createFromUpload } as unknown as InvoiceService;
  const audit = { record: vi.fn() } as unknown as AuditLogService;
  const events = { emit: vi.fn() } as unknown as DomainEventService;
  const svc = new EmailIntakeService(prisma, storage, invoices, audit, events);
  return { svc, created, createFromUpload };
}

const payload = (over: Record<string, unknown> = {}) => ({
  from: 'ap@patel-eng.example',
  subject: 'Invoice PES/2026/9001',
  text: 'Please find attached.',
  attachments: [pdf()],
  ...over,
});

describe('EmailIntakeService.ingest — sender validation (fraud control)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates an invoice via the shared upload path for a recognised sender', async () => {
    const { svc, createFromUpload } = build({ id: 'ven_patel' });
    const res = await svc.ingest('ten_1', payload());
    expect(res.status).toBe('INVOICE_CREATED');
    expect(res.invoiceId).toBe('inv_1');
    // Reuses createFromUpload with source EMAIL — no divergent creation logic.
    expect(createFromUpload).toHaveBeenCalledWith(
      'ten_1',
      'system',
      expect.objectContaining({ vendorId: 'ven_patel', source: 'EMAIL' }),
    );
  });

  it('quarantines an unrecognised sender to PENDING_VENDOR_MATCH (never auto-attaches)', async () => {
    const { svc, createFromUpload, created } = build(null);
    const res = await svc.ingest('ten_1', payload({ from: 'spoof@evil.example' }));
    expect(res.status).toBe('PENDING_VENDOR_MATCH');
    expect(res.invoiceId).toBeNull();
    expect(createFromUpload).not.toHaveBeenCalled();
    expect(created[0]!.data.status).toBe('PENDING_VENDOR_MATCH');
  });

  it('dead-letters an email with no attachment', async () => {
    const { svc } = build({ id: 'ven_patel' });
    const res = await svc.ingest('ten_1', payload({ attachments: [] }));
    expect(res.status).toBe('DEAD_LETTER');
    expect(res.reason).toBe('NO_ATTACHMENT');
  });

  it('dead-letters an unsupported attachment type', async () => {
    const { svc } = build({ id: 'ven_patel' });
    const res = await svc.ingest(
      'ten_1',
      payload({
        attachments: [
          {
            filename: 'x.exe',
            mimeType: 'application/x-msdownload',
            contentBase64: 'AA==',
          },
        ],
      }),
    );
    expect(res.status).toBe('DEAD_LETTER');
    expect(res.reason).toBe('UNSUPPORTED_FILE_TYPE');
  });
});
