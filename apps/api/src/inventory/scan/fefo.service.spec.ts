import { describe, expect, it, vi } from 'vitest';

import { FefoService } from './fefo.service';
import { InsufficientStockError } from '../inventory.errors';

/** `$queryRaw` returns snake_case rows exactly as Postgres does. */
function makeService(rows: Record<string, unknown>[]) {
  const queryRaw = vi.fn(async () => rows);
  const service = new FefoService({ client: { $queryRaw: queryRaw } } as never);
  return { service, queryRaw };
}

const batch = (
  expiry: string | null,
  qty: number,
  extra: Record<string, unknown> = {},
) => ({
  batch_number: expiry ? `B-${expiry.slice(0, 4)}` : null,
  expiry_date: expiry ? new Date(expiry) : null,
  qty: BigInt(qty),
  ...extra,
});

describe('batchesAt', () => {
  it('maps grouped ledger rows into batch balances', async () => {
    const { service } = makeService([batch('2026-12-01', 5), batch('2027-06-01', 9)]);
    const result = await service.batchesAt('prd_1', 'loc_1');

    expect(result).toEqual([
      { batchNumber: 'B-2026', expiryDate: new Date('2026-12-01'), qty: 5 },
      { batchNumber: 'B-2027', expiryDate: new Date('2027-06-01'), qty: 9 },
    ]);
  });
});

describe('allocate — first expired, first out', () => {
  it('takes the whole quantity from the oldest batch when it can cover it', async () => {
    const { service } = makeService([batch('2026-12-01', 10), batch('2027-06-01', 10)]);
    const allocations = await service.allocate('prd_1', 'loc_1', 4);

    expect(allocations).toHaveLength(1);
    expect(allocations[0]).toMatchObject({ batchNumber: 'B-2026', qty: 4 });
  });

  it('splits across batches, oldest first, when one cannot cover it', async () => {
    const { service } = makeService([batch('2026-12-01', 3), batch('2027-06-01', 10)]);
    const allocations = await service.allocate('prd_1', 'loc_1', 8);

    // Drain the near-expiry batch entirely before touching the fresher one.
    expect(allocations.map((a) => [a.batchNumber, a.qty])).toEqual([
      ['B-2026', 3],
      ['B-2027', 5],
    ]);
  });

  it('refuses to partially allocate a short position', async () => {
    const { service } = makeService([batch('2026-12-01', 3)]);
    const error = await service.allocate('prd_1', 'loc_1', 8).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InsufficientStockError);
    expect((error as InsufficientStockError).context).toMatchObject({
      available: 3,
      requested: 8,
    });
  });
});

describe('allocateForPick — warehouse-wide, expiry-aware', () => {
  const located = (expiry: string | null, qty: number, locationId: string) => ({
    ...batch(expiry, qty),
    location_id: locationId,
  });

  it('draws from the earliest-expiring batch regardless of location', async () => {
    const { service } = makeService([
      located('2026-09-01', 4, 'loc_a'),
      located('2027-01-01', 10, 'loc_b'),
    ]);
    const allocations = await service.allocateForPick('prd_1', 6, new Date('2026-08-20'));

    expect(allocations.map((a) => [a.locationId, a.qty])).toEqual([
      ['loc_a', 4],
      ['loc_b', 2],
    ]);
  });

  it('never ships an already-expired batch', async () => {
    const { service } = makeService([
      located('2026-01-01', 50, 'loc_a'), // expired
      located('2027-01-01', 10, 'loc_b'),
    ]);
    const allocations = await service.allocateForPick(
      'prd_1',
      10,
      new Date('2026-08-20'),
    );

    expect(allocations).toEqual([
      expect.objectContaining({ locationId: 'loc_b', qty: 10 }),
    ]);
  });

  it('explains that stock exists but is not shippable when only expired stock remains', async () => {
    const { service } = makeService([located('2026-01-01', 50, 'loc_a')]);
    const error = await service
      .allocateForPick('prd_1', 5, new Date('2026-08-20'))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InsufficientStockError);
    expect((error as Error).message).toContain('excluded as expired');
    expect((error as InsufficientStockError).context).toMatchObject({
      expiredExcluded: 50,
    });
  });

  it('treats undated stock as usable, but only after dated stock', async () => {
    const { service } = makeService([
      located('2027-01-01', 2, 'loc_a'),
      located(null, 10, 'loc_b'),
    ]);
    const allocations = await service.allocateForPick('prd_1', 5, new Date('2026-08-20'));

    // Dated batch first — undated stock must not let a dated batch age out.
    expect(allocations.map((a) => [a.locationId, a.qty])).toEqual([
      ['loc_a', 2],
      ['loc_b', 3],
    ]);
  });
});
