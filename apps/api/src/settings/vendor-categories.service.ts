import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { newId } from '@procureflow/db';
import {
  NEW_CATEGORY_DEFAULTS,
  VENDOR_CATEGORY_CONFIGS,
  vendorCategoryKey,
  type ScreeningType,
  type VendorCategory,
  type VendorCategoryCreateInput,
  type VendorCategoryOption,
  type VendorCategoryUpdateInput,
  type VendorDocumentType,
} from '@procureflow/shared';

import { AuditLogService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';

/** The shape Prisma hands back — the four list columns are `Json`. */
interface CategoryRow {
  id: string;
  categoryKey: string;
  displayName: string;
  description: string | null;
  requiredDocuments: unknown;
  optionalDocuments: unknown;
  requiredScreenings: unknown;
  requiredCertifications: unknown;
  approvalMatrixName: string;
  slaHours: number;
  isActive: boolean;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
}

function toView(row: CategoryRow): VendorCategory {
  return {
    id: row.id,
    categoryKey: row.categoryKey,
    displayName: row.displayName,
    description: row.description,
    requiredDocuments: strings(row.requiredDocuments) as VendorDocumentType[],
    optionalDocuments: strings(row.optionalDocuments) as VendorDocumentType[],
    requiredScreenings: strings(row.requiredScreenings) as ScreeningType[],
    requiredCertifications: strings(row.requiredCertifications) as VendorDocumentType[],
    approvalMatrixName: row.approvalMatrixName,
    slaHours: row.slaHours,
    isActive: row.isActive,
  };
}

/**
 * Vendor categories, per tenant.
 *
 * The categories a business buys in are its own — a reseller/OEM distributor
 * and a cement plant do not share a list — so the shipped
 * `VENDOR_CATEGORY_CONFIGS` act as a starter set an admin then edits, rather
 * than as the enumeration. Everything that offers or validates a category goes
 * through here, so retiring "Mechanical spares" removes it from the invite
 * dialog and the self-registration page at once.
 *
 * Must run inside a tenant context (RLS): callers outside one — the public
 * self-registration routes — wrap these calls in `runInTenantContext`.
 */
@Injectable()
export class VendorCategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /** Retired categories are included only for the admin screen; dropdowns and
   *  validation ask for the active ones. */
  async list(
    tenantId: string,
    opts: { includeInactive?: boolean } = {},
  ): Promise<VendorCategory[]> {
    const rows = await this.rows(tenantId);
    return rows.filter((r) => opts.includeInactive || r.isActive).map(toView);
  }

  async options(tenantId: string): Promise<VendorCategoryOption[]> {
    const active = await this.list(tenantId);
    return active.map((c) => ({
      key: c.categoryKey,
      displayName: c.displayName,
      slaHours: c.slaHours,
      requiredDocuments: c.requiredDocuments,
      optionalDocuments: c.optionalDocuments,
    }));
  }

  /**
   * The category a vendor is filed under — retired ones included. A vendor
   * invited under "Chemicals" keeps its document expectations after the admin
   * stops offering it; falls back to the shipped config for a key that predates
   * this table.
   */
  async find(tenantId: string, categoryKey: string): Promise<VendorCategory | undefined> {
    const row = (await this.rows(tenantId)).find((r) => r.categoryKey === categoryKey);
    if (row) return toView(row);
    const shipped = VENDOR_CATEGORY_CONFIGS.find((c) => c.categoryKey === categoryKey);
    return shipped ? { id: shipped.categoryKey, isActive: false, ...shipped } : undefined;
  }

  /** For starting an onboarding: the category must be one the tenant currently
   *  offers, not merely one it once did. */
  async findActive(
    tenantId: string,
    categoryKey: string,
  ): Promise<VendorCategory | undefined> {
    const row = (await this.rows(tenantId)).find(
      (r) => r.categoryKey === categoryKey && r.isActive,
    );
    return row ? toView(row) : undefined;
  }

  async create(
    tenantId: string,
    input: VendorCategoryCreateInput,
    actorId: string,
  ): Promise<VendorCategory> {
    const categoryKey = vendorCategoryKey(input.displayName);
    if (!categoryKey) {
      throw new BadRequestException('Give the category a name with letters or digits.');
    }

    const clash = (await this.rows(tenantId)).find((r) => r.categoryKey === categoryKey);
    if (clash) {
      throw new BadRequestException(
        clash.isActive
          ? clash.displayName + ' already exists.'
          : clash.displayName + ' exists but is retired — restore it instead.',
      );
    }

    const row = (await this.prisma.client.vendorCategoryConfig.create({
      data: {
        id: newId('vendorCategoryConfig'),
        tenantId,
        categoryKey,
        displayName: input.displayName,
        description: input.description ?? null,
        requiredDocuments:
          input.requiredDocuments ?? NEW_CATEGORY_DEFAULTS.requiredDocuments,
        optionalDocuments:
          input.optionalDocuments ?? NEW_CATEGORY_DEFAULTS.optionalDocuments,
        requiredScreenings: NEW_CATEGORY_DEFAULTS.requiredScreenings,
        requiredCertifications: NEW_CATEGORY_DEFAULTS.requiredCertifications,
        approvalMatrixName: NEW_CATEGORY_DEFAULTS.approvalMatrixName,
        slaHours: input.slaHours ?? NEW_CATEGORY_DEFAULTS.slaHours,
      },
    })) as CategoryRow;

    await this.audit.record({
      action: 'settings.vendor_category_created',
      entityType: 'VendorCategoryConfig',
      entityId: row.id,
      actorId,
      after: { key: categoryKey, displayName: input.displayName },
    });
    return toView(row);
  }

  async update(
    tenantId: string,
    id: string,
    input: VendorCategoryUpdateInput,
    actorId: string,
  ): Promise<VendorCategory> {
    const existing = (await this.prisma.client.vendorCategoryConfig.findFirst({
      where: { id, tenantId },
    })) as CategoryRow | null;
    if (!existing) throw new NotFoundException('Vendor category not found');

    if (input.isActive === false) await this.assertNotLastActive(tenantId, id);

    const row = (await this.prisma.client.vendorCategoryConfig.update({
      where: { id },
      data: {
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.description !== undefined
          ? { description: input.description ?? null }
          : {}),
        ...(input.slaHours !== undefined ? { slaHours: input.slaHours } : {}),
        ...(input.requiredDocuments !== undefined
          ? { requiredDocuments: input.requiredDocuments }
          : {}),
        ...(input.optionalDocuments !== undefined
          ? { optionalDocuments: input.optionalDocuments }
          : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    })) as CategoryRow;

    await this.audit.record({
      action: 'settings.vendor_category_updated',
      entityType: 'VendorCategoryConfig',
      entityId: id,
      actorId,
      before: toView(existing),
      after: toView(row),
    });
    return toView(row);
  }

  /**
   * The tenant's rows, seeding the shipped starter set the first time anyone
   * asks. A tenant that never ran the Slice 7 seed would otherwise open an
   * empty dropdown, which is worse than opening the wrong defaults.
   */
  private async rows(tenantId: string): Promise<CategoryRow[]> {
    const found = await this.read(tenantId);
    if (found.length > 0) return found;

    await this.prisma.client.vendorCategoryConfig.createMany({
      data: VENDOR_CATEGORY_CONFIGS.map((c) => ({
        id: newId('vendorCategoryConfig'),
        tenantId,
        categoryKey: c.categoryKey,
        displayName: c.displayName,
        description: c.description,
        requiredDocuments: c.requiredDocuments,
        optionalDocuments: c.optionalDocuments,
        requiredScreenings: c.requiredScreenings,
        requiredCertifications: c.requiredCertifications,
        approvalMatrixName: c.approvalMatrixName,
        slaHours: c.slaHours,
      })),
      skipDuplicates: true,
    });
    return this.read(tenantId);
  }

  private async read(tenantId: string): Promise<CategoryRow[]> {
    return (await this.prisma.client.vendorCategoryConfig.findMany({
      where: { tenantId },
      orderBy: [{ isActive: 'desc' }, { displayName: 'asc' }],
    })) as CategoryRow[];
  }

  /** A tenant with no active category cannot invite anyone — the dropdown would
   *  be empty and every invite would fail validation. */
  private async assertNotLastActive(tenantId: string, id: string): Promise<void> {
    const others = await this.prisma.client.vendorCategoryConfig.count({
      where: { tenantId, isActive: true, id: { not: id } },
    });
    if (others === 0) {
      throw new BadRequestException(
        'Keep at least one active category — every vendor is filed under one when invited.',
      );
    }
  }
}
