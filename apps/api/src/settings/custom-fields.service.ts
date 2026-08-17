import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { newId } from '@procureflow/db';
import {
  CHOICE_FIELD_TYPES,
  customFieldKey,
  type CustomFieldCreateInput,
  type CustomFieldDefinition,
  type CustomFieldEntity,
  type CustomFieldUpdateInput,
  type CustomFieldValues,
} from '@procureflow/shared';

import { AuditLogService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Admin-defined custom fields (Slice 11).
 *
 * Definitions are tenant data; the values live on each document's own
 * `customFields` JSON, keyed by definition key. Because the allowed keys are
 * data rather than code, validation has to happen here — a Zod schema cannot
 * know them at compile time.
 */
@Injectable()
export class CustomFieldsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /** Definitions for one document type. Retired ones are included only for the
   *  admin screen; forms ask for active ones. */
  async list(
    tenantId: string,
    entityType: CustomFieldEntity,
    opts: { includeInactive?: boolean } = {},
  ): Promise<CustomFieldDefinition[]> {
    const rows = await this.prisma.client.customFieldDefinition.findMany({
      where: {
        tenantId,
        entityType,
        ...(opts.includeInactive ? {} : { isActive: true }),
      },
      orderBy: { orderNo: 'asc' },
    });
    return rows.map(toView);
  }

  async listAll(tenantId: string): Promise<CustomFieldDefinition[]> {
    const rows = await this.prisma.client.customFieldDefinition.findMany({
      where: { tenantId },
      orderBy: [{ entityType: 'asc' }, { orderNo: 'asc' }],
    });
    return rows.map(toView);
  }

  async create(
    tenantId: string,
    input: CustomFieldCreateInput,
    actorId: string,
  ): Promise<CustomFieldDefinition> {
    const key = await this.uniqueKey(tenantId, input.entityType, input.label);
    const last = await this.prisma.client.customFieldDefinition.findFirst({
      where: { tenantId, entityType: input.entityType },
      orderBy: { orderNo: 'desc' },
      select: { orderNo: true },
    });

    const row = await this.prisma.client.customFieldDefinition.create({
      data: {
        id: newId('customFieldDefinition'),
        tenantId,
        entityType: input.entityType,
        key,
        label: input.label,
        fieldType: input.fieldType,
        options: CHOICE_FIELD_TYPES.includes(input.fieldType)
          ? (input.options ?? [])
          : [],
        isRequired: input.isRequired ?? false,
        isPrintable: input.isPrintable ?? false,
        helpText: input.helpText ?? null,
        orderNo: (last?.orderNo ?? -1) + 1,
      },
    });
    await this.audit.record({
      action: 'settings.custom_field_created',
      entityType: 'CustomFieldDefinition',
      entityId: row.id,
      actorId,
      after: { entity: input.entityType, key, label: input.label, type: input.fieldType },
    });
    return toView(row);
  }

  async update(
    tenantId: string,
    id: string,
    input: CustomFieldUpdateInput,
    actorId: string,
  ): Promise<CustomFieldDefinition> {
    const existing = await this.prisma.client.customFieldDefinition.findFirst({
      where: { id, tenantId },
    });
    if (!existing) throw new NotFoundException('Custom field not found');

    if (
      input.options !== undefined &&
      CHOICE_FIELD_TYPES.includes(existing.fieldType) &&
      input.options.length === 0
    ) {
      throw new BadRequestException('A dropdown needs at least one choice.');
    }

    const row = await this.prisma.client.customFieldDefinition.update({
      where: { id },
      data: {
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.options !== undefined && CHOICE_FIELD_TYPES.includes(existing.fieldType)
          ? { options: input.options }
          : {}),
        ...(input.isRequired !== undefined ? { isRequired: input.isRequired } : {}),
        ...(input.isPrintable !== undefined ? { isPrintable: input.isPrintable } : {}),
        ...(input.helpText !== undefined ? { helpText: input.helpText ?? null } : {}),
        ...(input.orderNo !== undefined ? { orderNo: input.orderNo } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    await this.audit.record({
      action: 'settings.custom_field_updated',
      entityType: 'CustomFieldDefinition',
      entityId: id,
      actorId,
      before: toView(existing),
      after: toView(row),
    });
    return toView(row);
  }

  /**
   * Validates a submitted value bag against the tenant's active definitions and
   * returns the value to persist. Unknown keys are dropped rather than stored:
   * a client must not be able to write arbitrary JSON onto a document row.
   */
  async validate(
    tenantId: string,
    entityType: CustomFieldEntity,
    values: CustomFieldValues | null | undefined,
  ): Promise<CustomFieldValues | null> {
    const defs = await this.list(tenantId, entityType);
    if (defs.length === 0) return null;

    const clean: CustomFieldValues = {};
    const issues: string[] = [];

    for (const def of defs) {
      const raw = values?.[def.key];
      const empty =
        raw === undefined ||
        raw === null ||
        raw === '' ||
        (Array.isArray(raw) && raw.length === 0);

      if (empty) {
        if (def.isRequired) issues.push(`${def.label} is required`);
        continue;
      }

      switch (def.fieldType) {
        case 'NUMBER': {
          const n = Number(raw);
          if (Number.isNaN(n)) issues.push(`${def.label} must be a number`);
          else clean[def.key] = n;
          break;
        }
        case 'CHECKBOX':
          clean[def.key] = Boolean(raw);
          break;
        case 'DATE': {
          const iso = String(raw).slice(0, 10);
          if (Number.isNaN(Date.parse(iso))) issues.push(`${def.label} must be a date`);
          else clean[def.key] = iso;
          break;
        }
        case 'SELECT': {
          const v = String(raw);
          if (!def.options.includes(v))
            issues.push(`${def.label}: "${v}" is not a choice`);
          else clean[def.key] = v;
          break;
        }
        case 'MULTI_SELECT': {
          const list = Array.isArray(raw) ? raw.map(String) : [String(raw)];
          const bad = list.filter((v) => !def.options.includes(v));
          if (bad.length > 0) {
            issues.push(`${def.label}: ${bad.join(', ')} not a choice`);
          } else {
            clean[def.key] = list;
          }
          break;
        }
        default:
          clean[def.key] = String(raw).slice(0, 2000);
      }
    }

    if (issues.length > 0) throw new BadRequestException(issues.join('; '));
    return Object.keys(clean).length > 0 ? clean : null;
  }

  /** Labelled values for a detail page or a document — definition order, and
   *  only fields that still exist. */
  async describe(
    tenantId: string,
    entityType: CustomFieldEntity,
    values: unknown,
    opts: { printableOnly?: boolean } = {},
  ): Promise<{ key: string; label: string; value: unknown; fieldType: string }[]> {
    if (!values || typeof values !== 'object') return [];
    const bag = values as Record<string, unknown>;
    const defs = await this.list(tenantId, entityType, { includeInactive: true });
    return defs
      .filter((d) => !opts.printableOnly || d.isPrintable)
      .filter((d) => bag[d.key] !== undefined && bag[d.key] !== null && bag[d.key] !== '')
      .map((d) => ({
        key: d.key,
        label: d.label,
        value: bag[d.key],
        fieldType: d.fieldType,
      }));
  }

  /** Keys are derived from the label and frozen; a clash gets a numeric suffix
   *  rather than silently reusing another field's storage slot. */
  private async uniqueKey(
    tenantId: string,
    entityType: CustomFieldEntity,
    label: string,
  ): Promise<string> {
    const base = customFieldKey(label) || 'field';
    const taken = new Set(
      (
        await this.prisma.client.customFieldDefinition.findMany({
          where: { tenantId, entityType },
          select: { key: true },
        })
      ).map((r) => r.key),
    );
    if (!taken.has(base)) return base;
    for (let i = 2; i < 100; i += 1) {
      if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
    }
    throw new BadRequestException('Too many fields share that name.');
  }
}

function toView(row: {
  id: string;
  entityType: string;
  key: string;
  label: string;
  fieldType: string;
  options: string[];
  isRequired: boolean;
  isPrintable: boolean;
  helpText: string | null;
  orderNo: number;
  isActive: boolean;
}): CustomFieldDefinition {
  return {
    id: row.id,
    entityType: row.entityType as CustomFieldDefinition['entityType'],
    key: row.key,
    label: row.label,
    fieldType: row.fieldType as CustomFieldDefinition['fieldType'],
    options: row.options,
    isRequired: row.isRequired,
    isPrintable: row.isPrintable,
    helpText: row.helpText,
    orderNo: row.orderNo,
    isActive: row.isActive,
  };
}
