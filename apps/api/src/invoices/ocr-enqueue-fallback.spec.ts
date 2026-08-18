import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import { InvoiceService } from './invoice.service';

const TENANT = 'ten_1';

/**
 * Redis is the one collaborator here that is allowed to be down. The invoice row
 * is written before the OCR job is queued, so a rejected enqueue must not fail
 * the request — it must leave the invoice in a state AP can still act on.
 */
function build(submit: () => Promise<string>) {
  const stored: { status: string } = { status: 'OCR_PENDING' };
  const tx = {
    invoice: {
      findUnique: vi.fn(async () => stored),
      update: vi.fn(async ({ data }: { data: { status: string } }) => {
        stored.status = data.status;
        return stored;
      }),
    },
  };
  const prisma = {
    client: {
      vendor: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'ven_1',
          isMsme: false,
          gstin: '07AAAAA0000A1Z5',
        }),
      },
      tenant: {
        findUniqueOrThrow: vi
          .fn()
          .mockResolvedValue({ tdsRate: '0', msmePaymentCapDays: 45 }),
      },
      invoice: { create: vi.fn().mockResolvedValue({}), update: vi.fn() },
    },
    runInTenantContext: vi.fn(async (_t: string, fn: (t: unknown) => Promise<void>) =>
      fn(tx),
    ),
  } as unknown as PrismaService;

  const service = new InvoiceService(
    prisma,
    { record: vi.fn() } as never, // audit
    { emit: vi.fn() } as never, // events
    {} as never, // match
    { submit: vi.fn(submit) } as never, // ocr
    { computeFor: vi.fn().mockResolvedValue({ toString: () => '0' }) } as never, // tds
    { computeDueDate: vi.fn() } as never, // msme
    {} as never, // routing
  );
  return { service, stored, prisma };
}

const upload = {
  vendorId: 'ven_1',
  vendorInvoiceRef: 'INV/1',
  s3Key: 'invoices/ten_1/vendor/ia_1-tax.pdf',
};

describe('InvoiceService — OCR enqueue failure', () => {
  it('still accepts the invoice when the queue is unreachable', async () => {
    const { service } = build(() => Promise.reject(new Error('ECONNREFUSED')));
    await expect(service.createFromUpload(TENANT, 'usr_1', upload)).resolves.toBeTypeOf(
      'string',
    );
  });

  // OCR_PENDING with no queued job is a dead end: no worker will pick it up, the
  // 3-way match never runs, and resolveAndRoute refuses it forever. OCR_FAILED
  // is the manual data-entry queue, which AP can actually clear.
  it('parks the invoice in the manual data-entry fallback', async () => {
    const { service, stored } = build(() => Promise.reject(new Error('quota')));
    await service.createFromUpload(TENANT, 'usr_1', upload);
    expect(stored.status).toBe('OCR_FAILED');
  });

  it('records the job id and leaves the status alone when the queue is up', async () => {
    const { service, stored, prisma } = build(() => Promise.resolve('job_9'));
    await service.createFromUpload(TENANT, 'usr_1', upload);
    expect(stored.status).toBe('OCR_PENDING');
    expect(prisma.client.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { ocrJobId: 'job_9' } }),
    );
  });
});
