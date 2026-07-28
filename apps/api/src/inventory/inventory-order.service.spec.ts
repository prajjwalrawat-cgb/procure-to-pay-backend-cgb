import { describe, expect, it, vi } from 'vitest';

import { InventoryOrderService } from './inventory-order.service';
import { LedgerStateError } from './inventory.errors';

const baseFulfill = {
  productId: 'prd_1',
  locationId: 'loc_1',
  qty: 1,
  allowNegativeStock: false,
};

function makeService(
  opts: { stockAt?: number; entry?: Record<string, unknown> | null } = {},
) {
  const posts: Record<string, unknown>[] = [];
  const audits: Record<string, unknown>[] = [];
  let n = 0;

  const client = {
    stockLedgerEntry: {
      findUnique: vi.fn(async () => (opts.entry === undefined ? null : opts.entry)),
      update: vi.fn(async () => ({})),
    },
  };

  const ledger = {
    post: vi.fn(async (input: Record<string, unknown>) => {
      posts.push(input);
      n += 1;
      return `sle_${n}`;
    }),
    stockAt: vi.fn(async () => opts.stockAt ?? 100),
  } as never;

  const service = new InventoryOrderService(
    { client, currentTenantId: 'ten_1' } as never,
    ledger,
    { require: vi.fn(async () => ({ id: 'prd_1' })) } as never,
    { require: vi.fn(async () => ({ id: 'loc_1' })) } as never,
    {
      record: vi.fn(async (a: Record<string, unknown>) => {
        audits.push(a);
      }),
    } as never,
  );
  return { service, posts, audits, client };
}

describe('fulfill — stock check (business rule 4)', () => {
  it('posts a stock-checked CUSTOMER_ORDER_OUT', async () => {
    const { service, posts } = makeService({ stockAt: 10 });
    await service.fulfill(
      { ...baseFulfill, qty: 2, platform: 'Shopify', orderId: '6149' },
      'usr_1',
    );
    expect(posts[0]).toMatchObject({
      txnType: 'CUSTOMER_ORDER_OUT',
      qty: 2,
      platform: 'Shopify',
      orderId: '6149',
      allowNegativeStock: false,
    });
  });

  it('passes the override through to the ledger when set', async () => {
    const { service, posts } = makeService({ stockAt: 1 });
    await service.fulfill({ ...baseFulfill, qty: 5, allowNegativeStock: true }, 'usr_1');
    expect(posts[0]).toMatchObject({ allowNegativeStock: true });
  });

  it('annotates the entry when the stock check was actually overridden', async () => {
    const { service, posts } = makeService({ stockAt: 1 });
    await service.fulfill({ ...baseFulfill, qty: 5, allowNegativeStock: true }, 'usr_1');
    expect(String(posts[0]?.remark)).toMatch(/Stock-check overridden \(1 on hand\)/);
  });

  it('audits an override under a distinct action so it is findable', async () => {
    const { service, audits } = makeService({ stockAt: 1 });
    await service.fulfill({ ...baseFulfill, qty: 5, allowNegativeStock: true }, 'usr_1');
    expect(audits[0]).toMatchObject({ action: 'INVENTORY_ORDER_FULFILLED_OVERRIDE' });
  });

  it('does not annotate when the override flag was set but stock was sufficient', async () => {
    const { service, posts, audits } = makeService({ stockAt: 50 });
    await service.fulfill({ ...baseFulfill, qty: 5, allowNegativeStock: true }, 'usr_1');
    expect(posts[0]?.remark).toBeNull();
    expect(audits[0]).toMatchObject({ action: 'INVENTORY_ORDER_FULFILLED' });
  });
});

describe('customerReturn + restockDecision (business rule 5)', () => {
  it('lands a return pending a decision', async () => {
    const { service, posts } = makeService();
    await service.customerReturn(
      { ...baseFulfill, qty: 1, orderId: '6149', productCondition: 'Sealed' },
      'usr_1',
    );
    expect(posts[0]).toMatchObject({
      txnType: 'CUSTOMER_RETURN_IN',
      restockDecision: null,
      productCondition: 'Sealed',
    });
  });

  function withReturn(entry: Record<string, unknown> = {}) {
    return makeService({
      entry: {
        id: 'sle_1',
        txnType: 'CUSTOMER_RETURN_IN',
        qty: 3,
        productId: 'prd_1',
        locationId: 'loc_1',
        orderId: '6149',
        productCondition: 'Damaged box',
        restockDecision: null,
        ...entry,
      },
    });
  }

  it('restock = true keeps the stock and posts nothing further', async () => {
    const { service, posts, client } = withReturn();
    const res = await service.restockDecision('sle_1', { restock: true }, 'usr_1');

    expect(posts).toHaveLength(0);
    expect(res.writeOffEntryId).toBeNull();
    expect(client.stockLedgerEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { restockDecision: true } }),
    );
  });

  it('restock = false produces a DAMAGE_WRITE_OFF, not a stock add', async () => {
    const { service, posts } = withReturn();
    const res = await service.restockDecision('sle_1', { restock: false }, 'usr_1');

    expect(posts[0]).toMatchObject({
      txnType: 'DAMAGE_WRITE_OFF',
      qty: 3,
      correctionOfId: 'sle_1',
    });
    expect(res.writeOffEntryId).toBe('sle_1');
  });

  it('carries the product condition onto the write-off remark', async () => {
    const { service, posts } = withReturn();
    await service.restockDecision('sle_1', { restock: false }, 'usr_1');
    expect(String(posts[0]?.remark)).toMatch(/Condition: Damaged box/);
  });

  it('refuses a second decision on the same return', async () => {
    const { service } = withReturn({ restockDecision: true });
    await expect(
      service.restockDecision('sle_1', { restock: false }, 'usr_1'),
    ).rejects.toBeInstanceOf(LedgerStateError);
  });

  it('refuses a decision on a movement that is not a customer return', async () => {
    const { service } = withReturn({ txnType: 'VENDOR_INWARD' });
    await expect(
      service.restockDecision('sle_1', { restock: true }, 'usr_1'),
    ).rejects.toThrow(/not a customer return/i);
  });
});

describe('adjust — corrections (business rule 6)', () => {
  it('posts a signed adjustment', async () => {
    const { service, posts } = makeService();
    await service.adjust(
      { productId: 'prd_1', locationId: 'loc_1', signedQty: -12, reason: 'Stock count' },
      'usr_1',
    );
    expect(posts[0]).toMatchObject({ txnType: 'ADJUSTMENT', signedQty: -12 });
  });

  it('links a correction to the entry it offsets', async () => {
    const { service, posts, audits } = makeService({ entry: { id: 'sle_orig' } });
    await service.adjust(
      {
        productId: 'prd_1',
        locationId: 'loc_1',
        signedQty: -5,
        reason: 'Posted twice by mistake',
        correctionOfId: 'sle_orig',
      },
      'usr_1',
    );
    expect(posts[0]).toMatchObject({ correctionOfId: 'sle_orig' });
    expect(audits[0]).toMatchObject({ action: 'INVENTORY_CORRECTION_POSTED' });
  });

  it('refuses to correct an entry that does not exist', async () => {
    const { service } = makeService({ entry: null });
    await expect(
      service.adjust(
        {
          productId: 'prd_1',
          locationId: 'loc_1',
          signedQty: -5,
          reason: 'oops',
          correctionOfId: 'sle_missing',
        },
        'usr_1',
      ),
    ).rejects.toThrow(/no such ledger entry/i);
  });

  it('lets an adjustment take a location negative — that is the discrepancy', async () => {
    const { service, posts } = makeService({ stockAt: 0 });
    await service.adjust(
      { productId: 'prd_1', locationId: 'loc_1', signedQty: -3, reason: 'Count shortfall' },
      'usr_1',
    );
    expect(posts[0]).toMatchObject({ allowNegativeStock: true });
  });
});

describe('writeOffDamage', () => {
  it('posts a DAMAGE_WRITE_OFF carrying the reason', async () => {
    const { service, posts } = makeService();
    await service.writeOffDamage(
      { ...baseFulfill, qty: 4, reason: 'Water damage in Store' },
      'usr_1',
    );
    expect(posts[0]).toMatchObject({ txnType: 'DAMAGE_WRITE_OFF', qty: 4 });
    expect(String(posts[0]?.remark)).toMatch(/Water damage in Store/);
  });
});
