import { Injectable, NotFoundException } from '@nestjs/common';
import { newId, type Location } from '@procureflow/db';
import type {
  LocationCreateInput,
  LocationListResponse,
  LocationUpdateInput,
  LocationView,
} from '@procureflow/shared';

import { AuditLogService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryValidationError } from './inventory.errors';

/**
 * LocationService (Slice 12). Physical storage locations, optionally nested
 * (room -> rack -> bin). Stock lives in several locations per SKU at once, which
 * is why the ledger carries a `locationId` rather than the product carrying a
 * single free-text `location` string as the legacy sheet did.
 */
@Injectable()
export class LocationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  async list(includeInactive = false): Promise<LocationListResponse> {
    const rows = await this.prisma.client.location.findMany({
      where: includeInactive ? {} : { active: true },
      orderBy: [{ name: 'asc' }, { rackNo: 'asc' }],
      include: { parent: { select: { name: true } } },
    });

    // One grouped pass rather than a count per location.
    const totals = await this.prisma.client.$queryRaw<
      { location_id: string; products: bigint; qty: bigint }[]
    >`
      SELECT "location_id",
             COUNT(DISTINCT "product_id")            AS products,
             COALESCE(SUM("qty" * "direction"), 0)::bigint AS qty
      FROM "StockLedgerEntry"
      GROUP BY "location_id"
    `;
    const byId = new Map(totals.map((t) => [t.location_id, t]));

    const items: LocationView[] = rows.map((r) => {
      const t = byId.get(r.id);
      return {
        id: r.id,
        name: r.name,
        rackNo: r.rackNo,
        parentId: r.parentId,
        parentName: r.parent?.name ?? null,
        barcode: r.barcode,
        kind: r.kind,
        active: r.active,
        productCount: Number(t?.products ?? 0),
        totalQty: Number(t?.qty ?? 0),
      };
    });
    return { items };
  }

  async create(input: LocationCreateInput, actorId: string): Promise<{ id: string }> {
    const name = input.name.trim();
    const rackNo = input.rackNo?.trim() || null;
    if (input.parentId) await this.require(input.parentId);
    await this.assertNoDuplicate(name, rackNo);
    await this.assertBarcodeFree(input.barcode?.trim() || null);

    const id = newId('location');
    await this.prisma.client.location.create({
      data: {
        id,
        tenantId: this.tenantId(),
        name,
        rackNo,
        parentId: input.parentId ?? null,
        barcode: input.barcode?.trim() || null,
        kind: input.kind ?? 'OTHER',
      },
    });
    await this.audit.record({
      action: 'INVENTORY_LOCATION_CREATED',
      entityType: 'Location',
      entityId: id,
      actorId,
      after: { name, rackNo, barcode: input.barcode?.trim() || null, kind: input.kind ?? 'OTHER' },
    });
    return { id };
  }

  async update(
    locationId: string,
    input: LocationUpdateInput,
    actorId: string,
  ): Promise<{ ok: true }> {
    const before = await this.require(locationId);
    const name = input.name?.trim() ?? before.name;
    const rackNo = input.rackNo === undefined ? before.rackNo : (input.rackNo?.trim() || null);

    if (name !== before.name || rackNo !== before.rackNo) {
      await this.assertNoDuplicate(name, rackNo, locationId);
    }
    if (input.parentId) {
      if (input.parentId === locationId) {
        throw new InventoryValidationError('A location cannot be its own parent.');
      }
      await this.require(input.parentId);
      await this.assertNoCycle(locationId, input.parentId);
    }
    if (input.barcode !== undefined) {
      await this.assertBarcodeFree(input.barcode?.trim() || null, locationId);
    }

    await this.prisma.client.location.update({
      where: { id: locationId },
      data: {
        name: input.name?.trim() ?? undefined,
        rackNo: input.rackNo === undefined ? undefined : rackNo,
        parentId: input.parentId === undefined ? undefined : (input.parentId ?? null),
        // Labelling an existing shelf is the common case: a tenant adopting the
        // scanner walks the racks sticking barcodes on locations that already
        // hold stock, so these must be editable, not create-only.
        barcode: input.barcode === undefined ? undefined : (input.barcode?.trim() || null),
        kind: input.kind ?? undefined,
        active: input.active ?? undefined,
      },
    });
    await this.audit.record({
      action: 'INVENTORY_LOCATION_UPDATED',
      entityType: 'Location',
      entityId: locationId,
      actorId,
      before: { name: before.name, rackNo: before.rackNo },
      after: { name, rackNo },
    });
    return { ok: true };
  }

  /**
   * Retire a location. Refused while it still holds stock — the remaining
   * quantity has to be moved or written off first, otherwise it would vanish
   * from every location breakdown while still counting toward product totals.
   */
  async deactivate(locationId: string, actorId: string): Promise<{ ok: true }> {
    await this.require(locationId);
    const rows = await this.prisma.client.$queryRaw<{ qty: bigint | null }[]>`
      SELECT COALESCE(SUM("qty" * "direction"), 0)::bigint AS qty
      FROM "StockLedgerEntry"
      WHERE "location_id" = ${locationId}
    `;
    const remaining = Number(rows[0]?.qty ?? 0);
    if (remaining !== 0) {
      throw new InventoryValidationError(
        `Location still holds ${remaining} units. Move or write off the stock before retiring it.`,
        { locationId, remaining },
      );
    }

    await this.prisma.client.location.update({
      where: { id: locationId },
      data: { active: false },
    });
    await this.audit.record({
      action: 'INVENTORY_LOCATION_DEACTIVATED',
      entityType: 'Location',
      entityId: locationId,
      actorId,
    });
    return { ok: true };
  }

  /**
   * Find a location by name (+ optional rack), creating it when missing. Used
   * by the bulk import pipeline: unlike products — where an unknown name is
   * quarantined for human confirmation — an unseen storage location is safe to
   * create, since it carries no catalogue meaning of its own.
   */
  async findOrCreate(name: string, rackNo?: string | null): Promise<Location> {
    const trimmedName = name.trim();
    const trimmedRack = rackNo?.trim() || null;
    if (!trimmedName) {
      throw new InventoryValidationError('Location name cannot be blank.');
    }

    const existing = await this.prisma.client.location.findFirst({
      where: {
        name: { equals: trimmedName, mode: 'insensitive' },
        rackNo: trimmedRack === null ? null : { equals: trimmedRack, mode: 'insensitive' },
      },
    });
    if (existing) return existing;

    return this.prisma.client.location.create({
      data: {
        id: newId('location'),
        tenantId: this.tenantId(),
        name: trimmedName,
        rackNo: trimmedRack,
      },
    });
  }

  async require(locationId: string): Promise<Location> {
    const location = await this.prisma.client.location.findUnique({
      where: { id: locationId },
    });
    if (!location) throw new NotFoundException('Location not found');
    return location;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * A shelf label points at exactly one location. Caught here rather than left
   * to the unique index, so a warehouse re-using a printed label gets told
   * which location already has it instead of a 500.
   */
  private async assertBarcodeFree(barcode: string | null, exceptId?: string): Promise<void> {
    if (!barcode) return;
    const clash = await this.prisma.client.location.findFirst({
      where: { barcode, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { name: true },
    });
    if (clash) {
      throw new InventoryValidationError(
        `Barcode "${barcode}" is already on location "${clash.name}".`,
        { barcode },
      );
    }
  }

  private async assertNoDuplicate(
    name: string,
    rackNo: string | null,
    excludeId?: string,
  ): Promise<void> {
    const existing = await this.prisma.client.location.findFirst({
      where: {
        name: { equals: name, mode: 'insensitive' },
        rackNo: rackNo === null ? null : { equals: rackNo, mode: 'insensitive' },
      },
    });
    if (existing && existing.id !== excludeId) {
      throw new InventoryValidationError(
        `A location named "${name}"${rackNo ? ` (${rackNo})` : ''} already exists.`,
        { conflictingLocationId: existing.id },
      );
    }
  }

  /** Walk up the proposed parent chain so nesting can never form a loop. */
  private async assertNoCycle(locationId: string, parentId: string): Promise<void> {
    const seen = new Set<string>([locationId]);
    let cursor: string | null = parentId;

    while (cursor) {
      if (seen.has(cursor)) {
        throw new InventoryValidationError(
          'That parent would create a cycle in the location hierarchy.',
        );
      }
      seen.add(cursor);
      const next: { parentId: string | null } | null =
        await this.prisma.client.location.findUnique({
          where: { id: cursor },
          select: { parentId: true },
        });
      cursor = next?.parentId ?? null;
    }
  }

  private tenantId(): string {
    const tid = this.prisma.currentTenantId;
    if (!tid) throw new Error('No tenant context');
    return tid;
  }
}
