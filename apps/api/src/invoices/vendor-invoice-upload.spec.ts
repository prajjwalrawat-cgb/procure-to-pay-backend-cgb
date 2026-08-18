import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import type { StorageService } from '../common/storage/storage.service';
import { VendorInvoiceService, vendorUploadPrefix } from './vendor-invoice.service';

const TENANT = 'ten_1';
const UPLOADED = `${vendorUploadPrefix(TENANT)}ia_1-tax_invoice.pdf`;

/** Only the collaborators submit() touches. */
function build(objectExists = true) {
  const prisma = {
    client: {
      user: { findUnique: vi.fn().mockResolvedValue({ email: 'ap@vendor.test' }) },
      vendorContact: { findFirst: vi.fn().mockResolvedValue({ vendorId: 'ven_1' }) },
    },
  } as unknown as PrismaService;
  const createFromVendorPortal = vi.fn().mockResolvedValue('inv_1');
  const exists = vi.fn().mockResolvedValue(objectExists);

  const service = new VendorInvoiceService(
    prisma,
    { createFromVendorPortal } as never,
    {} as never, // refs
    { exists } as unknown as StorageService,
  );
  return { service, createFromVendorPortal, exists };
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
