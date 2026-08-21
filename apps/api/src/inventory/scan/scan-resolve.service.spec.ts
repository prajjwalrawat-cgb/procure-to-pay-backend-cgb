import { describe, expect, it, vi } from 'vitest';

import { ScanResolveService } from './scan-resolve.service';
import { BarcodeNotFoundError, BinNotFoundError } from './scan.errors';

const PRODUCT = {
  id: 'prd_1',
  code: 'HD-000123',
  name: 'Ceramic Vase',
  category: 'Home Decor',
  colour: 'Blue',
  unit: 'pcs',
  barcode: '0012345678905',
  imageUrl: null,
  requiresBatchTracking: false,
  item: null,
};

/**
 * The service tries its four strategies in order, one `findFirst` each, so a
 * queue of responses reproduces "matched at step N" exactly.
 */
function makeService(findFirstResults: unknown[], opts: { totalStock?: number } = {}) {
  const findFirst = vi.fn();
  for (const result of findFirstResults) findFirst.mockResolvedValueOnce(result);
  findFirst.mockResolvedValue(null);

  const locationFindFirst = vi.fn().mockResolvedValue(null);
  const client = {
    product: { findFirst },
    location: { findFirst: locationFindFirst },
  };
  const ledger = { totalStock: vi.fn(async () => opts.totalStock ?? 0) } as never;

  const service = new ScanResolveService({ client } as never, ledger);
  return { service, findFirst, locationFindFirst };
}

describe('resolveBarcode — match strategies', () => {
  it('matches the printed barcode first', async () => {
    const { service, findFirst } = makeService([PRODUCT]);
    const result = await service.resolveBarcode('0012345678905');

    expect(result.matchType).toBe('exact_barcode');
    expect(result.id).toBe('prd_1');
    // Nothing else was tried — the first strategy settled it.
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it('falls back to the internal warehouse SKU when no barcode matches', async () => {
    const { service } = makeService([null, PRODUCT]);
    const result = await service.resolveBarcode('HD-000123');
    expect(result.matchType).toBe('exact_sku_code');
  });

  it('falls back to the bridged procurement item SKU', async () => {
    const { service } = makeService([null, null, PRODUCT]);
    const result = await service.resolveBarcode('SKU-9');
    expect(result.matchType).toBe('exact_sku_code');
  });

  it('matches a UPC-A scan against an EAN-13 on file via GTIN padding', async () => {
    const { service, findFirst } = makeService([null, null, null, PRODUCT]);
    const result = await service.resolveBarcode('012345678905');

    expect(result.matchType).toBe('fuzzy_gtin');
    // The fuzzy pass searched the padded variants, not the raw value alone.
    const fuzzyCall = findFirst.mock.calls[3]?.[0] as {
      where: { barcode: { in: string[] } };
    };
    expect(fuzzyCall.where.barcode.in).toContain('0012345678905');
  });

  it('skips the fuzzy pass entirely for a non-numeric code', async () => {
    const { service, findFirst } = makeService([null, null, null]);
    await expect(service.resolveBarcode('ABC-XYZ')).rejects.toBeInstanceOf(
      BarcodeNotFoundError,
    );
    // Three exact strategies, and no fourth — a letter code has no GTIN form.
    expect(findFirst).toHaveBeenCalledTimes(3);
  });
});

describe('resolveBarcode — not found', () => {
  it('throws a 404 carrying the raw value so the UI can offer a fallback', async () => {
    const { service } = makeService([]);
    const error = await service
      .resolveBarcode('  9999999999999  ')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BarcodeNotFoundError);
    expect((error as BarcodeNotFoundError).status).toBe(404);
    // Trimmed, but otherwise exactly what was scanned.
    expect((error as BarcodeNotFoundError).context).toEqual({
      barcodeRaw: '9999999999999',
    });
  });
});

describe('resolveBarcode — batch requirement', () => {
  it('inherits requiresBatch from the bridged procurement item', async () => {
    const { service } = makeService([{ ...PRODUCT, item: { requiresBatch: true } }]);
    const result = await service.resolveBarcode('0012345678905');
    // The product's own flag is false; the item master says otherwise, and the
    // stricter of the two wins.
    expect(result.requiresBatchTracking).toBe(true);
  });

  it('honours the product flag when there is no bridged item', async () => {
    const { service } = makeService([{ ...PRODUCT, requiresBatchTracking: true }]);
    const result = await service.resolveBarcode('0012345678905');
    expect(result.requiresBatchTracking).toBe(true);
  });
});

describe('resolveView', () => {
  it('returns the product card with live on-hand stock', async () => {
    const { service } = makeService([PRODUCT], { totalStock: 42 });
    const view = await service.resolveView('0012345678905');

    expect(view.matchType).toBe('exact_barcode');
    expect(view.product).toMatchObject({ code: 'HD-000123', currentStock: 42 });
  });
});

describe('resolveBin', () => {
  it('resolves a bin by its label', async () => {
    const { service, locationFindFirst } = makeService([]);
    locationFindFirst.mockResolvedValueOnce({
      id: 'loc_1',
      name: 'Rack A1',
      rackNo: 'A1',
      barcode: 'BIN-A1',
    });

    await expect(service.resolveBin('BIN-A1')).resolves.toMatchObject({ id: 'loc_1' });
  });

  it('throws a 404 carrying the scanned bin label', async () => {
    const { service } = makeService([]);
    const error = await service.resolveBin('BIN-NOPE').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BinNotFoundError);
    expect((error as BinNotFoundError).context).toEqual({ binBarcodeRaw: 'BIN-NOPE' });
  });
});
