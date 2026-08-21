import { describe, expect, it, vi } from 'vitest';

import { BoxMovementService } from './box-movement.service';
import { BoxStateError, BoxValidationError } from './box.errors';

const CONTENTS = [
  {
    productId: 'prd_1',
    productCode: 'SC-000010',
    productName: 'Epoxy Sealant',
    barcode: '890',
    batchNumber: 'B-2601',
    expiryDate: '2026-10-05T00:00:00.000Z',
    qty: 12,
    expired: false,
  },
  {
    productId: 'prd_2',
    productCode: 'SC-000008',
    productName: 'Ceramic Vase',
    barcode: '590',
    batchNumber: null,
    expiryDate: null,
    qty: 5,
    expired: false,
  },
];

function makeService(
  opts: {
    box?: Record<string, unknown>;
    contents?: typeof CONTENTS;
    /** Per-batch balances the box-aware query returns. */
    balances?: { batch_number: string | null; expiry_date: Date | null; qty: bigint }[];
    destination?: { id: string; name: string };
  } = {},
) {
  const posts: Record<string, unknown>[] = [];

  const box = opts.box ?? {
    id: 'box_1',
    code: 'BOX-000001',
    active: true,
    locationId: 'loc_a1',
    location: { id: 'loc_a1', name: 'Section A1' },
  };

  const client = {
    box: {
      findFirstOrThrow: vi.fn(async () => box),
      update: vi.fn(async () => ({})),
    },
    boxMove: { create: vi.fn(async () => ({})) },
    location: {
      findFirst: vi.fn(
        async () => opts.destination ?? { id: 'loc_b2', name: 'Section B2' },
      ),
    },
    $queryRaw: vi.fn(
      async () =>
        opts.balances ?? [
          {
            batch_number: 'B-2601',
            expiry_date: new Date('2026-10-05'),
            qty: BigInt(12),
          },
          { batch_number: 'B-2704', expiry_date: new Date('2027-09-25'), qty: BigInt(8) },
        ],
    ),
  };

  const boxes = {
    resolveByBarcode: vi.fn(async () => ({ id: 'box_1' })),
    contents: vi.fn(async () => opts.contents ?? CONTENTS),
    detail: vi.fn(async () => ({
      id: 'box_1',
      code: 'BOX-000001',
      location: { id: 'loc_b2', name: 'Section B2' },
      contents: [],
      totalQty: 0,
    })),
  } as never;

  const resolve = {
    resolveBarcode: vi.fn(async () => ({
      id: 'prd_1',
      code: 'SC-000010',
      name: 'Epoxy Sealant',
    })),
    resolveBin: vi.fn(
      async () => opts.destination ?? { id: 'loc_b2', name: 'Section B2' },
    ),
  } as never;

  const ledger = {
    post: vi.fn(async (input: Record<string, unknown>) => {
      posts.push(input);
      return `sle_${posts.length}`;
    }),
  } as never;

  const audit = { record: vi.fn(async () => undefined) } as never;

  const service = new BoxMovementService(
    { client, currentTenantId: 'ten_1' } as never,
    boxes,
    resolve,
    ledger,
    audit,
  );
  return { service, client, posts };
}

describe('moving a box', () => {
  it('carries the contents with it — a transfer pair per product and batch', async () => {
    const { service, posts } = makeService();
    const result = await service.move(
      { boxBarcodeRaw: 'BOX-000001', toBinBarcodeRaw: 'BIN-B2' } as never,
      'usr_1',
    );

    // Two lines in the box → 4 rows: OUT of A1 and IN to B2 for each.
    expect(posts).toHaveLength(4);
    expect(posts[0]).toMatchObject({
      txnType: 'TRANSFER_OUT',
      locationId: 'loc_a1',
      boxId: 'box_1',
      batchNumber: 'B-2601',
      qty: 12,
    });
    expect(posts[1]).toMatchObject({
      txnType: 'TRANSFER_IN',
      locationId: 'loc_b2',
      boxId: 'box_1',
      batchNumber: 'B-2601',
      qty: 12,
    });
    expect(result.entriesPosted).toBe(4);
  });

  it('keeps the box id on every leg, so contents follow the box', async () => {
    const { service, posts } = makeService();
    await service.move(
      { boxBarcodeRaw: 'BOX-000001', toBinBarcodeRaw: 'BIN-B2' } as never,
      'usr_1',
    );
    expect(posts.every((p) => p.boxId === 'box_1')).toBe(true);
  });

  it('records the move and repoints the box in the same breath', async () => {
    const { service, client } = makeService();
    await service.move(
      { boxBarcodeRaw: 'BOX-000001', toBinBarcodeRaw: 'BIN-B2' } as never,
      'usr_1',
    );

    expect(client.boxMove.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fromLocationId: 'loc_a1',
          toLocationId: 'loc_b2',
        }),
      }),
    );
    expect(client.box.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { locationId: 'loc_b2' } }),
    );
  });

  it('moves an empty box with no ledger rows at all', async () => {
    const { service, posts, client } = makeService({ contents: [] });
    const result = await service.move(
      { boxBarcodeRaw: 'BOX-000001', toBinBarcodeRaw: 'BIN-B2' } as never,
      'usr_1',
    );

    expect(posts).toHaveLength(0);
    expect(result.entriesPosted).toBe(0);
    // …but the history still records it. This is exactly why BoxMove exists.
    expect(client.boxMove.create).toHaveBeenCalled();
  });

  it('refuses a move to the section the box is already in', async () => {
    const { service, posts } = makeService({
      destination: { id: 'loc_a1', name: 'Section A1' },
    });
    const error = await service
      .move({ boxBarcodeRaw: 'BOX-000001', toBinBarcodeRaw: 'BIN-A1' } as never, 'usr_1')
      .catch((e: unknown) => e);

    // Loud, not silent — the operator believes they moved something.
    expect(error).toBeInstanceOf(BoxStateError);
    expect(posts).toHaveLength(0);
  });

  it('refuses to move a retired box', async () => {
    const { service } = makeService({
      box: {
        id: 'box_1',
        code: 'BOX-000001',
        active: false,
        locationId: 'loc_a1',
        location: null,
      },
    });
    await expect(
      service.move(
        { boxBarcodeRaw: 'BOX-000001', toBinBarcodeRaw: 'BIN-B2' } as never,
        'usr_1',
      ),
    ).rejects.toBeInstanceOf(BoxStateError);
  });
});

describe('packing stock into a box', () => {
  it('moves loose stock into the box at the same location, oldest expiry first', async () => {
    const { service, posts } = makeService();
    await service.pack(
      { boxBarcodeRaw: 'BOX-000001', barcodeRaw: '890', quantity: 15 } as never,
      'usr_1',
    );

    // 12 from the near-expiry batch, then 3 from the next → two pairs.
    expect(posts).toHaveLength(4);
    expect(posts[0]).toMatchObject({ txnType: 'TRANSFER_OUT', boxId: null, qty: 12 });
    expect(posts[1]).toMatchObject({ txnType: 'TRANSFER_IN', boxId: 'box_1', qty: 12 });
    expect(posts[2]).toMatchObject({ txnType: 'TRANSFER_OUT', boxId: null, qty: 3 });
    expect(posts[3]).toMatchObject({ txnType: 'TRANSFER_IN', boxId: 'box_1', qty: 3 });
  });

  it('stays at one location — packing does not move stock between shelves', async () => {
    const { service, posts } = makeService();
    await service.pack(
      { boxBarcodeRaw: 'BOX-000001', barcodeRaw: '890', quantity: 5 } as never,
      'usr_1',
    );
    expect(posts.every((p) => p.locationId === 'loc_a1')).toBe(true);
  });

  it('refuses to pack more than is loose on the shelf', async () => {
    const { service, posts } = makeService({
      balances: [{ batch_number: null, expiry_date: null, qty: BigInt(4) }],
    });
    const error = await service
      .pack(
        { boxBarcodeRaw: 'BOX-000001', barcodeRaw: '890', quantity: 10 } as never,
        'usr_1',
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BoxValidationError);
    expect((error as BoxValidationError).context).toMatchObject({
      available: 4,
      requested: 10,
    });
    expect(posts).toHaveLength(0);
  });

  it('refuses to fill a box that is not on a shelf yet', async () => {
    const { service } = makeService({
      box: {
        id: 'box_1',
        code: 'BOX-000001',
        active: true,
        locationId: null,
        location: null,
      },
    });
    await expect(
      service.pack(
        { boxBarcodeRaw: 'BOX-000001', barcodeRaw: '890', quantity: 1 } as never,
        'usr_1',
      ),
    ).rejects.toBeInstanceOf(BoxValidationError);
  });
});

describe('unpacking stock from a box', () => {
  it('takes stock out of the box and leaves it loose at the same location', async () => {
    const { service, posts } = makeService();
    await service.unpack(
      { boxBarcodeRaw: 'BOX-000001', barcodeRaw: '890', quantity: 12 } as never,
      'usr_1',
    );

    expect(posts[0]).toMatchObject({ txnType: 'TRANSFER_OUT', boxId: 'box_1', qty: 12 });
    expect(posts[1]).toMatchObject({ txnType: 'TRANSFER_IN', boxId: null, qty: 12 });
  });

  it('refuses to remove more than the box holds', async () => {
    const { service, posts } = makeService({
      balances: [{ batch_number: 'B-1', expiry_date: null, qty: BigInt(3) }],
    });
    await expect(
      service.unpack(
        { boxBarcodeRaw: 'BOX-000001', barcodeRaw: '890', quantity: 9 } as never,
        'usr_1',
      ),
    ).rejects.toBeInstanceOf(BoxValidationError);
    expect(posts).toHaveLength(0);
  });
});
