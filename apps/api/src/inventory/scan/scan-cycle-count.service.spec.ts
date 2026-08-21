import { describe, expect, it, vi } from 'vitest';

import { ScanCycleCountService } from './scan-cycle-count.service';
import { CycleCountStateError } from './scan.errors';

/**
 * A stateful fake: `complete` and `approve` both read the session back through
 * `view()` after mutating it, so the mock has to behave like a row rather than a
 * fixed value.
 */
function makeService(
  opts: {
    status?: 'IN_PROGRESS' | 'PENDING_REVIEW' | 'APPROVED';
    /** Ledger-derived on-hand at the bin, by product. */
    expected?: Record<string, number>;
    /** Counted quantities from the session's scans, by product. */
    counted?: Record<string, number>;
    /** Live ledger state at approval time, if it drifted from `expected`. */
    liveAtApproval?: Record<string, number>;
    openSession?: { id: string; status: string } | null;
  } = {},
) {
  const expected = opts.expected ?? { prd_1: 10 };
  const counted = opts.counted ?? { prd_1: 8 };

  const variances: {
    id: string;
    productId: string;
    expectedQty: number;
    countedQty: number;
    deltaQty: number;
    ledgerEntryId: string | null;
    product: { code: string; name: string };
  }[] = [];

  const session = {
    id: 'ccs_1',
    locationId: 'loc_bin',
    status: opts.status ?? 'IN_PROGRESS',
    countedById: 'usr_counter',
    approvedById: null as string | null,
    startedAt: new Date('2026-08-20T09:00:00Z'),
    completedAt: null as Date | null,
    approvedAt: null as Date | null,
    notes: null as string | null,
    location: { name: 'Rack A1' },
    variances,
  };

  let queryRawCalls = 0;
  const posts: Record<string, unknown>[] = [];

  const client = {
    cycleCountSession: {
      findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
        // `start` probes for an already-open session on the same bin.
        if ('status' in (args.where ?? {})) return opts.openSession ?? null;
        return session;
      }),
      create: vi.fn(async () => session),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(session, data);
        return session;
      }),
    },
    cycleCountVariance: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        variances.push({
          ...(data as never),
          ledgerEntryId: null,
          product: {
            code: `CODE-${String(data.productId)}`,
            name: `Product ${String(data.productId)}`,
          },
        });
        return data;
      }),
      findMany: vi.fn(async () => variances),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { ledgerEntryId: string };
        }) => {
          const v = variances.find((x) => x.id === where.id);
          if (v) v.ledgerEntryId = data.ledgerEntryId;
          return v;
        },
      ),
    },
    scanEvent: {
      groupBy: vi.fn(async () =>
        Object.entries(counted).map(([productId, qty]) => ({
          productId,
          _sum: { quantity: qty },
        })),
      ),
      create: vi.fn(async () => ({})),
    },
    product: {
      findMany: vi.fn(async () =>
        Object.keys(counted).map((id) => ({ id, name: `Product ${id}` })),
      ),
    },
    // expectedByProduct — first call is the count, later calls are the live
    // re-check at approval time.
    $queryRaw: vi.fn(async () => {
      queryRawCalls += 1;
      const source = queryRawCalls === 1 ? expected : (opts.liveAtApproval ?? expected);
      return Object.entries(source).map(([product_id, qty]) => ({
        product_id,
        qty: BigInt(qty),
      }));
    }),
  };

  const resolve = {
    resolveBin: vi.fn(async () => ({
      id: 'loc_bin',
      name: 'Rack A1',
      rackNo: null,
      barcode: 'BIN-A1',
    })),
    resolveBarcode: vi.fn(async () => ({ id: 'prd_1', code: 'HD-000123', name: 'Vase' })),
  } as never;

  const ledger = {
    post: vi.fn(async (input: Record<string, unknown>) => {
      posts.push(input);
      return `sle_${posts.length}`;
    }),
  } as never;

  const locations = {
    require: vi.fn(async () => ({ id: 'loc_bin', name: 'Rack A1' })),
  } as never;
  const audit = { record: vi.fn(async () => undefined) } as never;

  const service = new ScanCycleCountService(
    { client, currentTenantId: 'ten_1' } as never,
    resolve,
    ledger,
    locations,
    audit,
  );
  return { service, client, posts, variances, session };
}

describe('cycle count — start', () => {
  it('opens a session for the scanned bin', async () => {
    const { service, client } = makeService();
    const result = await service.start(
      { binBarcodeRaw: 'BIN-A1', deviceId: 'handset-7' } as never,
      'usr_counter',
    );

    expect(client.cycleCountSession.create).toHaveBeenCalled();
    expect(result.locationName).toBe('Rack A1');
  });

  it('refuses a second concurrent count of the same bin', async () => {
    const { service } = makeService({
      openSession: { id: 'ccs_old', status: 'IN_PROGRESS' },
    });
    await expect(
      service.start(
        { binBarcodeRaw: 'BIN-A1', deviceId: 'handset-7' } as never,
        'usr_counter',
      ),
    ).rejects.toBeInstanceOf(CycleCountStateError);
  });
});

describe('cycle count — scanning', () => {
  it('records the scan and touches the ledger not at all', async () => {
    const { service, client, posts } = makeService();
    await service.scan(
      'ccs_1',
      {
        barcodeRaw: '001',
        quantity: 4,
        deviceId: 'handset-7',
        clientUuid: '55555555-5555-4555-8555-555555555555',
      } as never,
      'usr_counter',
    );

    expect(client.scanEvent.create).toHaveBeenCalled();
    expect(posts).toHaveLength(0);
  });

  it('refuses scans once the count has been completed', async () => {
    const { service } = makeService({ status: 'PENDING_REVIEW' });
    await expect(
      service.scan(
        'ccs_1',
        {
          barcodeRaw: '001',
          quantity: 4,
          deviceId: 'handset-7',
          clientUuid: '55555555-5555-4555-8555-555555555555',
        } as never,
        'usr_counter',
      ),
    ).rejects.toBeInstanceOf(CycleCountStateError);
  });
});

describe('cycle count — complete', () => {
  it('derives expected from the ledger, not from the scans', async () => {
    const { service, client, posts, variances } = makeService({
      expected: { prd_1: 10 },
      counted: { prd_1: 8 },
    });
    await service.complete('ccs_1', 'usr_counter');

    expect(variances[0]).toMatchObject({ expectedQty: 10, countedQty: 8, deltaQty: -2 });
    // Expected came from the ledger query, and nothing was posted.
    expect(client.$queryRaw).toHaveBeenCalled();
    expect(posts).toHaveLength(0);
  });

  it('records a variance for stock the ledger holds but nobody counted', async () => {
    const { service, variances } = makeService({
      expected: { prd_1: 10, prd_ghost: 6 },
      counted: { prd_1: 10 },
    });
    await service.complete('ccs_1', 'usr_counter');

    const ghost = variances.find((v) => v.productId === 'prd_ghost');
    // The most important variance there is: it is on the books and not on the
    // shelf. Counting only what was scanned would hide it entirely.
    expect(ghost).toMatchObject({ expectedQty: 6, countedQty: 0, deltaQty: -6 });
  });

  it('records found stock the ledger does not know about', async () => {
    const { service, variances } = makeService({
      expected: {},
      counted: { prd_new: 3 },
    });
    await service.complete('ccs_1', 'usr_counter');
    expect(variances[0]).toMatchObject({ expectedQty: 0, countedQty: 3, deltaQty: 3 });
  });

  it('moves the session to review without writing to the ledger', async () => {
    const { service, session, posts } = makeService();
    await service.complete('ccs_1', 'usr_counter');

    expect(session.status).toBe('PENDING_REVIEW');
    expect(posts).toHaveLength(0);
  });
});

describe('cycle count — approve', () => {
  it('posts one signed ADJUSTMENT per non-zero variance', async () => {
    const { service, posts, session } = makeService({
      expected: { prd_1: 10, prd_2: 4 },
      counted: { prd_1: 8, prd_2: 4 },
    });
    await service.complete('ccs_1', 'usr_counter');
    await service.approve('ccs_1', 'usr_manager');

    // prd_1 is short by 2; prd_2 agreed exactly and must not produce a row.
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      txnType: 'ADJUSTMENT',
      productId: 'prd_1',
      signedQty: -2,
      locationId: 'loc_bin',
    });
    expect(session.status).toBe('APPROVED');
    expect(session.approvedById).toBe('usr_manager');
  });

  it('posts a positive adjustment for found stock', async () => {
    const { service, posts } = makeService({
      expected: { prd_1: 5 },
      counted: { prd_1: 9 },
    });
    await service.complete('ccs_1', 'usr_counter');
    await service.approve('ccs_1', 'usr_manager');

    expect(posts[0]).toMatchObject({ signedQty: 4 });
  });

  it('refuses to approve a count that has not been completed', async () => {
    const { service } = makeService({ status: 'IN_PROGRESS' });
    await expect(service.approve('ccs_1', 'usr_manager')).rejects.toBeInstanceOf(
      CycleCountStateError,
    );
  });

  it('refuses to approve twice', async () => {
    const { service } = makeService({ status: 'APPROVED' });
    await expect(service.approve('ccs_1', 'usr_manager')).rejects.toBeInstanceOf(
      CycleCountStateError,
    );
  });

  it('refuses a stale variance when the bin moved after the count', async () => {
    const { service, posts } = makeService({
      expected: { prd_1: 10 },
      counted: { prd_1: 8 },
      liveAtApproval: { prd_1: 7 }, // someone picked from the bin meanwhile
    });
    await service.complete('ccs_1', 'usr_counter');

    const error = await service.approve('ccs_1', 'usr_manager').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CycleCountStateError);
    expect((error as Error).message).toContain('Recount');
    // Nothing posted — applying a stale delta would write a number nobody counted.
    expect(posts).toHaveLength(0);
  });
});
