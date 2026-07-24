import { Injectable } from '@nestjs/common';
import { Prisma, newId } from '@procureflow/db';
import {
  DOMAIN_EVENTS,
  type StockBalanceView,
  type StockMovementsQuery,
  type StockMovementsResponse,
} from '@procureflow/shared';
import Decimal from 'decimal.js';

import { DomainEventService } from '../common/events/domain-event.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  InventoryValuationService,
  type StockBalance,
} from './inventory-valuation.service';

export interface StockMovementInput {
  itemId: string | null;
  itemDesc: string;
  costCenterId: string | null;
  plantId: string | null;
  movementType: 'GRN_RECEIPT' | 'RMA_ISSUE' | 'ADJUSTMENT' | 'CONSUMPTION';
  sourceType: string;
  sourceId: string;
  qtyDelta: Decimal.Value;
  unitLandedCost: Decimal.Value;
  actorId: string;
}

/**
 * StockLedgerService (Slice 5). Append-only inventory movement ledger — NOT a
 * WMS (ADR-014). Each movement snapshots the running balance/value using the
 * tenant's valuation method (weighted-average default, FIFO optional).
 */
@Injectable()
export class StockLedgerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly valuation: InventoryValuationService,
    private readonly events: DomainEventService,
  ) {}

  /**
   * Record one movement. The request handler already runs inside a transaction
   * (PrismaService.runInTenantContext), so sequential calls during a GRN post /
   * reverse are atomic and each sees the prior movement's balance. Returns the
   * created ledger id.
   */
  async record(input: StockMovementInput): Promise<string> {
    const method = await this.valuationMethod();
    const prior = await this.currentBalance(input.itemId, input.plantId);
    const next = this.valuation.updateBalance(
      prior,
      input.qtyDelta,
      input.unitLandedCost,
      method,
    );

    const id = newId('stockLedger');
    await this.prisma.client.stockLedger.create({
      data: {
        id,
        tenantId: this.tenantId(),
        itemId: input.itemId,
        itemDesc: input.itemDesc,
        costCenterId: input.costCenterId,
        plantId: input.plantId,
        movementType: input.movementType,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        qtyDelta: new Prisma.Decimal(new Decimal(input.qtyDelta).toFixed(4)),
        unitLandedCost: new Prisma.Decimal(new Decimal(input.unitLandedCost).toFixed(4)),
        balanceQtyAfter: new Prisma.Decimal(next.qty.toFixed(4)),
        balanceValueAfter: new Prisma.Decimal(next.value.toFixed(4)),
        recordedBy: input.actorId,
      },
    });
    await this.events.emit(DOMAIN_EVENTS.STOCK_MOVEMENT_RECORDED, {
      stockLedgerId: id,
      itemId: input.itemId,
      movementType: input.movementType,
      qtyDelta: new Decimal(input.qtyDelta).toFixed(4),
      sourceType: input.sourceType,
      sourceId: input.sourceId,
    });
    return id;
  }

  /** Current on-hand balance for an item (optionally scoped to a plant). */
  async getBalance(itemId: string, plantId?: string): Promise<StockBalanceView> {
    const balance = await this.currentBalance(itemId, plantId ?? null);
    const method = await this.valuationMethod();
    const last = await this.prisma.client.stockLedger.findFirst({
      where: { itemId, ...(plantId ? { plantId } : {}) },
      orderBy: { recordedAt: 'desc' },
    });
    return {
      itemId,
      itemDesc: last?.itemDesc ?? '—',
      plantId: plantId ?? null,
      balanceQty: balance.qty.toFixed(4),
      unitCost: this.valuation.averageCost(balance).toFixed(4),
      balanceValue: balance.value.toFixed(4),
      valuationMethod: method,
    };
  }

  async getMovements(query: StockMovementsQuery): Promise<StockMovementsResponse> {
    const where: Prisma.StockLedgerWhereInput = {};
    if (query.itemId) where.itemId = query.itemId;
    if (query.plantId) where.plantId = query.plantId;
    if (query.movementType) where.movementType = query.movementType;
    if (query.from || query.to) {
      where.recordedAt = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }
    const rows = await this.prisma.client.stockLedger.findMany({
      where,
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
    });
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      items: page.map((r) => ({
        id: r.id,
        itemId: r.itemId,
        itemDesc: r.itemDesc,
        movementType: r.movementType,
        sourceType: r.sourceType,
        sourceId: r.sourceId,
        qtyDelta: r.qtyDelta.toString(),
        unitLandedCost: r.unitLandedCost.toString(),
        balanceQtyAfter: r.balanceQtyAfter.toString(),
        balanceValueAfter: r.balanceValueAfter.toString(),
        recordedAt: r.recordedAt.toISOString(),
        recordedBy: r.recordedBy,
      })),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      totalEstimate: await this.prisma.client.stockLedger.count({ where }),
    };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async currentBalance(
    itemId: string | null,
    plantId: string | null,
  ): Promise<StockBalance> {
    if (!itemId) return { qty: new Decimal(0), value: new Decimal(0) };
    const last = await this.prisma.client.stockLedger.findFirst({
      where: { itemId, ...(plantId ? { plantId } : {}) },
      orderBy: { recordedAt: 'desc' },
    });
    if (!last) return { qty: new Decimal(0), value: new Decimal(0) };
    return {
      qty: new Decimal(last.balanceQtyAfter.toString()),
      value: new Decimal(last.balanceValueAfter.toString()),
    };
  }

  private async valuationMethod(): Promise<'WEIGHTED_AVERAGE' | 'FIFO'> {
    const tenant = await this.prisma.client.tenant.findUnique({
      where: { id: this.tenantId() },
      select: { inventoryValuationMethod: true },
    });
    return tenant?.inventoryValuationMethod ?? 'WEIGHTED_AVERAGE';
  }

  private tenantId(): string {
    const tid = this.prisma.currentTenantId;
    if (!tid) throw new Error('No tenant context');
    return tid;
  }
}
