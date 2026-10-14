import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@procureflow/db';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import { InvoiceService } from './invoice.service';

/** Only the collaborators reject() touches. */
function build(
  invoice: { status: string; paidAmount?: string } | null,
  opts: { inRun?: boolean } = {},
) {
  const record = vi.fn().mockResolvedValue(undefined);
  const emit = vi.fn().mockResolvedValue(undefined);
  const invoiceUpdate = vi.fn().mockResolvedValue(undefined);
  const approvalDelete = vi.fn().mockResolvedValue({ count: 0 });
  const invoiceRejected = vi.fn().mockResolvedValue(undefined);
  const prisma = {
    client: {
      invoice: {
        findUnique: vi.fn().mockResolvedValue(
          invoice && {
            id: 'inv_1',
            tenantId: 'ten_1',
            vendorId: 'ven_1',
            status: invoice.status,
            paidAmount: new Prisma.Decimal(invoice.paidAmount ?? '0'),
          },
        ),
        update: invoiceUpdate,
      },
      paymentRunItem: {
        findFirst: vi
          .fn()
          .mockResolvedValue(opts.inRun ? { paymentRun: { number: 'PR-0012' } } : null),
      },
      approval: { deleteMany: approvalDelete },
    },
  } as unknown as PrismaService;

  const service = new InvoiceService(
    prisma,
    { record } as never, // audit
    { emit } as never, // events
    {} as never, // match
    {} as never, // ocr
    {} as never, // tds
    {} as never, // msme
    {} as never, // routing
    { invoiceRejected } as never, // notifications
  );
  return { service, record, emit, invoiceUpdate, approvalDelete, invoiceRejected };
}

const REASON = 'Duplicate of INV-ZW0GAW';

describe('InvoiceService.reject', () => {
  // The production case: a duplicate sitting in MATCH_EXCEPTION, which used to
  // need routing to an approver just so it could be refused.
  it('rejects an invoice still in the exception queue, keeping the reason', async () => {
    const { service, invoiceUpdate, record, emit } = build({ status: 'MATCH_EXCEPTION' });
    await service.reject('inv_1', REASON, 'usr_ap');
    expect(invoiceUpdate).toHaveBeenCalledWith({
      where: { id: 'inv_1' },
      data: { status: 'REJECTED', rejectionReason: REASON },
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'invoice.rejected',
        actorId: 'usr_ap',
        before: { status: 'MATCH_EXCEPTION' },
        after: { reason: REASON },
      }),
    );
    expect(emit).toHaveBeenCalledWith(
      'InvoiceRejected',
      { invoiceId: 'inv_1', vendorId: 'ven_1' },
      'ten_1',
    );
  });

  it.each(['RECEIVED', 'OCR_PENDING', 'OCR_DONE', 'OCR_FAILED', 'HELD'])(
    'allows rejecting from %s',
    async (status) => {
      const { service, invoiceUpdate } = build({ status });
      await service.reject('inv_1', REASON, 'usr_ap');
      expect(invoiceUpdate).toHaveBeenCalled();
    },
  );

  it('tells the vendor', async () => {
    const { service, invoiceRejected } = build({ status: 'MATCH_EXCEPTION' });
    await service.reject('inv_1', REASON, 'usr_ap');
    expect(invoiceRejected).toHaveBeenCalledWith('inv_1');
  });

  it('sends nothing when the rejection is refused', async () => {
    const { service, invoiceRejected } = build({ status: 'APPROVED' });
    await expect(service.reject('inv_1', REASON, 'usr_ap')).rejects.toThrow();
    expect(invoiceRejected).not.toHaveBeenCalled();
  });

  it('clears pending approval steps so nobody is asked to decide on it', async () => {
    const { service, approvalDelete } = build({ status: 'HELD' });
    await service.reject('inv_1', REASON, 'usr_ap');
    expect(approvalDelete).toHaveBeenCalledWith({
      where: { documentType: 'INVOICE', documentId: 'inv_1', decision: 'PENDING' },
    });
  });

  // Once approval has started the decision belongs to the approver.
  it('leaves an invoice with its approver to the approver', async () => {
    const { service, invoiceUpdate } = build({ status: 'AWAITING_APPROVAL' });
    await expect(service.reject('inv_1', REASON, 'usr_ap')).rejects.toThrow(
      /with its approver/,
    );
    expect(invoiceUpdate).not.toHaveBeenCalled();
  });

  it.each(['APPROVED', 'SCHEDULED', 'PARTIALLY_PAID', 'PAID', 'REJECTED'])(
    'refuses an invoice already %s',
    async (status) => {
      const { service, invoiceUpdate } = build({ status });
      await expect(service.reject('inv_1', REASON, 'usr_ap')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(invoiceUpdate).not.toHaveBeenCalled();
    },
  );

  it('refuses once money has been paid against it', async () => {
    const { service, invoiceUpdate } = build({ status: 'HELD', paidAmount: '5000' });
    await expect(service.reject('inv_1', REASON, 'usr_ap')).rejects.toThrow(/payment/);
    expect(invoiceUpdate).not.toHaveBeenCalled();
  });

  it('refuses while a payment run holds it', async () => {
    const { service, invoiceUpdate } = build({ status: 'HELD' }, { inRun: true });
    await expect(service.reject('inv_1', REASON, 'usr_ap')).rejects.toThrow(/PR-0012/);
    expect(invoiceUpdate).not.toHaveBeenCalled();
  });

  it('404s an unknown invoice', async () => {
    const { service } = build(null);
    await expect(service.reject('inv_x', REASON, 'usr_ap')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
