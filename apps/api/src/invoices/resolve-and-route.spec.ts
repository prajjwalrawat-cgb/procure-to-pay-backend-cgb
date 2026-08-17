import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import { InvoiceService } from './invoice.service';

/** Only the collaborators resolveAndRoute touches. */
function build(invoice: { status: string } | null, openExceptions = 0) {
  const submit = vi.fn().mockResolvedValue(undefined);
  const prisma = {
    client: {
      invoice: { findUnique: vi.fn().mockResolvedValue(invoice) },
      invoiceException: { count: vi.fn().mockResolvedValue(openExceptions) },
    },
  } as unknown as PrismaService;

  const service = new InvoiceService(
    prisma,
    {} as never, // audit
    {} as never, // events
    {} as never, // match
    {} as never, // ocr
    {} as never, // tds
    {} as never, // msme
    { submit } as never, // routing
  );
  return { service, submit };
}

describe('InvoiceService.resolveAndRoute', () => {
  it('routes a cleanly matched invoice', async () => {
    const { service, submit } = build({ status: 'OCR_DONE' });
    await service.resolveAndRoute('inv_1', 'usr_1');
    expect(submit).toHaveBeenCalledWith('INVOICE', 'inv_1', 'usr_1');
  });

  it('routes once the exceptions on a matched invoice are resolved', async () => {
    const { service, submit } = build({ status: 'MATCH_EXCEPTION' }, 0);
    await service.resolveAndRoute('inv_1', 'usr_1');
    expect(submit).toHaveBeenCalled();
  });

  it('refuses while an exception is still open', async () => {
    const { service, submit } = build({ status: 'MATCH_EXCEPTION' }, 2);
    await expect(service.resolveAndRoute('inv_1', 'usr_1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(submit).not.toHaveBeenCalled();
  });

  // The zero-exception count is meaningless before the matcher has run: nothing
  // was checked against the PO or the GRN, so routing would push an unverified
  // invoice into the approval chain.
  it.each(['OCR_PENDING', 'OCR_LOW_CONFIDENCE', 'OCR_FAILED', 'PENDING_VENDOR_MATCH'])(
    'refuses an unmatched invoice in %s even with no exceptions',
    async (status) => {
      const { service, submit } = build({ status }, 0);
      await expect(service.resolveAndRoute('inv_1', 'usr_1')).rejects.toThrow(
        /3-way match/i,
      );
      expect(submit).not.toHaveBeenCalled();
    },
  );

  it('404s an invoice that does not exist', async () => {
    const { service } = build(null);
    await expect(service.resolveAndRoute('inv_x', 'usr_1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
