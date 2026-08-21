import { describe, expect, it, vi } from 'vitest';

import { BoxService } from './box.service';
import { BoxNotFoundError, BoxValidationError } from './box.errors';

const CONTENTS = [
  {
    product_id: 'prd_1',
    batch_number: 'B-2601',
    expiry_date: new Date('2026-10-05'),
    qty: BigInt(12),
  },
  {
    product_id: 'prd_1',
    batch_number: 'B-2704',
    expiry_date: new Date('2027-09-25'),
    qty: BigInt(8),
  },
  { product_id: 'prd_2', batch_number: null, expiry_date: null, qty: BigInt(5) },
];

function makeService(
  opts: {
    box?: Record<string, unknown> | null;
    contents?: unknown[];
    whereRows?: unknown[];
    pathRows?: unknown[];
    boxCount?: number;
    clash?: { id: string; code: string } | null;
  } = {},
) {
  // The service issues two kinds of raw query: contents/where aggregates and the
  // recursive path walk. They are distinguished by which one is asked for.
  const queryRaw = vi.fn(async (strings: TemplateStringsArray) => {
    const sql = Array.isArray(strings) ? strings.join('') : String(strings);
    if (sql.includes('RECURSIVE')) return opts.pathRows ?? [];
    if (
      sql.includes('"box_id", "batch_number"') ||
      sql.includes('location_id", "box_id"')
    ) {
      return opts.whereRows ?? [];
    }
    return opts.contents ?? CONTENTS;
  });

  const client = {
    box: {
      // The barcode-clash probe and the detail read both hit findFirst; they
      // are told apart by what they filter on, not by what they select.
      findFirst: vi.fn(async ({ where }: { where?: Record<string, unknown> }) =>
        where && 'barcode' in where
          ? (opts.clash ?? null)
          : opts.box === undefined
            ? {
                id: 'box_1',
                code: 'BOX-000001',
                barcode: 'BOX-000001',
                active: true,
                notes: null,
                locationId: 'loc_a1',
                location: { id: 'loc_a1', name: 'Section A1', kind: 'SECTION' },
              }
            : opts.box,
      ),
      findMany: vi.fn(async () => [
        { id: 'box_1', code: 'BOX-000001', barcode: 'BOX-000001' },
      ]),
      count: vi.fn(async () => opts.boxCount ?? 0),
      create: vi.fn(async () => ({})),
    },
    boxMove: {
      findFirst: vi.fn(async () => ({ movedAt: new Date('2026-08-21T09:00:00Z') })),
      create: vi.fn(async () => ({})),
    },
    product: {
      findMany: vi.fn(async () => [
        { id: 'prd_1', code: 'SC-000010', name: 'Epoxy Sealant 1L', barcode: '890' },
        { id: 'prd_2', code: 'SC-000008', name: 'Ceramic Vase', barcode: '590' },
      ]),
    },
    location: { findFirst: vi.fn(async () => ({ id: 'loc_a1', name: 'Section A1' })) },
    $queryRaw: queryRaw,
  };

  const paths = {
    pathFor: vi.fn(async () => ({
      warehouse: 'Main Warehouse',
      rack: 'Rack A',
      section: 'Section A1',
      full: [],
    })),
    pathsFor: vi.fn(
      async (ids: string[]) =>
        new Map(
          ids.map((id) => [
            id,
            {
              warehouse: 'Main Warehouse',
              rack: 'Rack A',
              section: 'Section A1',
              full: [],
            },
          ]),
        ),
    ),
  } as never;

  const products = {
    require: vi.fn(async () => ({
      id: 'prd_1',
      code: 'SC-000010',
      name: 'Epoxy Sealant 1L',
      barcode: '890',
    })),
  } as never;

  const audit = { record: vi.fn(async () => undefined) } as never;

  const service = new BoxService(
    { client, currentTenantId: 'ten_1' } as never,
    paths,
    products,
    audit,
  );
  return { service, client };
}

describe('box contents — derived, never stored', () => {
  it('aggregates the ledger into per-product, per-batch lines', async () => {
    const { service } = makeService();
    const contents = await service.contents('box_1', new Date('2026-08-21'));

    expect(contents).toHaveLength(3);
    expect(contents[0]).toMatchObject({
      productId: 'prd_1',
      productName: 'Epoxy Sealant 1L',
      batchNumber: 'B-2601',
      qty: 12,
    });
  });

  it('flags expired stock rather than hiding it', async () => {
    const { service } = makeService();
    // Read the box a year later: the near-expiry batch has passed.
    const contents = await service.contents('box_1', new Date('2027-01-01'));

    // It is physically in the carton; a shorter list would disagree with what
    // the operator is holding.
    expect(contents.find((c) => c.batchNumber === 'B-2601')?.expired).toBe(true);
    expect(contents.find((c) => c.batchNumber === 'B-2704')?.expired).toBe(false);
  });

  it('returns nothing for an empty box', async () => {
    const { service } = makeService({ contents: [] });
    await expect(service.contents('box_1')).resolves.toEqual([]);
  });
});

describe('box detail — what a scan shows', () => {
  it('reports the box, its full location path, and totals', async () => {
    const { service } = makeService();
    const detail = await service.detail('box_1');

    expect(detail.code).toBe('BOX-000001');
    expect(detail.location?.path).toMatchObject({
      warehouse: 'Main Warehouse',
      rack: 'Rack A',
      section: 'Section A1',
    });
    expect(detail.totalQty).toBe(25);
    expect(detail.distinctProducts).toBe(2);
  });

  it('throws a 404 for an unknown box', async () => {
    const { service } = makeService({ box: null });
    await expect(service.detail('box_nope')).rejects.toBeInstanceOf(BoxNotFoundError);
  });
});

describe('resolveByBarcode', () => {
  it('carries the raw value on a miss so the UI can offer to register it', async () => {
    const { service } = makeService({ box: null });
    const error = await service.resolveByBarcode('BOX-NOPE').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BoxNotFoundError);
    expect((error as BoxNotFoundError).context).toEqual({ barcodeRaw: 'BOX-NOPE' });
  });
});

describe('registering a box', () => {
  it('refuses a barcode already stuck on another box', async () => {
    const { service } = makeService({ clash: { id: 'box_9', code: 'BOX-000009' } });
    const error = await service
      .create({ barcode: 'DUP-1', locationId: null, notes: null }, 'usr_1')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BoxValidationError);
    expect((error as BoxValidationError).message).toContain('BOX-000009');
  });

  it('records the first placement as a move, so history has no gap', async () => {
    const { service, client } = makeService({ clash: null });
    await service.create({ barcode: null, locationId: 'loc_a1', notes: null }, 'usr_1');

    expect(client.boxMove.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ fromLocationId: null, toLocationId: 'loc_a1' }),
      }),
    );
  });

  it('does not invent a move for a box that is nowhere yet', async () => {
    const { service, client } = makeService({ clash: null });
    await service.create({ barcode: null, locationId: null, notes: null }, 'usr_1');
    expect(client.boxMove.create).not.toHaveBeenCalled();
  });
});

describe('reverse lookup — where is this product', () => {
  it('returns every place it sits, boxed and loose, with the full path', async () => {
    const { service } = makeService({
      whereRows: [
        {
          location_id: 'loc_a1',
          box_id: 'box_1',
          batch_number: 'B-2601',
          expiry_date: new Date('2026-10-05'),
          qty: BigInt(12),
        },
        {
          location_id: 'loc_a1',
          box_id: null,
          batch_number: null,
          expiry_date: null,
          qty: BigInt(4),
        },
      ],
    });

    const result = await service.whereIs('prd_1');

    expect(result.totalQty).toBe(16);
    expect(result.rows[0]).toMatchObject({
      qty: 12,
      box: { code: 'BOX-000001' },
    });
    expect(result.rows[0].path).toMatchObject({ rack: 'Rack A', section: 'Section A1' });
    // Loose stock is part of the answer: "where is it" must not mean "which box".
    expect(result.rows[1].box).toBeNull();
  });

  it('reports nothing rather than guessing when the product is nowhere', async () => {
    const { service } = makeService({ whereRows: [] });
    const result = await service.whereIs('prd_1');
    expect(result).toMatchObject({ totalQty: 0, rows: [] });
  });
});
