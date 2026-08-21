import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, newId, type Product } from '@procureflow/db';
import {
  UNCATEGORIZED,
  categoryPrefix,
  formatProductCode,
  type ProductCreateInput,
  type ProductUpdateInput,
} from '@procureflow/shared';

import { AuditLogService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryValidationError } from './inventory.errors';

/** How many times to retry a code collision before giving up. */
const CODE_ALLOCATION_ATTEMPTS = 5;

/**
 * ProductService (Slice 12). The warehouse product catalogue.
 *
 * Products are never deleted — historical ledger rows must keep resolving — so
 * retirement is an `active` flip. Codes are always server-generated
 * ({PREFIX}-{000123}); the legacy `Product ID` / `SKU` columns are preserved
 * verbatim for audit but carry no meaning ("N/A" on all 625 migrated rows).
 */
@Injectable()
export class ProductService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  async create(
    input: ProductCreateInput,
    actorId: string,
    opts: { importBatchId?: string | null } = {},
  ): Promise<{ id: string; code: string }> {
    const category = this.normaliseCategory(input.category);
    const colour = this.normaliseColour(input.colour);

    await this.assertNoDuplicate(input.name, colour);
    await this.assertBarcodeFree(input.barcode?.trim() || null);
    if (input.itemId) await this.assertItemExists(input.itemId);

    const id = newId('product');
    const code = await this.allocateCode(category, async (candidate) => {
      await this.prisma.client.product.create({
        data: {
          id,
          tenantId: this.tenantId(),
          code: candidate,
          legacyProductId: input.legacyProductId ?? null,
          legacySku: input.legacySku ?? null,
          name: input.name.trim(),
          category,
          colour,
          barcode: input.barcode?.trim() || null,
          requiresBatchTracking: input.requiresBatchTracking ?? false,
          imageUrl: input.imageUrl ?? null,
          unit: input.unit || 'pcs',
          reorderPoint: input.reorderPoint ?? null,
          expiryOrWarrantyDate: input.expiryOrWarrantyDate
            ? new Date(input.expiryOrWarrantyDate)
            : null,
          remark: input.remark ?? null,
          itemId: input.itemId ?? null,
          createdFromImportBatchId: opts.importBatchId ?? null,
        },
      });
    });

    await this.audit.record({
      action: 'INVENTORY_PRODUCT_CREATED',
      entityType: 'Product',
      entityId: id,
      actorId,
      after: { code, name: input.name, category, colour },
    });
    return { id, code };
  }

  async update(
    productId: string,
    input: ProductUpdateInput,
    actorId: string,
  ): Promise<{ ok: true }> {
    const before = await this.require(productId);

    const name = input.name?.trim() ?? before.name;
    const colour =
      input.colour === undefined ? before.colour : this.normaliseColour(input.colour);
    if (name !== before.name || colour !== before.colour) {
      await this.assertNoDuplicate(name, colour, productId);
    }
    if (input.itemId) await this.assertItemExists(input.itemId);
    if (input.barcode !== undefined) {
      await this.assertBarcodeFree(input.barcode?.trim() || null, productId);
    }

    await this.prisma.client.product.update({
      where: { id: productId },
      data: {
        name: input.name?.trim() ?? undefined,
        // `category` is required going forward — an explicit blank becomes the
        // migration backfill value rather than silently clearing the column.
        category: input.category ? this.normaliseCategory(input.category) : undefined,
        colour: input.colour === undefined ? undefined : colour,
        // Barcodes are usually added *after* the catalogue exists — a tenant
        // adopting the scanner labels products it already sells.
        barcode: input.barcode === undefined ? undefined : (input.barcode?.trim() || null),
        requiresBatchTracking: input.requiresBatchTracking ?? undefined,
        imageUrl: input.imageUrl === undefined ? undefined : (input.imageUrl ?? null),
        unit: input.unit ?? undefined,
        reorderPoint:
          input.reorderPoint === undefined ? undefined : (input.reorderPoint ?? null),
        expiryOrWarrantyDate:
          input.expiryOrWarrantyDate === undefined
            ? undefined
            : input.expiryOrWarrantyDate
              ? new Date(input.expiryOrWarrantyDate)
              : null,
        remark: input.remark === undefined ? undefined : (input.remark ?? null),
        itemId: input.itemId === undefined ? undefined : (input.itemId ?? null),
        active: input.active ?? undefined,
        legacyProductId:
          input.legacyProductId === undefined ? undefined : (input.legacyProductId ?? null),
        legacySku: input.legacySku === undefined ? undefined : (input.legacySku ?? null),
      },
    });

    await this.audit.record({
      action: 'INVENTORY_PRODUCT_UPDATED',
      entityType: 'Product',
      entityId: productId,
      actorId,
      before: { name: before.name, category: before.category, colour: before.colour },
      after: { name, category: input.category ?? before.category, colour },
    });
    return { ok: true };
  }

  /** Retire a product. Never a delete — ledger history must keep resolving. */
  async deactivate(productId: string, actorId: string): Promise<{ ok: true }> {
    await this.require(productId);
    await this.prisma.client.product.update({
      where: { id: productId },
      data: { active: false },
    });
    await this.audit.record({
      action: 'INVENTORY_PRODUCT_DEACTIVATED',
      entityType: 'Product',
      entityId: productId,
      actorId,
    });
    return { ok: true };
  }

  /**
   * Resolve a product by the legacy sheet's matching key. Used by the bulk
   * import pipeline, which must never auto-create on a miss (business rule:
   * unmatched names go to the quarantine queue instead).
   */
  async findByNameAndColour(name: string, colour?: string | null): Promise<Product | null> {
    const normalised = this.normaliseColour(colour);
    return this.prisma.client.product.findFirst({
      where: {
        name: { equals: name.trim(), mode: 'insensitive' },
        colour: normalised === null ? null : { equals: normalised, mode: 'insensitive' },
      },
    });
  }

  async findByCode(code: string): Promise<Product | null> {
    return this.prisma.client.product.findFirst({
      where: { code: { equals: code.trim(), mode: 'insensitive' } },
    });
  }

  async require(productId: string): Promise<Product> {
    const product = await this.prisma.client.product.findUnique({
      where: { id: productId },
    });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * A barcode resolves to exactly one product, so the scanner can never be
   * ambiguous about what was just scanned. Reported as a validation error
   * naming the other product rather than left to the unique index.
   */
  private async assertBarcodeFree(barcode: string | null, exceptId?: string): Promise<void> {
    if (!barcode) return;
    const clash = await this.prisma.client.product.findFirst({
      where: { barcode, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { code: true, name: true },
    });
    if (clash) {
      throw new InventoryValidationError(
        `Barcode "${barcode}" is already on ${clash.code} — ${clash.name}.`,
        { barcode },
      );
    }
  }

  /** Legacy nulls become "Uncategorized" — category is required going forward. */
  private normaliseCategory(category: string | null | undefined): string {
    const trimmed = (category ?? '').trim();
    if (!trimmed || trimmed.toUpperCase() === 'N/A') return UNCATEGORIZED;
    return trimmed;
  }

  /**
   * Blank and "N/A" colours collapse to NULL so `(name, colour)` stays a single
   * well-defined matching key — 533 of the 625 legacy rows have no colour, and
   * a mix of '' and NULL would split the same product into two.
   */
  private normaliseColour(colour: string | null | undefined): string | null {
    const trimmed = (colour ?? '').trim();
    if (!trimmed || trimmed.toUpperCase() === 'N/A') return null;
    return trimmed;
  }

  private async assertNoDuplicate(
    name: string,
    colour: string | null,
    excludeId?: string,
  ): Promise<void> {
    const existing = await this.findByNameAndColour(name, colour);
    if (existing && existing.id !== excludeId) {
      throw new InventoryValidationError(
        `A product named "${name.trim()}"${colour ? ` in ${colour}` : ''} already exists (${existing.code}).`,
        { conflictingProductId: existing.id, code: existing.code },
      );
    }
  }

  private async assertItemExists(itemId: string): Promise<void> {
    const item = await this.prisma.client.item.findUnique({
      where: { id: itemId },
      select: { id: true },
    });
    if (!item) {
      throw new InventoryValidationError(
        `Item ${itemId} does not exist in the procurement item master.`,
      );
    }
  }

  /**
   * Allocate the next `{PREFIX}-{000123}` code for a category and run `write`
   * with it. Sequences are per (tenant, prefix): the max existing suffix plus
   * one. Two concurrent creates in the same category can race for the same
   * number, so a unique-violation is retried with a freshly read sequence
   * rather than pre-reserved — collisions are rare and the retry is cheap.
   */
  private async allocateCode(
    category: string,
    write: (code: string) => Promise<void>,
  ): Promise<string> {
    const prefix = categoryPrefix(category);

    for (let attempt = 0; attempt < CODE_ALLOCATION_ATTEMPTS; attempt += 1) {
      const code = formatProductCode(prefix, (await this.maxSequence(prefix)) + 1 + attempt);
      try {
        await write(code);
        return code;
      } catch (err) {
        if (this.isUniqueViolationOn(err, 'code')) continue;
        throw err;
      }
    }
    throw new InventoryValidationError(
      `Could not allocate a unique product code for "${category}" after ${CODE_ALLOCATION_ATTEMPTS} attempts.`,
    );
  }

  /** Highest numeric suffix currently issued under a prefix, or 0 if none. */
  private async maxSequence(prefix: string): Promise<number> {
    const rows = await this.prisma.client.$queryRaw<{ max: number | null }[]>`
      SELECT MAX(NULLIF(regexp_replace("code", '^.*-', ''), '')::int) AS max
      FROM "Product"
      WHERE "code" LIKE ${`${prefix}-%`}
        AND "code" ~ ${`^${prefix}-[0-9]+$`}
    `;
    return rows[0]?.max ?? 0;
  }

  private isUniqueViolationOn(err: unknown, field: string): boolean {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
      return false;
    }
    const target = err.meta?.target;
    const fields = Array.isArray(target) ? target.map(String) : [String(target ?? '')];
    return fields.some((f) => f.includes(field));
  }

  private tenantId(): string {
    const tid = this.prisma.currentTenantId;
    if (!tid) throw new Error('No tenant context');
    return tid;
  }
}
