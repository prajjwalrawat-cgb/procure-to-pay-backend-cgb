import { describe, expect, it, vi } from 'vitest';

import { ScanPutawayService } from './scan-putaway.service';
import { BinNotFoundError, ScanValidationError } from './scan.errors';

const baseInput = {
  barcodeRaw: '0012345678905',
  binBarcodeRaw: 'BIN-A1',
  quantity: 6,
  deviceId: 'handset-7',
  clientUuid: '22222222-2222-4222-8222-222222222222',
} as const;

const STORED_SCAN = {
  id: 'scn_2',
  scanType: 'PUTAWAY',
  productId: 'prd_1',
  quantity: 6,
  locationId: 'loc_bin',
  binId: 'BIN-A1',
  clientUuid: baseInput.clientUuid,
  ledgerEntryId: 'sle_out',
  createdAt: new Date('2026-08-20T10:00:00Z'),
  syncedAt: new Date('2026-08-20T10:00:00Z'),
};

function makeService(
  opts: {
    existingScan?: unknown;
    lastReceiveLocationId?: string | null;
    receivedQty?: number;
    transferredOutQty?: number;
    binThrows?: Error;
    binId?: string;
  } = {},
) {
  const scanFindFirst = vi
    .fn()
    .mockResolvedValueOnce(opts.existingScan ?? null) // replay check
    .mockResolvedValueOnce(
      opts.lastReceiveLocationId === null
        ? null
        : { locationId: opts.lastReceiveLocationId ?? 'loc_dock' },
    );

  const client = {
    scanEvent: {
      findFirst: scanFindFirst,
      create: vi.fn(async () => STORED_SCAN),
      aggregate: vi.fn(async () => ({ _sum: { quantity: opts.receivedQty ?? 10 } })),
    },
    stockLedgerEntry: {
      aggregate: vi.fn(async () => ({ _sum: { qty: opts.transferredOutQty ?? 0 } })),
    },
    location: { findUnique: vi.fn(async () => ({ id: 'loc_bin', name: 'Rack A1' })) },
    product: { findUnique: vi.fn(async () => ({ name: 'Ceramic Vase' })) },
  };

  const resolve = {
    resolveBarcode: vi.fn(async () => ({
      id: 'prd_1',
      code: 'HD-000123',
      name: 'Ceramic Vase',
    })),
    resolveBin: vi.fn(async () => {
      if (opts.binThrows) throw opts.binThrows;
      return {
        id: opts.binId ?? 'loc_bin',
        name: 'Rack A1',
        rackNo: 'A1',
        barcode: 'BIN-A1',
      };
    }),
  } as never;

  const movement = {
    move: vi.fn(async () => ({
      outEntryIds: ['sle_out'],
      inEntryIds: ['sle_in'],
      allocations: [],
    })),
  };

  const service = new ScanPutawayService(
    { client, currentTenantId: 'ten_1' } as never,
    resolve,
    movement as never,
  );
  return { service, movement, client };
}

describe('scan putaway — happy path', () => {
  it('moves stock from where it was received into the scanned bin', async () => {
    const { service, movement } = makeService({ receivedQty: 10 });
    const result = await service.putaway({ ...baseInput } as never, 'usr_1');

    expect(movement.move).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: 'prd_1',
        fromLocationId: 'loc_dock',
        toLocationId: 'loc_bin',
        qty: 6,
      }),
    );
    expect(result.binLocation.name).toBe('Rack A1');
    expect(result.remainingToPutaway).toBe(4);
    expect(result.duplicate).toBe(false);
  });
});

describe('scan putaway — over-putaway', () => {
  it('rejects putting away more than was received', async () => {
    const { service, movement } = makeService({ receivedQty: 4 });
    const error = await service
      .putaway({ ...baseInput, quantity: 6 } as never, 'usr_1')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ScanValidationError);
    expect((error as ScanValidationError).context).toMatchObject({
      requested: 6,
      outstanding: 4,
    });
    expect(movement.move).not.toHaveBeenCalled();
  });

  it('counts what was already put away, so the same pallet cannot go twice', async () => {
    // 10 received, 8 already moved out — only 2 may still be put away.
    const { service, movement } = makeService({ receivedQty: 10, transferredOutQty: 8 });
    await expect(
      service.putaway({ ...baseInput, quantity: 6 } as never, 'usr_1'),
    ).rejects.toBeInstanceOf(ScanValidationError);
    expect(movement.move).not.toHaveBeenCalled();
  });

  it('allows exactly the outstanding quantity', async () => {
    const { service, movement } = makeService({ receivedQty: 10, transferredOutQty: 4 });
    await service.putaway({ ...baseInput, quantity: 6 } as never, 'usr_1');
    expect(movement.move).toHaveBeenCalled();
  });
});

describe('scan putaway — rejections', () => {
  it('surfaces an unknown bin barcode as a 404', async () => {
    const { service } = makeService({ binThrows: new BinNotFoundError('BIN-NOPE') });
    await expect(
      service.putaway({ ...baseInput, binBarcodeRaw: 'BIN-NOPE' } as never, 'usr_1'),
    ).rejects.toBeInstanceOf(BinNotFoundError);
  });

  it('refuses when the product has no recorded receipt to move from', async () => {
    const { service } = makeService({ lastReceiveLocationId: null });
    await expect(
      service.putaway({ ...baseInput } as never, 'usr_1'),
    ).rejects.toBeInstanceOf(ScanValidationError);
  });

  it('refuses a putaway into the bin the stock was already received into', async () => {
    const { service, movement } = makeService({ lastReceiveLocationId: 'loc_bin' });
    await expect(
      service.putaway({ ...baseInput } as never, 'usr_1'),
    ).rejects.toBeInstanceOf(ScanValidationError);
    expect(movement.move).not.toHaveBeenCalled();
  });
});

describe('scan putaway — idempotency', () => {
  it('replays the original result without moving stock again', async () => {
    const { service, movement } = makeService({ existingScan: STORED_SCAN });
    const result = await service.putaway({ ...baseInput } as never, 'usr_1');

    expect(result.duplicate).toBe(true);
    expect(movement.move).not.toHaveBeenCalled();
  });
});
