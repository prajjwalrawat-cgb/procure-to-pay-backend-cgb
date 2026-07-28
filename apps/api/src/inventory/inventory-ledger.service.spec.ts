import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InventoryLedgerService } from './inventory-ledger.service';
import { InsufficientStockError, InventoryValidationError } from './inventory.errors';

/**
 * Ledger arithmetic and guard rails. The DB is stubbed; what is under test is
 * the direction derivation, the sufficiency check and the derived balances —
 * the logic that keeps SUM(qty * direction) meaningful.
 */
function makeService(opts: {
  stock?: number;
  product?: { code: string; reorderPoint: number | null } | null;
} = {}) {
  const created: Record<string, unknown>[] = [];
  const emitted: { type: string; payload: Record<string, unknown> }[] = [];

  const client = {
    stockLedgerEntry: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return data;
      }),
      findUnique: vi.fn(),
      aggregate: vi.fn(async () => ({ _sum: { qty: 0 } })),
      findMany: vi.fn(async () => []),
      groupBy: vi.fn(async () => []),
    },
    product: {
      update: vi.fn(async () => ({})),
      findUnique: vi.fn(async () => opts.product ?? null),
    },
    $queryRaw: vi.fn(async () => [{ qty: BigInt(opts.stock ?? 0) }]),
  };

  const prisma = { client, currentTenantId: 'ten_1' } as never;
  const events = {
    emit: vi.fn(async (type: string, payload: Record<string, unknown>) => {
      emitted.push({ type, payload });
    }),
  } as never;

  return { service: new InventoryLedgerService(prisma, events), client, created, emitted };
}

describe('InventoryLedgerService.post — direction derivation', () => {
  it('derives +1 for inward types regardless of caller intent', async () => {
    const { service, created } = makeService();
    await service.post({
      productId: 'prd_1',
      locationId: 'loc_1',
      txnType: 'VENDOR_INWARD',
      qty: 250,
      performedById: 'usr_1',
    });
    expect(created[0]).toMatchObject({ qty: 250, direction: 1 });
  });

  it('derives -1 for outward types', async () => {
    const { service, created } = makeService({ stock: 500 });
    await service.post({
      productId: 'prd_1',
      locationId: 'loc_1',
      txnType: 'CUSTOMER_ORDER_OUT',
      qty: 3,
      performedById: 'usr_1',
    });
    expect(created[0]).toMatchObject({ qty: 3, direction: -1 });
  });

  it('stores a signed ADJUSTMENT as positive qty plus a negative direction', async () => {
    const { service, created } = makeService();
    await service.post({
      productId: 'prd_1',
      locationId: 'loc_1',
      txnType: 'ADJUSTMENT',
      signedQty: -12,
      performedById: 'usr_1',
      allowNegativeStock: true,
    });
    // qty is always the magnitude; the sign lives in `direction`.
    expect(created[0]).toMatchObject({ qty: 12, direction: -1 });
  });

  it('seeds opening stock as a positive ADJUSTMENT', async () => {
    const { service, created } = makeService();
    await service.post({
      productId: 'prd_1',
      locationId: 'loc_1',
      txnType: 'ADJUSTMENT',
      signedQty: 950,
      performedById: 'usr_1',
      remark: 'opening-stock',
      allowNegativeStock: true,
    });
    expect(created[0]).toMatchObject({ qty: 950, direction: 1, remark: 'opening-stock' });
  });
});

describe('InventoryLedgerService.post — validation', () => {
  it('rejects a negative qty on a non-ADJUSTMENT type', async () => {
    const { service } = makeService();
    await expect(
      service.post({
        productId: 'prd_1',
        locationId: 'loc_1',
        txnType: 'VENDOR_INWARD',
        qty: -5,
        performedById: 'usr_1',
      }),
    ).rejects.toBeInstanceOf(InventoryValidationError);
  });

  it('rejects a zero quantity', async () => {
    const { service } = makeService();
    await expect(
      service.post({
        productId: 'prd_1',
        locationId: 'loc_1',
        txnType: 'ADJUSTMENT',
        signedQty: 0,
        performedById: 'usr_1',
      }),
    ).rejects.toThrow(/cannot be zero/i);
  });

  it('rejects fractional pieces', async () => {
    const { service } = makeService();
    await expect(
      service.post({
        productId: 'prd_1',
        locationId: 'loc_1',
        txnType: 'VENDOR_INWARD',
        qty: 2.5,
        performedById: 'usr_1',
      }),
    ).rejects.toThrow(/whole pieces/i);
  });

  it('rejects damageQty larger than the movement', async () => {
    const { service } = makeService();
    await expect(
      service.post({
        productId: 'prd_1',
        locationId: 'loc_1',
        txnType: 'VENDOR_INWARD',
        qty: 10,
        damageQty: 11,
        performedById: 'usr_1',
      }),
    ).rejects.toThrow(/damageQty cannot exceed/i);
  });

  it('requires signedQty for an ADJUSTMENT', async () => {
    const { service } = makeService();
    await expect(
      service.post({
        productId: 'prd_1',
        locationId: 'loc_1',
        txnType: 'ADJUSTMENT',
        performedById: 'usr_1',
      }),
    ).rejects.toThrow(/signedQty is required/i);
  });
});

describe('InventoryLedgerService.post — stock sufficiency (business rule 4)', () => {
  it('blocks an outward movement that exceeds stock at the location', async () => {
    const { service } = makeService({ stock: 2 });
    await expect(
      service.post({
        productId: 'prd_1',
        locationId: 'loc_1',
        txnType: 'CUSTOMER_ORDER_OUT',
        qty: 5,
        performedById: 'usr_1',
      }),
    ).rejects.toBeInstanceOf(InsufficientStockError);
  });

  it('allows an outward movement that exactly drains the location', async () => {
    const { service, created } = makeService({ stock: 5 });
    await service.post({
      productId: 'prd_1',
      locationId: 'loc_1',
      txnType: 'CUSTOMER_ORDER_OUT',
      qty: 5,
      performedById: 'usr_1',
    });
    expect(created).toHaveLength(1);
  });

  it('permits going negative when the override is set explicitly', async () => {
    const { service, created } = makeService({ stock: 2 });
    await service.post({
      productId: 'prd_1',
      locationId: 'loc_1',
      txnType: 'CUSTOMER_ORDER_OUT',
      qty: 5,
      performedById: 'usr_1',
      allowNegativeStock: true,
    });
    expect(created).toHaveLength(1);
  });

  it('never stock-checks an inward movement', async () => {
    const { service, client } = makeService({ stock: 0 });
    await service.post({
      productId: 'prd_1',
      locationId: 'loc_1',
      txnType: 'VENDOR_INWARD',
      qty: 100,
      performedById: 'usr_1',
    });
    // The only raw query allowed here is the low-stock check, which inward skips.
    expect(client.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('InventoryLedgerService — side effects', () => {
  it('touches the product so "Last Updated" reflects ledger activity', async () => {
    const { service, client } = makeService();
    await service.post({
      productId: 'prd_1',
      locationId: 'loc_1',
      txnType: 'VENDOR_INWARD',
      qty: 10,
      performedById: 'usr_1',
    });
    expect(client.product.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'prd_1' } }),
    );
  });

  it('emits an entry-posted event for every movement', async () => {
    const { service, emitted } = makeService();
    await service.post({
      productId: 'prd_1',
      locationId: 'loc_1',
      txnType: 'VENDOR_INWARD',
      qty: 10,
      performedById: 'usr_1',
    });
    expect(emitted.map((e) => e.type)).toContain('InventoryEntryPosted');
  });

  it('emits low-stock when an outward movement breaches the reorder point', async () => {
    const { service, emitted } = makeService({
      stock: 5,
      product: { code: 'HD-000001', reorderPoint: 10 },
    });
    await service.post({
      productId: 'prd_1',
      locationId: 'loc_1',
      txnType: 'CUSTOMER_ORDER_OUT',
      qty: 1,
      performedById: 'usr_1',
    });
    expect(emitted.map((e) => e.type)).toContain('InventoryLowStock');
  });

  it('stays quiet when the product has no reorder point', async () => {
    const { service, emitted } = makeService({
      stock: 5,
      product: { code: 'HD-000001', reorderPoint: null },
    });
    await service.post({
      productId: 'prd_1',
      locationId: 'loc_1',
      txnType: 'CUSTOMER_ORDER_OUT',
      qty: 1,
      performedById: 'usr_1',
    });
    expect(emitted.map((e) => e.type)).not.toContain('InventoryLowStock');
  });
});

describe('InventoryLedgerService — derived issue balances (business rule 3)', () => {
  let service: InventoryLedgerService;
  let client: ReturnType<typeof makeService>['client'];

  beforeEach(() => {
    const made = makeService();
    service = made.service;
    client = made.client;
  });

  it('reports the full quantity as outstanding before any return', async () => {
    client.stockLedgerEntry.findUnique.mockResolvedValue({
      qty: 20,
      txnType: 'INTERNAL_ISSUE',
    });
    client.stockLedgerEntry.aggregate.mockResolvedValue({ _sum: { qty: null } });
    expect(await service.openBalanceForIssue('sle_1')).toBe(20);
  });

  it('decrements correctly across multiple partial returns', async () => {
    client.stockLedgerEntry.findUnique.mockResolvedValue({
      qty: 20,
      txnType: 'INTERNAL_ISSUE',
    });
    // Two partial returns of 5 and 8 have been posted.
    client.stockLedgerEntry.aggregate.mockResolvedValue({ _sum: { qty: 13 } });
    expect(await service.openBalanceForIssue('sle_1')).toBe(7);
  });

  it('reaches exactly zero on full return', async () => {
    client.stockLedgerEntry.findUnique.mockResolvedValue({
      qty: 20,
      txnType: 'INTERNAL_ISSUE',
    });
    client.stockLedgerEntry.aggregate.mockResolvedValue({ _sum: { qty: 20 } });
    expect(await service.openBalanceForIssue('sle_1')).toBe(0);
  });

  it('returns zero for an entry that is not an internal issue', async () => {
    client.stockLedgerEntry.findUnique.mockResolvedValue({
      qty: 20,
      txnType: 'VENDOR_INWARD',
    });
    expect(await service.openBalanceForIssue('sle_1')).toBe(0);
  });

  it('batches balances for the open-issues board', async () => {
    client.stockLedgerEntry.findMany.mockResolvedValue([
      { id: 'sle_1', qty: 20 },
      { id: 'sle_2', qty: 5 },
    ]);
    client.stockLedgerEntry.groupBy.mockResolvedValue([
      { issueEntryId: 'sle_1', _sum: { qty: 12 } },
    ]);

    const balances = await service.openBalancesForIssues(['sle_1', 'sle_2']);
    expect(balances.get('sle_1')).toBe(8); // partially returned
    expect(balances.get('sle_2')).toBe(5); // untouched
  });

  it('returns an empty map for an empty id list without querying', async () => {
    const balances = await service.openBalancesForIssues([]);
    expect(balances.size).toBe(0);
    expect(client.stockLedgerEntry.findMany).not.toHaveBeenCalled();
  });
});
