import { describe, expect, it, vi } from 'vitest';

import { ScanTransferService } from './scan-transfer.service';
import { ScanValidationError } from './scan.errors';

const baseInput = {
  barcodeRaw: '0012345678905',
  sourceBinBarcodeRaw: 'BIN-A1',
  destBinBarcodeRaw: 'BIN-B2',
  quantity: 4,
  deviceId: 'handset-7',
  clientUuid: '44444444-4444-4444-8444-444444444444',
} as const;

const STORED_SCAN = {
  id: 'scn_4',
  scanType: 'TRANSFER',
  productId: 'prd_1',
  quantity: 4,
  locationId: 'loc_b',
  clientUuid: baseInput.clientUuid,
  ledgerEntryId: 'sle_out',
  createdAt: new Date('2026-08-20T10:00:00Z'),
  syncedAt: new Date('2026-08-20T10:00:00Z'),
};

function makeService(
  opts: { existingScan?: unknown; available?: number; sameBin?: boolean } = {},
) {
  const bins: Record<
    string,
    { id: string; name: string; rackNo: null; barcode: string }
  > = {
    'BIN-A1': { id: 'loc_a', name: 'Rack A1', rackNo: null, barcode: 'BIN-A1' },
    'BIN-B2': {
      id: opts.sameBin ? 'loc_a' : 'loc_b',
      name: opts.sameBin ? 'Rack A1' : 'Rack B2',
      rackNo: null,
      barcode: 'BIN-B2',
    },
  };

  const client = {
    scanEvent: {
      findFirst: vi.fn(async () => opts.existingScan ?? null),
      create: vi.fn(async () => STORED_SCAN),
    },
    location: { findUnique: vi.fn(async () => ({ id: 'loc_b', name: 'Rack B2' })) },
    stockLedgerEntry: {
      findUnique: vi.fn(async () => ({
        locationId: 'loc_a',
        location: { name: 'Rack A1' },
      })),
    },
  };

  const resolve = {
    resolveBarcode: vi.fn(async () => ({ id: 'prd_1', code: 'HD-000123', name: 'Vase' })),
    resolveBin: vi.fn(async (raw: string) => bins[raw]),
  } as never;

  const movement = {
    move: vi.fn(async () => ({
      outEntryIds: ['sle_out'],
      inEntryIds: ['sle_in'],
      allocations: [{ batchNumber: 'B-1', expiryDate: null, qty: 4 }],
    })),
  };

  const fefo = { availableAt: vi.fn(async () => opts.available ?? 10) } as never;

  const service = new ScanTransferService(
    { client, currentTenantId: 'ten_1' } as never,
    resolve,
    movement as never,
    fefo,
  );
  return { service, movement };
}

describe('scan transfer — happy path', () => {
  it('writes both legs through one movement call', async () => {
    const { service, movement } = makeService();
    const result = await service.transfer({ ...baseInput } as never, 'usr_1');

    expect(movement.move).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: 'prd_1',
        fromLocationId: 'loc_a',
        toLocationId: 'loc_b',
        qty: 4,
      }),
    );
    // Both legs, or neither — they are produced by a single call inside the
    // request transaction.
    expect(result.outEntryId).toBe('sle_out');
    expect(result.inEntryId).toBe('sle_in');
    expect(result.sourceBin.name).toBe('Rack A1');
    expect(result.destBin.name).toBe('Rack B2');
  });
});

describe('scan transfer — rejections', () => {
  it('refuses when the source bin holds less than the requested quantity', async () => {
    const { service, movement } = makeService({ available: 2 });
    const error = await service
      .transfer({ ...baseInput, quantity: 4 } as never, 'usr_1')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ScanValidationError);
    expect((error as ScanValidationError).context).toMatchObject({
      available: 2,
      requested: 4,
    });
    expect(movement.move).not.toHaveBeenCalled();
  });

  it('refuses a no-op when two labels resolve to the same bin', async () => {
    const { service, movement } = makeService({ sameBin: true });
    const error = await service
      .transfer({ ...baseInput } as never, 'usr_1')
      .catch((e: unknown) => e);

    // Explicitly an error, never a silent success — the operator must know the
    // stock did not move.
    expect(error).toBeInstanceOf(ScanValidationError);
    expect((error as Error).message).toContain('nothing to transfer');
    expect(movement.move).not.toHaveBeenCalled();
  });
});

describe('scan transfer — idempotency', () => {
  it('replays a queued transfer without moving stock twice', async () => {
    const { service, movement } = makeService({ existingScan: STORED_SCAN });
    const result = await service.transfer({ ...baseInput } as never, 'usr_1');

    expect(result.duplicate).toBe(true);
    expect(movement.move).not.toHaveBeenCalled();
  });
});
