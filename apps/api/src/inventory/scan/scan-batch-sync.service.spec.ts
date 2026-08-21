import { PERMISSIONS } from '@procureflow/shared';
import { describe, expect, it, vi } from 'vitest';

import { ScanBatchSyncService } from './scan-batch-sync.service';
import { ScanValidationError } from './scan.errors';

const ALL_PERMS = [
  PERMISSIONS.STORES_RECEIVE_GOODS,
  PERMISSIONS.INVENTORY_SCAN,
  PERMISSIONS.INVENTORY_FULFILL,
];

const uuid = (n: number) => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;

/** A valid receive payload, minus the clientUuid the envelope supplies. */
const receivePayload = {
  barcodeRaw: '0012345678905',
  quantity: 5,
  locationId: 'loc_dock',
  deviceId: 'handset-7',
  purchaseOrderId: 'po_1',
  nonPoReceipt: false,
};

const pickPayload = {
  orderId: 'AMZ-1001',
  barcodeRaw: '0012345678905',
  quantity: 2,
  deviceId: 'handset-7',
};

function makeService(opts: { known?: string[]; pickThrows?: Error } = {}) {
  const known = new Set(opts.known ?? []);

  const prisma = {
    client: {
      scanEvent: {
        findFirst: vi.fn(async ({ where }: { where: { clientUuid: string } }) =>
          known.has(where.clientUuid) ? { id: 'scn_old', scanType: 'RECEIVE' } : null,
        ),
      },
    },
    // The real thing opens a fresh transaction per item; running the callback
    // is enough to prove isolation is *attempted* per item.
    runInTenantContext: vi.fn(async (_tenantId: string, fn: () => Promise<unknown>) =>
      fn(),
    ),
  };

  const receive = {
    receive: vi.fn(async () => ({
      ledgerEntry: { qty: 5 },
      currentStockLevel: 30,
    })),
  };
  const pick = {
    pick: vi.fn(async () => {
      if (opts.pickThrows) throw opts.pickThrows;
      return { scanEvent: { quantity: 2 }, line: { remaining: 1 } };
    }),
  };
  const putaway = {
    putaway: vi.fn(async () => ({
      binLocation: { name: 'Rack A1' },
      remainingToPutaway: 0,
    })),
  };
  const cycleCount = { scan: vi.fn(async () => ({ id: 'ccs_1' })) };
  const transfer = {
    transfer: vi.fn(async () => ({
      scanEvent: { quantity: 3 },
      sourceBin: { name: 'A1' },
      destBin: { name: 'B2' },
    })),
  };

  const service = new ScanBatchSyncService(
    prisma as never,
    receive as never,
    putaway as never,
    pick as never,
    cycleCount as never,
    transfer as never,
  );
  return { service, prisma, receive, pick, putaway, cycleCount, transfer };
}

describe('batch sync — partial processing', () => {
  it('processes a mixed batch and keeps results aligned to the request order', async () => {
    const { service, receive, pick } = makeService({
      known: [uuid(2)],
      pickThrows: new ScanValidationError(
        'Cannot pick 2: only 1 remain on order AMZ-1001.',
      ),
    });

    const result = await service.sync(
      {
        scans: [
          { type: 'RECEIVE', payload: receivePayload, clientUuid: uuid(1) },
          { type: 'RECEIVE', payload: receivePayload, clientUuid: uuid(2) }, // already synced
          { type: 'PICK', payload: pickPayload, clientUuid: uuid(3) }, // over-pick
          { type: 'RECEIVE', payload: receivePayload, clientUuid: uuid(4) },
        ],
      } as never,
      'usr_1',
      'ten_1',
      ALL_PERMS,
    );

    expect(result.results.map((r) => r.status)).toEqual([
      'success',
      'duplicate',
      'error',
      'success',
    ]);
    // Index-aligned *and* keyed, so the client can zip either way.
    expect(result.results.map((r) => r.clientUuid)).toEqual([
      uuid(1),
      uuid(2),
      uuid(3),
      uuid(4),
    ]);
    expect(result.summary).toEqual({ total: 4, succeeded: 2, duplicates: 1, failed: 1 });

    // The failure in the middle did not stop the item behind it.
    expect(receive.receive).toHaveBeenCalledTimes(2);
    expect(pick.pick).toHaveBeenCalledTimes(1);
  });

  it('reports an already-synced scan as duplicate, never as an error', async () => {
    const { service, receive } = makeService({ known: [uuid(1)] });
    const result = await service.sync(
      {
        scans: [{ type: 'RECEIVE', payload: receivePayload, clientUuid: uuid(1) }],
      } as never,
      'usr_1',
      'ten_1',
      ALL_PERMS,
    );

    expect(result.results[0].status).toBe('duplicate');
    // An error would keep it in the device queue forever.
    expect(receive.receive).not.toHaveBeenCalled();
  });

  it('runs each scan in its own transaction so one rollback cannot take the batch', async () => {
    const { service, prisma } = makeService();
    await service.sync(
      {
        scans: [
          { type: 'RECEIVE', payload: receivePayload, clientUuid: uuid(1) },
          { type: 'RECEIVE', payload: receivePayload, clientUuid: uuid(2) },
        ],
      } as never,
      'usr_1',
      'ten_1',
      ALL_PERMS,
    );

    expect(prisma.runInTenantContext).toHaveBeenCalledTimes(2);
  });
});

describe('batch sync — validation', () => {
  it('fails one malformed item with field-level issues and keeps the rest', async () => {
    const { service, receive } = makeService();
    const result = await service.sync(
      {
        scans: [
          // quantity must be a positive integer
          {
            type: 'RECEIVE',
            payload: { ...receivePayload, quantity: 0 },
            clientUuid: uuid(1),
          },
          { type: 'RECEIVE', payload: receivePayload, clientUuid: uuid(2) },
        ],
      } as never,
      'usr_1',
      'ten_1',
      ALL_PERMS,
    );

    expect(result.results[0].status).toBe('error');
    expect(result.results[0].issues?.[0]?.path).toBe('quantity');
    expect(result.results[1].status).toBe('success');
    expect(receive.receive).toHaveBeenCalledTimes(1);
  });

  it('rejects a cycle-count item that names no session', async () => {
    const { service } = makeService();
    const result = await service.sync(
      {
        scans: [
          {
            type: 'CYCLE_COUNT',
            payload: { barcodeRaw: '001', quantity: 2, deviceId: 'handset-7' },
            clientUuid: uuid(1),
          },
        ],
      } as never,
      'usr_1',
      'ten_1',
      ALL_PERMS,
    );

    expect(result.results[0].status).toBe('error');
    expect(result.results[0].detail).toContain('session');
  });
});

describe('batch sync — authorisation', () => {
  it('refuses an item the caller lacks the permission for', async () => {
    const { service, receive, putaway } = makeService();
    const result = await service.sync(
      {
        scans: [
          { type: 'RECEIVE', payload: receivePayload, clientUuid: uuid(1) },
          {
            type: 'PUTAWAY',
            payload: {
              barcodeRaw: '001',
              binBarcodeRaw: 'BIN-A1',
              quantity: 2,
              deviceId: 'handset-7',
            },
            clientUuid: uuid(2),
          },
        ],
      } as never,
      'usr_1',
      'ten_1',
      // Scanner operator with no receiving authority.
      [PERMISSIONS.INVENTORY_SCAN],
    );

    // The queue is not a way around the guard on /scan/receive.
    expect(result.results[0].status).toBe('error');
    expect(result.results[0].detail).toContain(PERMISSIONS.STORES_RECEIVE_GOODS);
    expect(receive.receive).not.toHaveBeenCalled();
    // The item they *are* allowed to sync still goes through.
    expect(result.results[1].status).toBe('success');
    expect(putaway.putaway).toHaveBeenCalledTimes(1);
  });
});
