import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@procureflow/db';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import { InvoiceService } from './invoice.service';

interface InvoiceRow {
  status: string;
  proformaRef?: string | null;
  grossAmount?: string;
  paidAmount?: string;
  proformaGrossAmount?: string | null;
  ocrVendorName?: string | null;
}

/** Only the collaborators resolveAndRoute touches. */
function build(
  invoice: InvoiceRow | null,
  opts: {
    openExceptions?: number;
    vendorMismatch?: number;
    approvals?: { decision: string }[];
  } = {},
) {
  const submit = vi.fn().mockResolvedValue(undefined);
  const record = vi.fn().mockResolvedValue(undefined);
  const invoiceUpdate = vi.fn().mockResolvedValue(undefined);
  const approvalDelete = vi.fn().mockResolvedValue({ count: 1 });
  const row = invoice && {
    id: 'inv_1',
    proformaRef: null,
    grossAmount: '0',
    paidAmount: '0',
    proformaGrossAmount: null,
    ocrVendorName: null,
    ...invoice,
  };
  const dec = (v: string | null) => (v === null ? null : new Prisma.Decimal(v));
  const prisma = {
    client: {
      invoice: {
        findUnique: vi.fn().mockResolvedValue(
          row && {
            ...row,
            grossAmount: dec(row.grossAmount),
            paidAmount: dec(row.paidAmount),
            proformaGrossAmount: dec(row.proformaGrossAmount),
          },
        ),
        update: invoiceUpdate,
      },
      invoiceException: {
        count: vi.fn(({ where }: { where: { exceptionType?: string } }) =>
          Promise.resolve(
            where.exceptionType === 'VENDOR_MISMATCH'
              ? (opts.vendorMismatch ?? 0)
              : (opts.openExceptions ?? 0),
          ),
        ),
      },
      approval: {
        findMany: vi.fn().mockResolvedValue(opts.approvals ?? []),
        deleteMany: approvalDelete,
      },
      paymentRecord: { findFirst: vi.fn().mockResolvedValue(null) },
    },
  } as unknown as PrismaService;

  const service = new InvoiceService(
    prisma,
    { record } as never, // audit
    {} as never, // events
    {} as never, // match
    {} as never, // ocr
    {} as never, // tds
    {} as never, // msme
    { submit } as never, // routing
  );
  return { service, submit, record, invoiceUpdate, approvalDelete };
}

describe('InvoiceService.resolveAndRoute', () => {
  it('routes a cleanly matched invoice', async () => {
    const { service, submit } = build({ status: 'OCR_DONE' });
    await expect(service.resolveAndRoute('inv_1', 'usr_1')).resolves.toEqual({
      outcome: 'ROUTED',
      reasons: [],
    });
    expect(submit).toHaveBeenCalledWith('INVOICE', 'inv_1', 'usr_1');
  });

  it('routes once the exceptions on a matched invoice are resolved', async () => {
    const { service, submit } = build({ status: 'MATCH_EXCEPTION' });
    await service.resolveAndRoute('inv_1', 'usr_1');
    expect(submit).toHaveBeenCalled();
  });

  it('refuses while an exception is still open', async () => {
    const { service, submit } = build({ status: 'MATCH_EXCEPTION' }, { openExceptions: 2 });
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
      const { service, submit } = build({ status });
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

/**
 * A tax invoice that replaced an approved proforma: an advance of 8,260 was
 * paid against a PI for 16,520.
 */
describe('InvoiceService.resolveAndRoute — tax invoice replacing a proforma', () => {
  const converted = (over: Partial<InvoiceRow> = {}): InvoiceRow => ({
    status: 'OCR_DONE',
    proformaRef: '07',
    proformaGrossAmount: '16520',
    grossAmount: '16520',
    paidAmount: '8260',
    ...over,
  });
  const approved = [{ decision: 'APPROVED' }];

  it('keeps the earlier approval when the tax invoice repeats the proforma', async () => {
    const { service, submit, invoiceUpdate, record } = build(converted(), {
      approvals: approved,
    });
    await expect(service.resolveAndRoute('inv_1', 'usr_1')).resolves.toEqual({
      outcome: 'APPROVAL_CARRIED_OVER',
      reasons: [],
    });
    expect(submit).not.toHaveBeenCalled();
    // Back to where its payments left it — not APPROVED, which reads as unpaid.
    expect(invoiceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'PARTIALLY_PAID' } }),
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'invoice.approval_carried_over' }),
    );
  });

  it('tolerates rounding on the total', async () => {
    const { service, submit } = build(converted({ grossAmount: '16520.80' }), {
      approvals: approved,
    });
    await service.resolveAndRoute('inv_1', 'usr_1');
    expect(submit).not.toHaveBeenCalled();
  });

  it('sends it back to the approver when the total went up', async () => {
    const { service, submit, approvalDelete } = build(
      converted({ grossAmount: '18000' }),
      { approvals: approved },
    );
    const result = await service.resolveAndRoute('inv_1', 'usr_1');
    expect(result.outcome).toBe('ROUTED');
    expect(result.reasons[0]).toMatch(/more than the .* approved on the proforma/);
    // The old rows go first, or the engine would treat it as already routed.
    expect(approvalDelete).toHaveBeenCalled();
    expect(submit).toHaveBeenCalledWith('INVOICE', 'inv_1', 'usr_1');
  });

  it('sends it back when the total is less than what was already paid', async () => {
    const { service, submit } = build(converted({ grossAmount: '8000' }), {
      approvals: approved,
    });
    const result = await service.resolveAndRoute('inv_1', 'usr_1');
    expect(result.reasons.join(' ')).toMatch(/less than the .* already paid/);
    expect(submit).toHaveBeenCalled();
  });

  it('sends it back when it comes from another supplier, even if overridden', async () => {
    const { service, submit } = build(converted({ ocrVendorName: 'ARTBOX PVT LTD' }), {
      approvals: approved,
      vendorMismatch: 1,
    });
    const result = await service.resolveAndRoute('inv_1', 'usr_1');
    expect(result.reasons.join(' ')).toMatch(/ARTBOX/);
    expect(submit).toHaveBeenCalled();
  });

  it('routes normally when the proforma was never approved', async () => {
    const { service, submit, approvalDelete } = build(converted({ paidAmount: '0' }));
    await expect(service.resolveAndRoute('inv_1', 'usr_1')).resolves.toEqual({
      outcome: 'ROUTED',
      reasons: [],
    });
    expect(approvalDelete).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalled();
  });
});
