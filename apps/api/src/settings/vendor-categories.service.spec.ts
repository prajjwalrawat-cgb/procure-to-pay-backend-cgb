import { BadRequestException } from '@nestjs/common';
import { VENDOR_CATEGORY_CONFIGS } from '@procureflow/shared';
import { describe, expect, it, vi } from 'vitest';

import type { AuditLogService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import { VendorCategoriesService } from './vendor-categories.service';

const row = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'vcc_1',
  categoryKey: 'RESELLER',
  displayName: 'Reseller',
  description: null,
  requiredDocuments: ['GST_CERT', 'PAN_CARD', 'CANCELLED_CHEQUE'],
  optionalDocuments: [],
  requiredScreenings: ['GSTIN_STATUS'],
  requiredCertifications: [],
  approvalMatrixName: 'Vendor onboarding — standard',
  slaHours: 120,
  isActive: true,
  ...over,
});

/** `findMany` is stubbed per call so a seeding round-trip can be modelled. */
function build(pages: ReturnType<typeof row>[][], activeCount = 2) {
  const findMany = vi.fn();
  for (const page of pages) findMany.mockResolvedValueOnce(page);
  findMany.mockResolvedValue(pages[pages.length - 1] ?? []);

  const client = {
    vendorCategoryConfig: {
      findMany,
      findFirst: vi.fn().mockResolvedValue(pages[0]?.[0] ?? null),
      create: vi.fn().mockImplementation(({ data }: { data: unknown }) => data),
      update: vi.fn().mockResolvedValue(row()),
      createMany: vi.fn().mockResolvedValue({ count: VENDOR_CATEGORY_CONFIGS.length }),
      count: vi.fn().mockResolvedValue(activeCount - 1),
    },
  };
  const prisma = { client } as unknown as PrismaService;
  const audit = {
    record: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuditLogService;
  return { service: new VendorCategoriesService(prisma, audit), client };
}

describe('VendorCategoriesService', () => {
  it('seeds the shipped starter set for a tenant that has none', async () => {
    const seeded = VENDOR_CATEGORY_CONFIGS.map((c, i) =>
      row({ id: `vcc_${i}`, categoryKey: c.categoryKey, displayName: c.displayName }),
    );
    const { service, client } = build([[], seeded]);

    const list = await service.list('ten_1');

    expect(client.vendorCategoryConfig.createMany).toHaveBeenCalledOnce();
    expect(list).toHaveLength(VENDOR_CATEGORY_CONFIGS.length);
  });

  it('leaves an already-configured tenant alone', async () => {
    const { service, client } = build([[row()]]);

    const list = await service.list('ten_1');

    expect(client.vendorCategoryConfig.createMany).not.toHaveBeenCalled();
    expect(list.map((c) => c.categoryKey)).toEqual(['RESELLER']);
  });

  it('hides retired categories from the dropdown but keeps them for the admin', async () => {
    const rows = [row(), row({ id: 'vcc_2', categoryKey: 'OEM', isActive: false })];
    const { service } = build([rows, rows, rows]);

    expect((await service.options('ten_1')).map((c) => c.key)).toEqual(['RESELLER']);
    expect(
      (await service.list('ten_1', { includeInactive: true })).map((c) => c.categoryKey),
    ).toEqual(['RESELLER', 'OEM']);
    // A vendor already filed under the retired one still resolves.
    expect((await service.find('ten_1', 'OEM'))?.displayName).toBe('Reseller');
  });

  it('derives the key from the name and refuses a name already taken', async () => {
    const { service, client } = build([[row()], [row()]]);

    await service.create('ten_1', { displayName: 'OEM' }, 'usr_1');
    expect(client.vendorCategoryConfig.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ categoryKey: 'OEM' }) }),
    );

    await expect(
      service.create('ten_1', { displayName: 'Reseller' }, 'usr_1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('will not let the last active category be retired', async () => {
    const { service } = build([[row()]], 1);

    await expect(
      service.update('ten_1', 'vcc_1', { isActive: false }, 'usr_1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
