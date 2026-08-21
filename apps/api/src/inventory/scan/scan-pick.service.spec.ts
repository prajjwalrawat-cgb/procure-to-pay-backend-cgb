import { describe, expect, it, vi } from 'vitest';

import { ScanPickService } from './scan-pick.service';
import { PickListStateError, ScanValidationError } from './scan.errors';

const baseInput = {
  orderId: 'AMZ-1001',
  barcodeRaw: '0012345678905',
  quantity: 3,
  deviceId: 'handset-7',
  clientUuid: '33333333-3333-4333-8333-333333333333',
} as const;

const STORED_SCAN = {
  id: 'scn_3',
  scanType: 'PICK',
  productId: 'prd_1',
  quantity: 3,
  locationId: 'loc_a',
  clientUuid: baseInput.clientUuid,
  ledgerEntryId: 'sle_pick',
  createdAt: new Date('2026-08-20T10:00:00Z'),
  syncedAt: new Date('2026-08-20T10:00:00Z'),
};

function makeService(
  opts: {
    existingScan?: unknown;
    list?: Record<string, unknown> | null;
    line?: Record<string, unknown> | null;
    allocations?: {
      locationId: string;
      batchNumber: string | null;
      expiryDate: Date | null;
      qty: number;
    }[];
    linesAfter?: { qtyRequired: number; qtyPicked: number }[];
  } = {},
) {
  const posts: Record<string, unknown>[] = [];
  let ledgerSeq = 0;

  const client = {
    pickList: {
      findFirst: vi.fn(async () =>
        opts.list === undefined
          ? {
              id: 'pkl_1',
              status: 'OPEN',
              platform: 'Amazon',
              customerName: 'A. Buyer',
              orderRef: 'AMZ-1001',
            }
          : opts.list,
      ),
      update: vi.fn(async () => ({})),
    },
    pickListLine: {
      findFirst: vi.fn(async () =>
        opts.line === undefined
          ? { id: 'pll_1', qtyRequired: 5, qtyPicked: 0 }
          : opts.line,
      ),
      update: vi.fn(async () => ({})),
      findMany: vi.fn(async () => opts.linesAfter ?? [{ qtyRequired: 5, qtyPicked: 3 }]),
    },
    scanEvent: {
      findFirst: vi.fn(async () => opts.existingScan ?? null),
      create: vi.fn(async () => STORED_SCAN),
    },
  };

  const resolve = {
    resolveBarcode: vi.fn(async () => ({ id: 'prd_1', code: 'HD-000123', name: 'Vase' })),
  } as never;

  const fefo = {
    allocateForPick: vi.fn(
      async () =>
        opts.allocations ?? [
          {
            locationId: 'loc_a',
            batchNumber: 'B-1',
            expiryDate: new Date('2026-12-01'),
            qty: 3,
          },
        ],
    ),
  } as never;

  const ledger = {
    post: vi.fn(async (input: Record<string, unknown>) => {
      posts.push(input);
      ledgerSeq += 1;
      return `sle_${ledgerSeq}`;
    }),
  } as never;

  const service = new ScanPickService(
    { client, currentTenantId: 'ten_1' } as never,
    resolve,
    fefo,
    ledger,
  );
  return { service, client, posts };
}

describe('scan pick — happy path', () => {
  it('posts an outbound row per FEFO batch and advances the line', async () => {
    const { service, client, posts } = makeService({
      allocations: [
        {
          locationId: 'loc_a',
          batchNumber: 'B-1',
          expiryDate: new Date('2026-12-01'),
          qty: 2,
        },
        {
          locationId: 'loc_b',
          batchNumber: 'B-2',
          expiryDate: new Date('2027-06-01'),
          qty: 1,
        },
      ],
    });
    const result = await service.pick({ ...baseInput } as never, 'usr_1');

    // One ledger row per batch, each carrying the batch it consumed — this is
    // what makes a recall traceable later.
    expect(posts).toHaveLength(2);
    expect(posts[0]).toMatchObject({
      txnType: 'CUSTOMER_ORDER_OUT',
      locationId: 'loc_a',
      batchNumber: 'B-1',
      qty: 2,
      orderId: 'AMZ-1001',
    });
    expect(posts[1]).toMatchObject({ locationId: 'loc_b', batchNumber: 'B-2', qty: 1 });

    expect(client.pickListLine.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { qtyPicked: 3 } }),
    );
    expect(result.allocations).toHaveLength(2);
    expect(result.line).toMatchObject({ qtyRequired: 5, qtyPicked: 3, remaining: 2 });
  });

  it('reports a partial pick as not complete', async () => {
    const { service } = makeService({ linesAfter: [{ qtyRequired: 5, qtyPicked: 3 }] });
    const result = await service.pick({ ...baseInput } as never, 'usr_1');
    expect(result.orderComplete).toBe(false);
  });

  it('closes the order once every line is satisfied', async () => {
    const { service, client } = makeService({
      line: { id: 'pll_1', qtyRequired: 3, qtyPicked: 0 },
      linesAfter: [{ qtyRequired: 3, qtyPicked: 3 }],
    });
    const result = await service.pick({ ...baseInput } as never, 'usr_1');

    expect(result.orderComplete).toBe(true);
    expect(client.pickList.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PICKED' }) }),
    );
  });
});

describe('scan pick — over-scan', () => {
  it('refuses to pick more than the line still needs', async () => {
    const { service, posts } = makeService({
      line: { id: 'pll_1', qtyRequired: 5, qtyPicked: 4 },
    });
    const error = await service
      .pick({ ...baseInput, quantity: 3 } as never, 'usr_1')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ScanValidationError);
    expect((error as ScanValidationError).context).toMatchObject({
      requested: 3,
      remaining: 1,
    });
    expect(posts).toHaveLength(0);
  });

  it('refuses a line that is already fully picked', async () => {
    const { service } = makeService({
      line: { id: 'pll_1', qtyRequired: 5, qtyPicked: 5 },
    });
    await expect(service.pick({ ...baseInput } as never, 'usr_1')).rejects.toBeInstanceOf(
      ScanValidationError,
    );
  });

  it('refuses a product that is not on the order at all', async () => {
    const { service, posts } = makeService({ line: null });
    await expect(service.pick({ ...baseInput } as never, 'usr_1')).rejects.toBeInstanceOf(
      ScanValidationError,
    );
    expect(posts).toHaveLength(0);
  });
});

describe('scan pick — pick list state', () => {
  it('refuses an unknown order reference', async () => {
    const { service } = makeService({ list: null });
    await expect(service.pick({ ...baseInput } as never, 'usr_1')).rejects.toBeInstanceOf(
      PickListStateError,
    );
  });

  it('refuses a cancelled order', async () => {
    const { service } = makeService({
      list: {
        id: 'pkl_1',
        status: 'CANCELLED',
        platform: null,
        customerName: null,
        orderRef: 'AMZ-1001',
      },
    });
    await expect(service.pick({ ...baseInput } as never, 'usr_1')).rejects.toBeInstanceOf(
      PickListStateError,
    );
  });
});

describe('scan pick — idempotency', () => {
  it('replays without posting a second outbound row', async () => {
    const { service, posts } = makeService({ existingScan: STORED_SCAN });
    const result = await service.pick({ ...baseInput } as never, 'usr_1');

    expect(result.duplicate).toBe(true);
    expect(posts).toHaveLength(0);
  });
});

describe('pick list checklist', () => {
  it('renders per-line progress for the handset', async () => {
    const { service, client } = makeService();
    client.pickList.findFirst.mockResolvedValueOnce({
      id: 'pkl_1',
      orderRef: 'AMZ-1001',
      platform: 'Amazon',
      customerName: 'A. Buyer',
      status: 'IN_PROGRESS',
      lines: [
        {
          productId: 'prd_1',
          qtyRequired: 5,
          qtyPicked: 3,
          product: { code: 'HD-000123', name: 'Vase', barcode: '001' },
        },
        {
          productId: 'prd_2',
          qtyRequired: 2,
          qtyPicked: 2,
          product: { code: 'HD-000124', name: 'Bowl', barcode: '002' },
        },
      ],
    } as never);

    const list = await service.pickList('AMZ-1001');
    expect(list.totalRequired).toBe(7);
    expect(list.totalPicked).toBe(5);
    expect(list.lines[0]).toMatchObject({ remaining: 2, complete: false });
    expect(list.lines[1]).toMatchObject({ remaining: 0, complete: true });
  });
});
