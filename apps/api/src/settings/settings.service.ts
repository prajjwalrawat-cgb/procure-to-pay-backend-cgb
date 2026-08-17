import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { newId } from '@procureflow/db';
import type {
  Branch,
  BranchInput,
  OrganisationSettings,
  OrganisationUpdateInput,
} from '@procureflow/shared';

import { AuditLogService } from '../audit/audit.service';
import { StorageService } from '../common/storage/storage.service';
import { PrismaService } from '../prisma/prisma.service';

/** Letterhead logos live at a deterministic key, so no schema column is needed
 *  to find one — the PO renderer looks for exactly this object. */
export function tenantLogoKey(tenantId: string): string {
  return `tenants/${tenantId}/logo`;
}

const LOGO_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg']);

/**
 * Organisation settings (Slice 11). The tenant's own identity — name, GSTIN,
 * GST registrations and letterhead logo — is data an admin maintains here
 * rather than a constant baked into screens and documents.
 */
@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly storage: StorageService,
  ) {}

  async get(tenantId: string): Promise<OrganisationSettings> {
    const tenant = await this.prisma.client.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true, pan: true, currency: true },
    });
    if (!tenant) throw new NotFoundException('Organisation not found');

    return {
      tenant,
      branches: await this.listBranches(tenantId),
      logoUrl: await this.logoUrl(tenantId),
    };
  }

  async listBranches(tenantId: string): Promise<Branch[]> {
    return this.prisma.client.plant.findMany({
      where: { tenantId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        name: true,
        address: true,
        stateCode: true,
        gstin: true,
        isDefault: true,
      },
    });
  }

  async update(
    tenantId: string,
    input: OrganisationUpdateInput,
    actorId: string,
  ): Promise<OrganisationSettings> {
    const before = await this.get(tenantId);

    if (input.name !== undefined || input.pan !== undefined || input.currency) {
      await this.prisma.client.tenant.update({
        where: { id: tenantId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.pan !== undefined ? { pan: input.pan ?? null } : {}),
          ...(input.currency ? { currency: input.currency } : {}),
        },
      });
      await this.audit.record({
        action: 'settings.organisation_updated',
        entityType: 'Tenant',
        entityId: tenantId,
        actorId,
        before: before.tenant,
        after: (await this.get(tenantId)).tenant,
      });
    }

    return this.get(tenantId);
  }

  async createBranch(
    tenantId: string,
    input: BranchInput,
    actorId: string,
  ): Promise<Branch[]> {
    const existing = await this.prisma.client.plant.count({ where: { tenantId } });
    // The first registration is the default whether or not it was asked for —
    // otherwise a tenant could end up with no fallback at all.
    const isDefault = input.isDefault === true || existing === 0;

    const id = newId('plant');
    if (isDefault) await this.clearDefault(tenantId);
    await this.prisma.client.plant.create({
      data: {
        id,
        tenantId,
        name: input.name,
        address: input.address ?? null,
        stateCode: input.stateCode,
        gstin: input.gstin ?? null,
        isDefault,
      },
    });
    await this.audit.record({
      action: 'settings.branch_created',
      entityType: 'Plant',
      entityId: id,
      actorId,
      after: { ...input, isDefault },
    });
    return this.listBranches(tenantId);
  }

  async updateBranch(
    tenantId: string,
    branchId: string,
    input: BranchInput,
    actorId: string,
  ): Promise<Branch[]> {
    const branch = await this.findBranch(tenantId, branchId);

    if (input.isDefault === true) await this.clearDefault(tenantId);
    await this.prisma.client.plant.update({
      where: { id: branchId },
      data: {
        name: input.name,
        address: input.address ?? null,
        stateCode: input.stateCode,
        gstin: input.gstin ?? null,
        // A tenant always needs one default: this branch may be promoted, but
        // it cannot demote itself while it is the only one holding the flag.
        ...(input.isDefault === true ? { isDefault: true } : {}),
      },
    });
    await this.audit.record({
      action: 'settings.branch_updated',
      entityType: 'Plant',
      entityId: branchId,
      actorId,
      before: branch,
      after: input,
    });
    return this.listBranches(tenantId);
  }

  /** Promotes one registration to the tenant's default. */
  async setDefaultBranch(
    tenantId: string,
    branchId: string,
    actorId: string,
  ): Promise<Branch[]> {
    await this.findBranch(tenantId, branchId);
    await this.clearDefault(tenantId);
    await this.prisma.client.plant.update({
      where: { id: branchId },
      data: { isDefault: true },
    });
    await this.audit.record({
      action: 'settings.branch_default_changed',
      entityType: 'Plant',
      entityId: branchId,
      actorId,
      after: { isDefault: true },
    });
    return this.listBranches(tenantId);
  }

  async setLogo(
    tenantId: string,
    file: { buffer: Buffer; mimetype: string },
    actorId: string,
  ): Promise<OrganisationSettings> {
    if (!LOGO_MIME.has(file.mimetype)) {
      throw new BadRequestException('The logo must be a PNG or JPEG image.');
    }
    await this.storage.put(tenantLogoKey(tenantId), file.buffer, file.mimetype);
    await this.audit.record({
      action: 'settings.logo_updated',
      entityType: 'Tenant',
      entityId: tenantId,
      actorId,
      after: { mimeType: file.mimetype, sizeBytes: file.buffer.length },
    });
    return this.get(tenantId);
  }

  private async findBranch(tenantId: string, branchId: string): Promise<Branch> {
    const branch = await this.prisma.client.plant.findFirst({
      where: { id: branchId, tenantId },
      select: {
        id: true,
        name: true,
        address: true,
        stateCode: true,
        gstin: true,
        isDefault: true,
      },
    });
    if (!branch) throw new NotFoundException('Branch not found');
    return branch;
  }

  private async clearDefault(tenantId: string): Promise<void> {
    await this.prisma.client.plant.updateMany({
      where: { tenantId, isDefault: true },
      data: { isDefault: false },
    });
  }

  /** Presigned only when an object actually exists, so the UI can tell
   *  "no logo yet" from "logo that failed to load". */
  private async logoUrl(tenantId: string): Promise<string | null> {
    const key = tenantLogoKey(tenantId);
    if (!(await this.storage.exists(key))) return null;
    return this.storage.presignedGetUrl(key);
  }
}
