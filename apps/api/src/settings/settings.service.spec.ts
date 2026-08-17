import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AuditLogService } from '../audit/audit.service';
import type { StorageService } from '../common/storage/storage.service';
import type { PrismaService } from '../prisma/prisma.service';
import { SettingsService, tenantLogoKey } from './settings.service';

const DELHI = {
  id: 'plt_delhi',
  name: 'Delhi HQ',
  address: 'New Delhi',
  stateCode: '07',
  gstin: '07AABCA1234K1Z2',
  isDefault: true,
};
const BLR = {
  id: 'plt_blr',
  name: 'Bengaluru',
  address: 'Bengaluru',
  stateCode: '29',
  gstin: '29AABCA1234K1Z9',
  isDefault: false,
};

function build(opts: { branches?: (typeof DELHI)[]; hasLogo?: boolean } = {}) {
  const tenant = {
    id: 'ten_1',
    name: 'ArtBox Solutions',
    gstin: '07AABCA1234K1Z2',
    currency: 'INR',
  };
  const branches = opts.branches ?? [DELHI, BLR];

  const client = {
    tenant: {
      findUnique: vi.fn().mockResolvedValue(tenant),
      update: vi.fn().mockResolvedValue(tenant),
    },
    plant: {
      findMany: vi.fn().mockResolvedValue(branches),
      findFirst: vi
        .fn()
        .mockImplementation(({ where }: { where: { id?: string } }) =>
          Promise.resolve(branches.find((b) => b.id === where.id) ?? null),
        ),
      count: vi.fn().mockResolvedValue(branches.length),
      create: vi.fn().mockResolvedValue(DELHI),
      update: vi.fn().mockResolvedValue(DELHI),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const prisma = { client } as unknown as PrismaService;
  const audit = {
    record: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuditLogService;
  const storage = {
    put: vi.fn().mockResolvedValue('key'),
    exists: vi.fn().mockResolvedValue(opts.hasLogo ?? false),
    presignedGetUrl: vi.fn().mockResolvedValue('https://s3.example/logo?sig'),
  } as unknown as StorageService;
  return { service: new SettingsService(prisma, audit, storage), client, storage };
}

describe('SettingsService', () => {
  it('returns the tenant with all its GST registrations', async () => {
    const { service } = build();
    const settings = await service.get('ten_1');
    expect(settings.tenant.name).toBe('ArtBox Solutions');
    expect(settings.branches.map((b) => b.stateCode)).toEqual(['07', '29']);
    expect(settings.logoUrl).toBeNull();
  });

  it('presigns the logo only when the object exists', async () => {
    const { service } = build({ hasLogo: true });
    expect((await service.get('ten_1')).logoUrl).toBe('https://s3.example/logo?sig');
  });

  it('makes the very first registration the default even if not asked', async () => {
    const { service, client } = build({ branches: [] });
    client.plant.count.mockResolvedValue(0);
    await service.createBranch(
      'ten_1',
      { name: 'Delhi HQ', stateCode: '07', address: null, gstin: null },
      'usr_1',
    );
    expect(client.plant.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isDefault: true }) }),
    );
  });

  it('does not default a second registration unless asked', async () => {
    const { service, client } = build();
    await service.createBranch(
      'ten_1',
      { name: 'Bengaluru', stateCode: '29', address: null, gstin: null },
      'usr_1',
    );
    expect(client.plant.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isDefault: false }) }),
    );
    expect(client.plant.updateMany).not.toHaveBeenCalled();
  });

  it('demotes the previous default when a new one is promoted', async () => {
    const { service, client } = build();
    await service.setDefaultBranch('ten_1', 'plt_blr', 'usr_1');
    expect(client.plant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: 'ten_1', isDefault: true } }),
    );
    expect(client.plant.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'plt_blr' }, data: { isDefault: true } }),
    );
  });

  it('refuses to touch a branch belonging to another tenant', async () => {
    const { service } = build();
    await expect(service.setDefaultBranch('ten_1', 'plt_other', 'usr_1')).rejects.toThrow(
      /not found/i,
    );
  });

  it('clears the GSTIN when it is explicitly set to null', async () => {
    const { service, client } = build();
    await service.update('ten_1', { gstin: null }, 'usr_1');
    expect(client.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { gstin: null } }),
    );
  });

  it('leaves the tenant row untouched when nothing about it changed', async () => {
    const { service, client } = build();
    await service.update('ten_1', {}, 'usr_1');
    expect(client.tenant.update).not.toHaveBeenCalled();
  });

  it('stores the logo at the tenant-scoped key', async () => {
    const { service, storage } = build();
    await service.setLogo(
      'ten_1',
      { buffer: Buffer.from('png'), mimetype: 'image/png' },
      'usr_1',
    );
    expect(storage.put).toHaveBeenCalledWith(
      tenantLogoKey('ten_1'),
      expect.any(Buffer),
      'image/png',
    );
  });

  it('rejects a logo that is not an image', async () => {
    const { service } = build();
    await expect(
      service.setLogo(
        'ten_1',
        { buffer: Buffer.from('%PDF'), mimetype: 'application/pdf' },
        'usr_1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
