import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import { InvoiceService } from './invoice.service';

const INVOICE = 'inv_1';
const S3_KEY = 'invoices/vendor/ten_1/ia_1-tax_invoice.pdf';

/**
 * An invoice whose OCR job is lost has no route back on its own: the job is
 * enqueued once, at creation, and nothing re-enqueues it. That is not a rare
 * shape — the production backlog was stranded exactly this way when the Redis
 * instance was replaced and the queued jobs did not come with it.
 *
 * What the retry must NOT do is matter as much: re-reading a document whose
 * lines a person has since corrected by hand would overwrite their work.
 */
function build(invoice: { status: string } | null, hasAttachment = true) {
  const submit = vi.fn().mockResolvedValue('job_1');
  const updates: Record<string, unknown>[] = [];
  const prisma = {
    client: {
      invoice: {
        findUnique: vi.fn(async () =>
          invoice ? { id: INVOICE, tenantId: 'ten_1', status: invoice.status } : null,
        ),
        update: vi.fn(async (a: { data: Record<string, unknown> }) => {
          updates.push(a.data);
          return {};
        }),
      },
      invoiceAttachment: {
        findFirst: vi.fn(async () => (hasAttachment ? { s3Key: S3_KEY } : null)),
      },
    },
  } as unknown as PrismaService;

  const service = new InvoiceService(
    prisma,
    { record: vi.fn() } as never, // audit
    { emit: vi.fn() } as never, // events
    { runFor: vi.fn() } as never, // match
    { submit } as never, // ocr
    { computeFor: vi.fn() } as never, // tds
    { computeDueDate: vi.fn() } as never, // msme
    {} as never, // routing
  );
  return { service, submit, updates };
}

describe('InvoiceService.retryOcr', () => {
  it('re-queues an invoice stranded in OCR_PENDING', async () => {
    const { service, submit } = build({ status: 'OCR_PENDING' });
    await service.retryOcr(INVOICE, 'usr_1');
    expect(submit).toHaveBeenCalledWith({
      invoiceId: INVOICE,
      tenantId: 'ten_1',
      s3Key: S3_KEY,
    });
  });

  it('re-queues an OCR_FAILED invoice and clears the failed status first', async () => {
    // The provider may be configured differently now — which is exactly the
    // case when the sandbox simulator is replaced by a real engine. Leaving it
    // reading FAILED while a job is in flight would be its own small lie.
    const { service, submit, updates } = build({ status: 'OCR_FAILED' });
    await service.retryOcr(INVOICE, 'usr_1');
    expect(updates[0]).toEqual({ status: 'OCR_PENDING' });
    expect(submit).toHaveBeenCalled();
  });

  it('refuses once a person has taken over', async () => {
    // OCR_DONE means lines exist — possibly hand-corrected through manual
    // entry. Re-extracting would overwrite that work.
    for (const status of ['OCR_DONE', 'MATCH_EXCEPTION', 'APPROVED', 'PAID']) {
      const { service, submit } = build({ status });
      await expect(service.retryOcr(INVOICE, 'usr_1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(submit, status).not.toHaveBeenCalled();
    }
  });

  it('refuses when no document is attached', async () => {
    const { service, submit } = build({ status: 'OCR_PENDING' }, false);
    await expect(service.retryOcr(INVOICE, 'usr_1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it('404s on an unknown invoice', async () => {
    const { service } = build(null);
    await expect(service.retryOcr(INVOICE, 'usr_1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
