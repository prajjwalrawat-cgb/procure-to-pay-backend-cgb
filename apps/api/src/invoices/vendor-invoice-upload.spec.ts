import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import type { StorageService } from '../common/storage/storage.service';
import { VendorInvoiceService, vendorUploadPrefix } from './vendor-invoice.service';

const TENANT = 'ten_1';
const UPLOADED = `${vendorUploadPrefix(TENANT)}ia_1-tax_invoice.pdf`;

/**
 * Only the collaborators submit() touches.
 *
 * `openPoIds` is what `refs.vendorOpenPos` will offer — an order absent from it
 * has nothing left to bill, which submit() must refuse. `existing` is the
 * vendor's invoices already on file; the mock applies the status / id filters
 * the service asks Prisma for, so REJECTED and the excluded id drop out.
 */
interface ExistingInvoice {
  id: string;
  status: string;
  vendorInvoiceRef: string;
  ocrVendorInvoiceRef?: string | null;
  proformaRef?: string | null;
}

function build(
  objectExists = true,
  openPoIds: string[] = ['po_1'],
  existing: ExistingInvoice[] = [],
) {
  const findMany = vi.fn(
    async (args: { where: { status?: { not: string }; id?: { not: string } } }) =>
      existing
        .filter((i) => i.status !== args.where.status?.not)
        .filter((i) => i.id !== args.where.id?.not)
        .map((i) => ({
          vendorInvoiceRef: i.vendorInvoiceRef,
          ocrVendorInvoiceRef: i.ocrVendorInvoiceRef ?? null,
          proformaRef: i.proformaRef ?? null,
        })),
  );
  const prisma = {
    client: {
      user: { findUnique: vi.fn().mockResolvedValue({ email: 'ap@vendor.test' }) },
      vendorContact: { findFirst: vi.fn().mockResolvedValue({ vendorId: 'ven_1' }) },
      purchaseOrder: {
        findFirst: vi.fn().mockResolvedValue({ number: 'PO-0498' }),
      },
      invoice: {
        findMany,
        findFirst: vi.fn().mockResolvedValue({ id: 'inv_pi' }),
      },
    },
  } as unknown as PrismaService;
  const createFromVendorPortal = vi.fn().mockResolvedValue('inv_1');
  const attachTaxInvoice = vi.fn().mockResolvedValue(undefined);
  const exists = vi.fn().mockResolvedValue(objectExists);
  const vendorOpenPos = vi.fn().mockResolvedValue(openPoIds.map((id) => ({ id })));

  const service = new VendorInvoiceService(
    prisma,
    { createFromVendorPortal, attachTaxInvoice } as never,
    { vendorOpenPos } as never, // refs
    { exists } as unknown as StorageService,
  );
  return { service, createFromVendorPortal, attachTaxInvoice, exists, vendorOpenPos };
}

const payload = (s3Key: string) =>
  ({
    poId: 'po_1',
    vendorInvoiceRef: 'INV/1',
    invoiceDate: new Date().toISOString(),
    s3Key,
    lines: [],
  }) as never;

describe('VendorInvoiceService.submit — attachment key', () => {
  it('creates the invoice when the key was really uploaded', async () => {
    const { service, createFromVendorPortal } = build();
    await service.submit(TENANT, 'usr_1', payload(UPLOADED));
    expect(createFromVendorPortal).toHaveBeenCalled();
  });

  // The portal used to invent this shape from the chosen filename without
  // uploading anything, leaving the buyer's attachment link on a dead key.
  it('refuses a key the portal synthesised instead of uploading', async () => {
    const { service, createFromVendorPortal } = build();
    await expect(
      service.submit(TENANT, 'usr_1', payload('invoices/vendor/PO-1_123_scan.pdf')),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(createFromVendorPortal).not.toHaveBeenCalled();
  });

  // s3Key is client-supplied, so it must not be able to name another tenant's
  // object and have the buyer's detail page presign a download for it.
  it("refuses a key under another tenant's prefix", async () => {
    const { service, createFromVendorPortal } = build();
    await expect(
      service.submit(
        TENANT,
        'usr_1',
        payload(`${vendorUploadPrefix('ten_2')}ia_9-x.pdf`),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(createFromVendorPortal).not.toHaveBeenCalled();
  });

  it('refuses a well-formed key with no object behind it', async () => {
    const { service, createFromVendorPortal } = build(false);
    await expect(
      service.submit(TENANT, 'usr_1', payload(UPLOADED)),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(createFromVendorPortal).not.toHaveBeenCalled();
  });
});

describe('VendorInvoiceService.submit — exhausted purchase order', () => {
  // Hiding the order from the picker is presentation. A stale tab or a
  // hand-rolled call still names a poId, and the order is the authorisation:
  // once nothing remains billable there is no quantity that clears the match.
  it('refuses an invoice against an order with nothing left to bill', async () => {
    const { service, createFromVendorPortal } = build(true, []);
    await expect(
      service.submit(TENANT, 'usr_1', payload(UPLOADED)),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(createFromVendorPortal).not.toHaveBeenCalled();
  });

  it('names the order and says what to do about it', async () => {
    const { service } = build(true, []);
    await expect(service.submit(TENANT, 'usr_1', payload(UPLOADED))).rejects.toThrow(
      /PO-0498 has already been invoiced.*amend/s,
    );
  });

  it('still accepts an order that has quantity remaining', async () => {
    const { service, createFromVendorPortal } = build(true, ['po_1']);
    await service.submit(TENANT, 'usr_1', payload(UPLOADED));
    expect(createFromVendorPortal).toHaveBeenCalled();
  });

  it('does not block a PO-less invoice', async () => {
    // Nothing to check against, and PO_MISSING is the matcher's job to raise.
    const { service, createFromVendorPortal, vendorOpenPos } = build(true, []);
    await service.submit(TENANT, 'usr_1', {
      ...(payload(UPLOADED) as object),
      poId: null,
    } as never);
    expect(createFromVendorPortal).toHaveBeenCalled();
    expect(vendorOpenPos).not.toHaveBeenCalled();
  });
});

describe('VendorInvoiceService — duplicate invoice number', () => {
  const live = (ref: string, extra: Partial<ExistingInvoice> = {}): ExistingInvoice => ({
    id: 'inv_old',
    status: 'MATCH_EXCEPTION',
    vendorInvoiceRef: ref,
    ...extra,
  });

  // The production case: the same MAKV486/26-27 filed twice, leaving the buyer
  // with a CRITICAL duplicate exception to reject by hand.
  it('refuses a number this vendor has already submitted', async () => {
    const { service, createFromVendorPortal } = build(true, ['po_1'], [live('INV/1')]);
    await expect(
      service.submit(TENANT, 'usr_1', payload(UPLOADED)),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(createFromVendorPortal).not.toHaveBeenCalled();
  });

  it('compares numbers ignoring case, spacing and punctuation', async () => {
    const { service } = build(true, ['po_1'], [live('inv - 1')]);
    await expect(service.submit(TENANT, 'usr_1', payload(UPLOADED))).rejects.toThrow(
      /INV\/1 has already been submitted/,
    );
  });

  it('catches the number OCR read off an earlier document', async () => {
    const { service } = build(true, ['po_1'], [
      live('Invoice attached', { ocrVendorInvoiceRef: 'INV/1' }),
    ]);
    await expect(
      service.submit(TENANT, 'usr_1', payload(UPLOADED)),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  // Rejection is how a bad invoice is sent back; the corrected one may reuse
  // its number.
  it('allows resubmitting the number of a rejected invoice', async () => {
    const { service, createFromVendorPortal } = build(true, ['po_1'], [
      live('INV/1', { status: 'REJECTED' }),
    ]);
    await service.submit(TENANT, 'usr_1', payload(UPLOADED));
    expect(createFromVendorPortal).toHaveBeenCalled();
  });

  it('accepts a new number', async () => {
    const { service, createFromVendorPortal } = build(true, ['po_1'], [live('INV/2')]);
    await service.submit(TENANT, 'usr_1', payload(UPLOADED));
    expect(createFromVendorPortal).toHaveBeenCalled();
  });

  it("lets a tax invoice keep its own proforma's number", async () => {
    const { service, attachTaxInvoice } = build(true, ['po_1'], [
      live('INV/1', { id: 'inv_pi', status: 'APPROVED' }),
    ]);
    await service.attachTaxInvoice(TENANT, 'usr_1', 'inv_pi', payload(UPLOADED));
    expect(attachTaxInvoice).toHaveBeenCalled();
  });

  it("refuses a tax invoice reusing another invoice's number", async () => {
    const { service, attachTaxInvoice } = build(true, ['po_1'], [
      live('INV/1', { id: 'inv_other', status: 'PAID' }),
    ]);
    await expect(
      service.attachTaxInvoice(TENANT, 'usr_1', 'inv_pi', payload(UPLOADED)),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(attachTaxInvoice).not.toHaveBeenCalled();
  });
});
