import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, newId } from '@procureflow/db';
import {
  convertQty,
  type ItemCreateInput,
  type ItemDetailResponse,
  type ItemListItem,
  type ItemListQuery,
  type ItemListResponse,
  type ItemUpdateInput,
  type ItemVendorPricingView,
} from '@procureflow/shared';
import Decimal from 'decimal.js';

import { AuditLogService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { DuplicateSkuError } from './item.errors';

function isUniqueViolationOn(err: unknown, column: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
    return false;
  }
  const target = err.meta?.target;
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? '')];
  return fields.some((f) => f.includes(column));
}

/**
 * ItemService (Slice 4). The item master backs PR line autocomplete: search,
 * vendor pricing, and a pure UOM converter. Items are never deleted (historical
 * PR/PO line snapshots must survive); deactivation is a status flip.
 */
@Injectable()
export class ItemService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /** Text search on sku/name/description with category + active + preferred filters. */
  async search(query: ItemListQuery): Promise<ItemListResponse> {
    const where: Prisma.ItemWhereInput = {};
    if (query.q) {
      where.OR = [
        { skuCode: { contains: query.q, mode: 'insensitive' } },
        { name: { contains: query.q, mode: 'insensitive' } },
        { description: { contains: query.q, mode: 'insensitive' } },
      ];
    }
    if (query.category) where.category = query.category;
    if (query.active !== null && query.active !== undefined)
      where.isActive = query.active;
    if (query.hasPreferredVendor) {
      where.vendorPricing = { some: { isPreferred: true } };
    }

    const rows = await this.prisma.client.item.findMany({
      where,
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      include: {
        vendorPricing: {
          where: { validTo: null },
          include: { vendor: { select: { id: true, name: true, isMsme: true } } },
        },
      },
    });
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const total = await this.prisma.client.item.count({ where });

    return {
      items: page.map((r) => this.toListItem(r)),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      totalEstimate: total,
    };
  }

  /** Item + all active vendor pricing, preferred-first then price-ascending. */
  async getWithVendorPricing(itemId: string): Promise<ItemDetailResponse> {
    const item = await this.prisma.client.item.findUnique({
      where: { id: itemId },
      include: {
        uomConversions: true,
        vendorPricing: {
          include: { vendor: { select: { id: true, name: true, isMsme: true } } },
        },
      },
    });
    if (!item) throw new NotFoundException('Item not found');

    const pricing: ItemVendorPricingView[] = item.vendorPricing
      .map((p) => ({
        id: p.id,
        vendorId: p.vendorId,
        vendorName: p.vendor.name,
        vendorIsMsme: p.vendor.isMsme,
        unitPrice: p.unitPrice.toString(),
        uom: p.uom,
        currency: p.currency,
        validFrom: p.validFrom.toISOString(),
        validTo: p.validTo?.toISOString() ?? null,
        isPreferred: p.isPreferred,
      }))
      .sort((a, b) => {
        if (a.isPreferred !== b.isPreferred) return a.isPreferred ? -1 : 1;
        return new Decimal(a.unitPrice).comparedTo(b.unitPrice);
      });

    return {
      ...this.toListItem(item),
      description: item.description,
      defaultGlAccount: item.defaultGlAccount,
      uomConversions: item.uomConversions.map((c) => ({
        fromUom: c.fromUom,
        toUom: c.toUom,
        factor: c.factor.toString(),
      })),
      vendorPricing: pricing,
    };
  }

  /** Pure quantity conversion using the item's configured UOM edges. */
  async convertQty(
    itemId: string,
    qty: string,
    fromUom: string,
    toUom: string,
  ): Promise<string> {
    const conversions = await this.prisma.client.itemUomConversion.findMany({
      where: { itemId },
      select: { fromUom: true, toUom: true, factor: true },
    });
    return convertQty(
      qty,
      fromUom,
      toUom,
      conversions.map((c) => ({
        fromUom: c.fromUom,
        toUom: c.toUom,
        factor: c.factor.toString(),
      })),
    );
  }

  async create(input: ItemCreateInput, actorId: string): Promise<{ id: string }> {
    // Checked up front so the common case gets a useful message; the P2002 catch
    // below still covers two buyers submitting the same code concurrently.
    const clash = await this.prisma.client.item.findFirst({
      where: { skuCode: input.skuCode },
      select: { id: true },
    });
    if (clash) throw new DuplicateSkuError(input.skuCode, clash.id);

    const id = newId('item');
    await this.createRow(id, input);
    await this.audit.record({
      action: 'ITEM_CREATED',
      entityType: 'Item',
      entityId: id,
      actorId,
      after: { skuCode: input.skuCode, name: input.name },
    });
    return { id };
  }

  private async createRow(id: string, input: ItemCreateInput): Promise<void> {
    try {
      await this.writeItem(id, input);
    } catch (err) {
      if (isUniqueViolationOn(err, 'sku_code')) {
        throw new DuplicateSkuError(input.skuCode);
      }
      throw err;
    }
  }

  private async writeItem(id: string, input: ItemCreateInput): Promise<void> {
    await this.prisma.client.item.create({
      data: {
        id,
        tenantId: this.tenantId(),
        skuCode: input.skuCode,
        name: input.name,
        description: input.description ?? null,
        category: input.category,
        subcategory: input.subcategory ?? null,
        hsnCode: input.hsnCode,
        gstRate: new Prisma.Decimal(input.gstRate),
        primaryUom: input.primaryUom,
        isCapex: input.isCapex,
        defaultGlAccount: input.defaultGlAccount ?? null,
        uomConversions: {
          create: input.uomConversions.map((c) => ({
            id: newId('itemUomConversion'),
            tenantId: this.tenantId(),
            fromUom: c.fromUom,
            toUom: c.toUom,
            factor: new Prisma.Decimal(c.factor),
          })),
        },
      },
    });
  }

  async update(
    itemId: string,
    input: ItemUpdateInput,
    actorId: string,
  ): Promise<{ ok: true }> {
    const before = await this.requireItem(itemId);
    await this.prisma.client.item.update({
      where: { id: itemId },
      data: {
        name: input.name ?? undefined,
        description: input.description ?? undefined,
        category: input.category ?? undefined,
        subcategory: input.subcategory ?? undefined,
        hsnCode: input.hsnCode ?? undefined,
        gstRate: input.gstRate ? new Prisma.Decimal(input.gstRate) : undefined,
        primaryUom: input.primaryUom ?? undefined,
        isCapex: input.isCapex ?? undefined,
        defaultGlAccount: input.defaultGlAccount ?? undefined,
      },
    });
    await this.audit.record({
      action: 'ITEM_UPDATED',
      entityType: 'Item',
      entityId: itemId,
      actorId,
      before: { name: before.name },
      after: { name: input.name ?? before.name },
    });
    return { ok: true };
  }

  async deactivate(itemId: string, actorId: string): Promise<{ ok: true }> {
    await this.requireItem(itemId);
    await this.prisma.client.item.update({
      where: { id: itemId },
      data: { isActive: false },
    });
    await this.audit.record({
      action: 'ITEM_DEACTIVATED',
      entityType: 'Item',
      entityId: itemId,
      actorId,
    });
    return { ok: true };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private toListItem(
    item: Prisma.ItemGetPayload<{
      include: {
        vendorPricing: {
          include: { vendor: { select: { id: true; name: true; isMsme: true } } };
        };
      };
    }>,
  ): ItemListItem {
    const active = item.vendorPricing.filter((p) => p.validTo === null);
    const preferred = active.find((p) => p.isPreferred) ?? null;
    const cheapest = [...active].sort((a, b) =>
      new Decimal(a.unitPrice.toString()).comparedTo(b.unitPrice.toString()),
    )[0];
    const lastPaid = preferred ?? cheapest ?? null;
    return {
      id: item.id,
      skuCode: item.skuCode,
      name: item.name,
      category: item.category,
      subcategory: item.subcategory,
      hsnCode: item.hsnCode,
      gstRate: item.gstRate.toString(),
      primaryUom: item.primaryUom,
      isActive: item.isActive,
      isCapex: item.isCapex,
      lastPaidPrice: lastPaid?.unitPrice.toString() ?? null,
      preferredVendor: preferred
        ? { id: preferred.vendor.id, name: preferred.vendor.name }
        : null,
    };
  }

  private async requireItem(itemId: string) {
    const item = await this.prisma.client.item.findUnique({ where: { id: itemId } });
    if (!item) throw new NotFoundException('Item not found');
    return item;
  }

  private tenantId(): string {
    const tid = this.prisma.currentTenantId;
    if (!tid) throw new Error('No tenant context');
    return tid;
  }
}
