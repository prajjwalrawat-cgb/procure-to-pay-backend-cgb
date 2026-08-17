import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AuditLogService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import { CustomFieldsService } from './custom-fields.service';

const def = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'cfd_1',
  entityType: 'PURCHASE_ORDER',
  key: 'project_code',
  label: 'Project code',
  fieldType: 'TEXT',
  options: [] as string[],
  isRequired: false,
  isPrintable: false,
  helpText: null,
  orderNo: 0,
  isActive: true,
  ...over,
});

function build(defs: ReturnType<typeof def>[]) {
  const client = {
    customFieldDefinition: {
      findMany: vi.fn().mockResolvedValue(defs),
      findFirst: vi.fn().mockResolvedValue(defs[0] ?? null),
      create: vi.fn().mockImplementation(({ data }: { data: unknown }) => data),
      update: vi.fn().mockResolvedValue(defs[0]),
    },
  };
  const prisma = { client } as unknown as PrismaService;
  const audit = {
    record: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuditLogService;
  return { service: new CustomFieldsService(prisma, audit), client };
}

describe('CustomFieldsService.validate', () => {
  it('drops keys the tenant never defined', async () => {
    const { service } = build([def()]);
    const clean = await service.validate('ten_1', 'PURCHASE_ORDER', {
      project_code: 'PRJ-1',
      // A client must not be able to write arbitrary JSON onto the document.
      injected: 'nope',
    });
    expect(clean).toEqual({ project_code: 'PRJ-1' });
  });

  it('rejects a value that is not one of the defined choices', async () => {
    const { service } = build([
      def({ fieldType: 'SELECT', key: 'bucket', options: ['Capex', 'Opex'] }),
    ]);
    await expect(
      service.validate('ten_1', 'PURCHASE_ORDER', { bucket: 'Something else' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a missing required field', async () => {
    const { service } = build([def({ isRequired: true })]);
    await expect(service.validate('ten_1', 'PURCHASE_ORDER', {})).rejects.toThrow(
      /Project code is required/,
    );
  });

  it('coerces numbers and checkboxes to their stored types', async () => {
    const { service } = build([
      def({ key: 'floors', fieldType: 'NUMBER' }),
      def({ id: 'cfd_2', key: 'urgent', fieldType: 'CHECKBOX' }),
    ]);
    const clean = await service.validate('ten_1', 'PURCHASE_ORDER', {
      floors: '12',
      urgent: 'yes',
    });
    expect(clean).toEqual({ floors: 12, urgent: true });
  });

  it('rejects a number that is not numeric', async () => {
    const { service } = build([def({ key: 'floors', fieldType: 'NUMBER' })]);
    await expect(
      service.validate('ten_1', 'PURCHASE_ORDER', { floors: 'twelve' }),
    ).rejects.toThrow(/must be a number/);
  });

  it('returns null when the tenant has defined no fields at all', async () => {
    const { service } = build([]);
    expect(await service.validate('ten_1', 'PURCHASE_ORDER', { a: 1 })).toBeNull();
  });

  it('derives a frozen key from the label', async () => {
    const { service, client } = build([]);
    client.customFieldDefinition.findMany.mockResolvedValue([]);
    client.customFieldDefinition.create.mockResolvedValue(
      def({ key: 'site_contact', label: 'Site contact' }),
    );
    await service.create(
      'ten_1',
      { entityType: 'PURCHASE_ORDER', label: 'Site contact', fieldType: 'TEXT' },
      'usr_1',
    );
    expect(client.customFieldDefinition.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ key: 'site_contact' }) }),
    );
  });

  it('suffixes a key that would collide with an existing field', async () => {
    const { service, client } = build([]);
    client.customFieldDefinition.findMany.mockResolvedValue([{ key: 'site_contact' }]);
    client.customFieldDefinition.create.mockResolvedValue(def());
    await service.create(
      'ten_1',
      { entityType: 'PURCHASE_ORDER', label: 'Site Contact', fieldType: 'TEXT' },
      'usr_1',
    );
    expect(client.customFieldDefinition.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ key: 'site_contact_2' }),
      }),
    );
  });
});
