import { describe, expect, it, vi } from 'vitest';

import { ScanReceiveService } from './scan-receive.service';
import { BarcodeNotFoundError, ScanValidationError } from './scan.errors';

const baseInput = {
  barcodeRaw: '0012345678905',
  quantity: 10,
  locationId: 'loc_dock',
  deviceId: 'handset-7',
  clientUuid: '11111111-1111-4111-8111-111111111111',
  nonPoReceipt: false,
  purchaseOrderId: 'po_1',
} as const;

const STORED_SCAN = {
  id: 'scn_1',
  scanType: 'RECEIVE',
  productId: 'prd_1',
  quantity: 10,
  locationId: 'loc_dock',
  clientUuid: baseInput.clientUuid,
  ledgerEntryId: 'sle_1',
  createdAt: new Date('2026-08-20T10:00:00Z'),
  syncedAt: new Date('2026-08-20T10:00:00Z'),
};

function makeService(
  opts: {
    existingScan?: unknown;
    requiresBatchTracking?: boolean;
    resolveThrows?: Error;
    createThrows?: Error;
  } = {},
) {
  const scanCreate = vi.fn(async () => STORED_SCAN);
  if (opts.createThrows) scanCreate.mockRejectedValueOnce(opts.createThrows as never);

  const scanFindFirst = vi.fn(async () => opts.existingScan ?? null);

  const client = {
    scanEvent: { findFirst: scanFindFirst, create: scanCreate },
    stockLedgerEntry: {
      findUnique: vi.fn(async () => ({
        id: 'sle_1',
        qty: 10,
        batchNumber: null,
        expiryDate: null,
      })),
      findUniqueOrThrow: vi.fn(async () => ({
        id: 'sle_1',
        qty: 10,
        batchNumber: 'B-42',
        expiryDate: new Date('2027-01-31T00:00:00Z'),
      })),
    },
  };

  const resolve = {
    resolveBarcode: vi.fn(async () => {
      if (opts.resolveThrows) throw opts.resolveThrows;
      return {
        id: 'prd_1',
        code: 'HD-000123',
        name: 'Ceramic Vase',
        requiresBatchTracking: opts.requiresBatchTracking ?? false,
      };
    }),
  } as never;

  const receipts = { receive: vi.fn(async () => ({ id: 'sle_1' })) };
  const ledger = {
    stockAt: vi.fn(async () => 60),
    totalStock: vi.fn(async () => 60),
  } as never;
  const locations = { require: vi.fn(async () => ({ id: 'loc_dock' })) } as never;

  const service = new ScanReceiveService(
    { client, currentTenantId: 'ten_1' } as never,
    resolve,
    receipts as never,
    ledger,
    locations,
  );
  return { service, receipts, scanCreate, scanFindFirst, client };
}

describe('scan receive — happy path', () => {
  it('writes the ledger row and the scan, and reports on-hand after', async () => {
    const { service, receipts, scanCreate } = makeService();
    const result = await service.receive({ ...baseInput } as never, 'usr_1');

    expect(receipts.receive).toHaveBeenCalledTimes(1);
    expect(scanCreate).toHaveBeenCalledTimes(1);
    expect(result.duplicate).toBe(false);
    expect(result.currentStockLevel).toBe(60);
    expect(result.scanEvent.ledgerEntryId).toBe('sle_1');
  });

  it('delegates the PO check rather than re-implementing business rule 1', async () => {
    const { service, receipts } = makeService();
    await service.receive(
      {
        ...baseInput,
        nonPoReceipt: true,
        nonPoReason: 'Challan only',
        purchaseOrderId: null,
      } as never,
      'usr_1',
    );

    // The scan hands the override straight to the receipt service, which owns
    // the rule — the scanner is not a bypass around it.
    expect(receipts.receive).toHaveBeenCalledWith(
      expect.objectContaining({ nonPoReceipt: true, nonPoReason: 'Challan only' }),
      'usr_1',
    );
  });

  it('dates the ledger row from the scan, not from when it synced', async () => {
    const { service, receipts } = makeService();
    await service.receive(
      { ...baseInput, clientTimestamp: '2026-08-19T06:30:00.000Z' } as never,
      'usr_1',
    );

    expect(receipts.receive).toHaveBeenCalledWith(
      expect.objectContaining({ txnDate: '2026-08-19T06:30:00.000Z' }),
      'usr_1',
    );
  });
});

describe('scan receive — idempotency', () => {
  it('returns the original result for a replayed clientUuid and posts nothing', async () => {
    const { service, receipts, scanCreate } = makeService({ existingScan: STORED_SCAN });
    const result = await service.receive({ ...baseInput } as never, 'usr_1');

    expect(result.duplicate).toBe(true);
    expect(result.scanEvent.id).toBe('scn_1');
    // The whole point: no second ledger row.
    expect(receipts.receive).not.toHaveBeenCalled();
    expect(scanCreate).not.toHaveBeenCalled();
  });

  it('recovers when a concurrent replay wins the insert race', async () => {
    const uniqueViolation = Object.assign(new Error('unique'), {
      code: 'P2002',
      meta: { target: ['tenant_id', 'client_uuid'] },
    });
    const { service, scanFindFirst } = makeService({ createThrows: uniqueViolation });
    // First lookup finds nothing (so we proceed), the post-race lookup finds the
    // winner's row.
    scanFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(STORED_SCAN as never);

    const result = await service.receive({ ...baseInput } as never, 'usr_1');
    expect(result.duplicate).toBe(true);
    expect(result.scanEvent.id).toBe('scn_1');
  });
});

describe('scan receive — batch tracking', () => {
  it('rejects a batch-tracked receipt with no expiry, rather than defaulting one', async () => {
    const { service, receipts } = makeService({ requiresBatchTracking: true });
    const error = await service
      .receive({ ...baseInput, batchNumber: 'B-42' } as never, 'usr_1')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ScanValidationError);
    expect((error as ScanValidationError).status).toBe(422);
    expect((error as ScanValidationError).context).toMatchObject({
      missing: 'expiryDate',
    });
    expect(receipts.receive).not.toHaveBeenCalled();
  });

  it('rejects a batch-tracked receipt with no batch number', async () => {
    const { service } = makeService({ requiresBatchTracking: true });
    const error = await service
      .receive({ ...baseInput, expiryDate: '2027-01-31T00:00:00.000Z' } as never, 'usr_1')
      .catch((e: unknown) => e);

    expect((error as ScanValidationError).context).toMatchObject({
      missing: 'batchNumber',
    });
  });

  it('accepts a batch-tracked receipt that carries both, and passes them through', async () => {
    const { service, receipts } = makeService({ requiresBatchTracking: true });
    const result = await service.receive(
      {
        ...baseInput,
        batchNumber: 'B-42',
        expiryDate: '2027-01-31T00:00:00.000Z',
      } as never,
      'usr_1',
    );

    expect(receipts.receive).toHaveBeenCalledWith(
      expect.objectContaining({
        batchNumber: 'B-42',
        expiryDate: '2027-01-31T00:00:00.000Z',
      }),
      'usr_1',
    );
    expect(result.ledgerEntry.batchNumber).toBe('B-42');
  });

  it('does not demand batch data for an untracked product', async () => {
    const { service } = makeService({ requiresBatchTracking: false });
    await expect(
      service.receive({ ...baseInput } as never, 'usr_1'),
    ).resolves.toMatchObject({
      duplicate: false,
    });
  });
});

describe('scan receive — unknown barcode', () => {
  it('surfaces the 404 from resolution and writes nothing', async () => {
    const { service, receipts } = makeService({
      resolveThrows: new BarcodeNotFoundError('9999999999999'),
    });

    await expect(
      service.receive({ ...baseInput } as never, 'usr_1'),
    ).rejects.toBeInstanceOf(BarcodeNotFoundError);
    expect(receipts.receive).not.toHaveBeenCalled();
  });
});
