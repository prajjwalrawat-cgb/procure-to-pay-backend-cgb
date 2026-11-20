import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import { InvoiceService } from './invoice.service';

/** Only the collaborators confirmOcr() touches. */
function build(invoice: { status: string; lines?: number } | null) {
  const record = vi.fn().mockResolvedValue(undefined);
  const invoiceUpdate = vi.fn().mockResolvedValue({});
  const runFor = vi.fn().mockResolvedValue(undefined);
  const recompute = vi.fn().mockResolvedValue(undefined);
  const prisma = {
    client: {
      invoice: {
        findUnique: vi.fn().mockResolvedValue(
          invoice && {
            id: 'inv_1',
            tenantId: 'ten_1',
            poId: 'po_1',
            status: invoice.status,
            ocrConfidence: '0.6100',
            _count: { lines: invoice.lines ?? 1 },
          },
        ),
        update: invoiceUpdate,
      },
    },
  } as unknown as PrismaService;

  const service = new InvoiceService(
    prisma,
    { record } as never, // audit
    {} as never, // events
    { runFor } as never, // match
    {} as never, // ocr
    {} as never, // tds
    {} as never, // msme
    {} as never, // routing
    {} as never, // notifications
    { recompute } as never, // poStatus
  );
  return { service, record, invoiceUpdate, runFor, recompute };
}

describe('InvoiceService.confirmOcr', () => {
  // The production case: INV-6Z4ZHS — a portal tax invoice whose lines already
  // match its PO, parked in OCR_LOW_CONFIDENCE with no way forward short of
  // retyping it as a single line.
  it.each(['OCR_LOW_CONFIDENCE', 'OCR_FAILED'])(
    'confirms a %s invoice as-is and runs the 3-way match',
    async (status) => {
      const { service, invoiceUpdate, runFor, record, recompute } = build({ status });
      await service.confirmOcr('inv_1', 'usr_ap');

      expect(invoiceUpdate).toHaveBeenCalledWith({
        where: { id: 'inv_1' },
        data: { status: 'OCR_DONE', headerAwaitingOcr: false },
      });
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'invoice.ocr_confirmed',
          entityId: 'inv_1',
          actorId: 'usr_ap',
          before: { status, ocrConfidence: '0.6100' },
        }),
      );
      expect(recompute).toHaveBeenCalledWith('po_1', 'usr_ap');
      expect(runFor).toHaveBeenCalledWith('inv_1', 'usr_ap');
    },
  );

  it('refuses an invoice with no lines — there is nothing to confirm', async () => {
    const { service, invoiceUpdate, runFor } = build({
      status: 'OCR_LOW_CONFIDENCE',
      lines: 0,
    });
    await expect(service.confirmOcr('inv_1', 'usr_ap')).rejects.toThrow(
      /enter the lines/i,
    );
    expect(invoiceUpdate).not.toHaveBeenCalled();
    expect(runFor).not.toHaveBeenCalled();
  });

  it.each(['OCR_PENDING', 'OCR_DONE', 'MATCH_EXCEPTION', 'AWAITING_APPROVAL', 'PAID'])(
    'refuses a %s invoice',
    async (status) => {
      const { service, invoiceUpdate } = build({ status });
      await expect(service.confirmOcr('inv_1', 'usr_ap')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(invoiceUpdate).not.toHaveBeenCalled();
    },
  );

  it('404s an unknown invoice', async () => {
    const { service } = build(null);
    await expect(service.confirmOcr('inv_x', 'usr_ap')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
