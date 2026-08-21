import { Injectable } from '@nestjs/common';
import { newId } from '@procureflow/db';
import type {
  BoxContentLine,
  BoxCreateInput,
  BoxDetailResponse,
  BoxListItem,
  BoxListQuery,
  LocationKind,
  ProductLocationRow,
  ProductWhereResponse,
} from '@procureflow/shared';

import { AuditLogService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ProductService } from '../product.service';
import { BoxNotFoundError, BoxValidationError } from './box.errors';
import { LocationPathService } from './location-path.service';

/** Raw contents row as Postgres returns it. */
interface ContentsRow {
  product_id: string;
  batch_number: string | null;
  expiry_date: Date | null;
  qty: bigint;
}

/**
 * BoxService (Slice 14) — the box register and the two lookups the warehouse
 * actually asks for.
 *
 * Contents are **derived**, never stored. "What is in box B" is
 * `SUM(qty * direction)` over the ledger rows carrying that box id, grouped by
 * product and batch — the identical rule behind every other quantity in this
 * module. A BoxContent table with its own quantity column would be a second
 * source of truth, and the first time anything wrote to one and not the other
 * the two would disagree with no way to tell which was right.
 */
@Injectable()
export class BoxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paths: LocationPathService,
    private readonly products: ProductService,
    private readonly audit: AuditLogService,
  ) {}

  // ── register ───────────────────────────────────────────────────────────────

  /**
   * Register a box. The barcode may be supplied (pre-printed labels) or
   * allocated by the server (labels printed on demand); either way it is
   * required on the row, because a box that cannot be scanned is invisible to
   * every other operation here.
   */
  async create(input: BoxCreateInput, actorId: string): Promise<BoxDetailResponse> {
    const sequence = (await this.prisma.client.box.count()) + 1;
    const code = `BOX-${String(sequence).padStart(6, '0')}`;
    const barcode = input.barcode?.trim() || code;

    const clash = await this.prisma.client.box.findFirst({
      where: { barcode },
      select: { id: true, code: true },
    });
    if (clash) {
      throw new BoxValidationError(
        `Barcode "${barcode}" is already on box ${clash.code}.`,
        {
          barcode,
          boxId: clash.id,
        },
      );
    }

    if (input.locationId) await this.requireLocation(input.locationId);

    const id = newId('box');
    await this.prisma.client.box.create({
      data: {
        id,
        tenantId: this.tenantId(),
        code,
        barcode,
        locationId: input.locationId ?? null,
        notes: input.notes ?? null,
        createdById: actorId,
      },
    });

    // The first placement is a move like any other, so the box's history starts
    // where it physically started rather than with a gap.
    if (input.locationId) {
      await this.prisma.client.boxMove.create({
        data: {
          id: newId('boxMove'),
          tenantId: this.tenantId(),
          boxId: id,
          fromLocationId: null,
          toLocationId: input.locationId,
          entriesPosted: 0,
          movedById: actorId,
        },
      });
    }

    await this.audit.record({
      action: 'BOX_CREATED',
      entityType: 'Box',
      entityId: id,
      actorId,
      after: { code, barcode, locationId: input.locationId ?? null },
    });

    return this.detail(id);
  }

  // ── lookups ────────────────────────────────────────────────────────────────

  /** Resolve a scanned box label. Falls back to the box code for manual entry. */
  async resolveByBarcode(raw: string): Promise<{ id: string }> {
    const value = raw.trim();
    const box = await this.prisma.client.box.findFirst({
      where: { active: true, OR: [{ barcode: value }, { code: value }] },
      select: { id: true },
    });
    if (!box) throw new BoxNotFoundError(value);
    return box;
  }

  /** Scan a box → everything the operator needs to see. */
  async detail(boxId: string): Promise<BoxDetailResponse> {
    const box = await this.prisma.client.box.findFirst({
      where: { id: boxId },
      select: {
        id: true,
        code: true,
        barcode: true,
        active: true,
        notes: true,
        locationId: true,
        location: { select: { id: true, name: true, kind: true } },
      },
    });
    if (!box) throw new BoxNotFoundError(boxId);

    const contents = await this.contents(boxId);
    const lastMove = await this.prisma.client.boxMove.findFirst({
      where: { boxId },
      orderBy: { movedAt: 'desc' },
      select: { movedAt: true },
    });

    return {
      id: box.id,
      code: box.code,
      barcode: box.barcode,
      active: box.active,
      notes: box.notes,
      location: box.location
        ? {
            id: box.location.id,
            name: box.location.name,
            kind: box.location.kind as LocationKind,
            path: await this.paths.pathFor(box.location.id),
          }
        : null,
      contents,
      totalQty: contents.reduce((sum, c) => sum + c.qty, 0),
      distinctProducts: new Set(contents.map((c) => c.productId)).size,
      lastMovedAt: lastMove ? lastMove.movedAt.toISOString() : null,
    };
  }

  /** Contents of a box, derived from the ledger. Empty batches drop out. */
  async contents(boxId: string, now: Date = new Date()): Promise<BoxContentLine[]> {
    const rows = await this.prisma.client.$queryRaw<ContentsRow[]>`
      SELECT "product_id", "batch_number", "expiry_date",
             COALESCE(SUM("qty" * "direction"), 0)::bigint AS qty
      FROM "StockLedgerEntry"
      WHERE "box_id" = ${boxId}
      GROUP BY "product_id", "batch_number", "expiry_date"
      HAVING COALESCE(SUM("qty" * "direction"), 0) > 0
      ORDER BY "expiry_date" ASC NULLS LAST
    `;
    if (rows.length === 0) return [];

    const products = await this.prisma.client.product.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.product_id))] } },
      select: { id: true, code: true, name: true, barcode: true },
    });
    const byId = new Map(products.map((p) => [p.id, p]));

    return rows.map((r) => {
      const product = byId.get(r.product_id);
      return {
        productId: r.product_id,
        productCode: product?.code ?? '',
        productName: product?.name ?? '',
        barcode: product?.barcode ?? null,
        batchNumber: r.batch_number,
        expiryDate: r.expiry_date ? r.expiry_date.toISOString() : null,
        qty: Number(r.qty),
        // Surfaced rather than filtered: expired stock is physically in the box
        // and the person looking at it needs to know that, not be shown a
        // shorter list that quietly disagrees with the carton in front of them.
        expired: r.expiry_date ? r.expiry_date.getTime() <= now.getTime() : false,
      };
    });
  }

  /** Box list, optionally narrowed to a location or to boxes holding a product. */
  async list(query: BoxListQuery): Promise<{ items: BoxListItem[] }> {
    const boxes = await this.prisma.client.box.findMany({
      where: {
        ...(query.active === null || query.active === undefined
          ? {}
          : { active: query.active }),
        ...(query.locationId ? { locationId: query.locationId } : {}),
        ...(query.q
          ? {
              OR: [
                { code: { contains: query.q, mode: 'insensitive' as const } },
                { barcode: { contains: query.q, mode: 'insensitive' as const } },
              ],
            }
          : {}),
        ...(query.productId
          ? { ledgerEntries: { some: { productId: query.productId } } }
          : {}),
      },
      select: {
        id: true,
        code: true,
        barcode: true,
        location: { select: { name: true } },
      },
      take: query.limit,
      orderBy: { code: 'asc' },
    });

    const items: BoxListItem[] = [];
    for (const box of boxes) {
      const contents = await this.contents(box.id);
      // `ledgerEntries.some` matches a box that once held the product; the
      // derived contents say whether it still does. Filtering here keeps the
      // reverse lookup honest about the present.
      if (query.productId && !contents.some((c) => c.productId === query.productId))
        continue;

      items.push({
        id: box.id,
        code: box.code,
        barcode: box.barcode,
        locationName: box.location?.name ?? null,
        totalQty: contents.reduce((s, c) => s + c.qty, 0),
        distinctProducts: new Set(contents.map((c) => c.productId)).size,
      });
    }
    return { items };
  }

  // ── reverse lookup ─────────────────────────────────────────────────────────

  /**
   * "Where exactly is this product physically stored?"
   *
   * Every place the product sits — boxed or loose — with the full
   * warehouse → rack → section → box path and the quantity there. Derived
   * entirely from the ledger, so it cannot disagree with the stock figures
   * shown anywhere else in the module.
   */
  async whereIs(productId: string): Promise<ProductWhereResponse> {
    const product = await this.products.require(productId);

    const rows = await this.prisma.client.$queryRaw<
      {
        location_id: string;
        box_id: string | null;
        batch_number: string | null;
        expiry_date: Date | null;
        qty: bigint;
      }[]
    >`
      SELECT "location_id", "box_id", "batch_number", "expiry_date",
             COALESCE(SUM("qty" * "direction"), 0)::bigint AS qty
      FROM "StockLedgerEntry"
      WHERE "product_id" = ${productId}
      GROUP BY "location_id", "box_id", "batch_number", "expiry_date"
      HAVING COALESCE(SUM("qty" * "direction"), 0) > 0
      ORDER BY "expiry_date" ASC NULLS LAST
    `;

    const paths = await this.paths.pathsFor(rows.map((r) => r.location_id));
    const boxIds = [
      ...new Set(rows.map((r) => r.box_id).filter((b): b is string => !!b)),
    ];
    const boxes = boxIds.length
      ? await this.prisma.client.box.findMany({
          where: { id: { in: boxIds } },
          select: { id: true, code: true, barcode: true },
        })
      : [];
    const boxById = new Map(boxes.map((b) => [b.id, b]));

    const out: ProductLocationRow[] = rows.map((r) => ({
      locationId: r.location_id,
      path: paths.get(r.location_id) ?? {
        warehouse: null,
        rack: null,
        section: null,
        full: [],
      },
      box: r.box_id ? (boxById.get(r.box_id) ?? null) : null,
      batchNumber: r.batch_number,
      expiryDate: r.expiry_date ? r.expiry_date.toISOString() : null,
      qty: Number(r.qty),
    }));

    return {
      product: {
        id: product.id,
        code: product.code,
        name: product.name,
        barcode: product.barcode,
      },
      totalQty: out.reduce((sum, r) => sum + r.qty, 0),
      rows: out,
    };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async requireLocation(locationId: string): Promise<void> {
    const found = await this.prisma.client.location.findFirst({
      where: { id: locationId },
      select: { id: true },
    });
    if (!found) {
      throw new BoxValidationError(`Location ${locationId} does not exist.`, {
        locationId,
      });
    }
  }

  private tenantId(): string {
    const tid = this.prisma.currentTenantId;
    if (!tid) throw new Error('No tenant context');
    return tid;
  }
}
