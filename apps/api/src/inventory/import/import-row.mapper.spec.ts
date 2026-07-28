import { describe, expect, it } from 'vitest';

import {
  cleaned,
  field,
  mapProductMasterRow,
  mapStockLedgerRow,
  parseBoolOrNull,
  parseDateOrNull,
  parseIntOrNull,
  parseIssueDept,
  parseQcStatus,
  presentField,
} from './import-row.mapper';

describe('field aliasing', () => {
  it('reads the canonical column', () => {
    expect(field({ product_name: 'Candle Holder' }, 'name')).toBe('Candle Holder');
  });

  it('falls back through observed aliases', () => {
    expect(field({ productname: 'A' }, 'name')).toBe('A');
    expect(field({ product: 'B' }, 'name')).toBe('B');
    // The workbook misspells Platform as "Platefrom".
    expect(field({ platefrom: 'Amazone' }, 'platform')).toBe('Amazone');
    // ...and Product Condition as "Production Condation".
    expect(field({ production_condation: 'Sealed' }, 'productCondition')).toBe('Sealed');
  });

  it('skips blank aliases and keeps looking', () => {
    expect(field({ product_name: '   ', productname: 'B' }, 'name')).toBe('B');
  });

  it('returns empty when nothing matches', () => {
    expect(field({ unrelated: 'x' }, 'name')).toBe('');
  });
});

describe('cleaned', () => {
  it.each(['', '  ', 'N/A', 'n/a', 'NA', 'nil', '-', 'none', 'null'])(
    'treats %s as empty',
    (v) => {
      expect(cleaned(v)).toBe('');
    },
  );

  it('keeps real values', () => {
    expect(cleaned('  Brass ')).toBe('Brass');
  });
});

describe('parseIntOrNull', () => {
  it('parses the float-formatted integers the workbook exports', () => {
    expect(parseIntOrNull('250.0')).toBe(250);
    expect(parseIntOrNull('950')).toBe(950);
  });

  it('strips thousands separators', () => {
    expect(parseIntOrNull('19,281')).toBe(19_281);
  });

  it('distinguishes absent from explicitly zero', () => {
    expect(parseIntOrNull('')).toBeNull();
    expect(parseIntOrNull('N/A')).toBeNull();
    expect(parseIntOrNull('0')).toBe(0);
  });

  it('returns null for non-numeric text', () => {
    expect(parseIntOrNull('many')).toBeNull();
  });

  it('handles negatives for adjustments', () => {
    expect(parseIntOrNull('-12')).toBe(-12);
  });
});

describe('parseDateOrNull', () => {
  it('parses the workbook dd/mm/yyyy format', () => {
    expect(parseDateOrNull('27/05/2026')?.toISOString()).toBe('2026-05-27T00:00:00.000Z');
  });

  it('parses Excel serial dates, which is what unformatted cells export as', () => {
    // 46028 is what the workbook stores for several transaction dates; the
    // epoch is 1899-12-30 (the 1900 leap-year bug is baked into the format).
    expect(parseDateOrNull('46028')?.toISOString().slice(0, 10)).toBe('2026-01-06');
    expect(parseDateOrNull('46087')?.toISOString().slice(0, 10)).toBe('2026-03-06');
  });

  it('parses ISO strings', () => {
    expect(parseDateOrNull('2026-05-27T00:00:00.000Z')?.toISOString()).toBe(
      '2026-05-27T00:00:00.000Z',
    );
  });

  it('returns null for blanks and junk', () => {
    expect(parseDateOrNull('N/A')).toBeNull();
    expect(parseDateOrNull('')).toBeNull();
    expect(parseDateOrNull('someday')).toBeNull();
  });
});

describe('enum coercion', () => {
  it('maps the workbook QC vocabulary', () => {
    expect(parseQcStatus('Ok')).toBe('OK');
    expect(parseQcStatus('Rejected')).toBe('REJECTED');
    expect(parseQcStatus('Approved')).toBe('OK');
    expect(parseQcStatus('')).toBeNull();
    expect(parseQcStatus('maybe')).toBeNull();
  });

  it('maps departments', () => {
    expect(parseIssueDept('Photoshoot')).toBe('PHOTOSHOOT');
    expect(parseIssueDept('sales team')).toBe('SALES');
    expect(parseIssueDept('Other Place')).toBe('OTHER');
    expect(parseIssueDept('finance')).toBeNull();
  });

  it('maps Restock Yes/No cells', () => {
    expect(parseBoolOrNull('Yes')).toBe(true);
    expect(parseBoolOrNull('N')).toBe(false);
    expect(parseBoolOrNull('')).toBeNull();
    expect(parseBoolOrNull('maybe')).toBeNull();
  });
});

describe('mapProductMasterRow', () => {
  const good = {
    product_name: 'Candle Holder',
    category: 'Home Decor',
    colour: 'Brass',
    opening_stock: '950.0',
    location: 'Store',
    rack_no: 'Rack-6',
  };

  it('maps a well-formed row', () => {
    const res = mapProductMasterRow(good);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toMatchObject({
      name: 'Candle Holder',
      category: 'Home Decor',
      colour: 'Brass',
      openingStock: 950,
      locationName: 'Store',
      rackNo: 'Rack-6',
      unit: 'pcs',
    });
  });

  it('backfills a blank category as Uncategorized — 601 of 625 source rows', () => {
    const res = mapProductMasterRow({ product_name: 'X' });
    expect(res.ok && res.value.category).toBe('Uncategorized');
  });

  it('backfills an "N/A" category too', () => {
    const res = mapProductMasterRow({ product_name: 'X', category: 'N/A' });
    expect(res.ok && res.value.category).toBe('Uncategorized');
  });

  it('collapses an "N/A" colour to null so the matching key stays stable', () => {
    const res = mapProductMasterRow({ product_name: 'X', colour: 'N/A' });
    expect(res.ok && res.value.colour).toBeNull();
  });

  it('preserves the legacy Product ID and SKU verbatim for audit', () => {
    const res = mapProductMasterRow({ product_name: 'X', product_id: 'N/A', sku: 'N/A' });
    expect(res.ok && res.value.legacyProductId).toBe('N/A');
    expect(res.ok && res.value.legacySku).toBe('N/A');
  });

  it('errors when the product name is missing', () => {
    const res = mapProductMasterRow({ category: 'Home Decor' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.issue).toMatchObject({ status: 'ERROR' });
    expect(res.issue.message).toMatch(/Product Name is required/);
  });

  it('errors on a non-numeric opening stock', () => {
    const res = mapProductMasterRow({ product_name: 'X', opening_stock: 'lots' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.issue.message).toMatch(/not a number/);
  });

  it('errors on a negative opening stock', () => {
    const res = mapProductMasterRow({ product_name: 'X', opening_stock: '-5' });
    expect(res.ok).toBe(false);
  });

  it('treats a zero damage qty as absent', () => {
    const res = mapProductMasterRow({ ...good, damage_qty: '0' });
    expect(res.ok && res.value.damageQty).toBeNull();
  });
});

describe('mapStockLedgerRow', () => {
  const good = {
    product_name: 'Umbrellas Auto Folding',
    txn_type: 'VENDOR_INWARD',
    qty: '250.0',
    location: 'Store',
    date: '30/05/2026',
    vendor: 'Ebrahim Currim And Sons',
    rate: '295.0',
    tax: '5.0',
    qc_status: 'Ok',
  };

  it('maps a well-formed row', () => {
    const res = mapStockLedgerRow(good);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toMatchObject({
      productName: 'Umbrellas Auto Folding',
      txnType: 'VENDOR_INWARD',
      qty: 250,
      locationName: 'Store',
      vendorName: 'Ebrahim Currim And Sons',
      rate: '295',
      taxPct: '5',
      qcStatus: 'OK',
    });
  });

  it('accepts a lowercase / spaced transaction type', () => {
    const res = mapStockLedgerRow({ ...good, txn_type: 'customer order out' });
    expect(res.ok && res.value.txnType).toBe('CUSTOMER_ORDER_OUT');
  });

  it('errors on an unknown transaction type and lists the valid ones', () => {
    const res = mapStockLedgerRow({ ...good, txn_type: 'TELEPORT' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.issue.message).toMatch(/Unknown transaction type/);
    expect(res.issue.message).toMatch(/VENDOR_INWARD/);
  });

  it('errors when neither name nor code identifies a product', () => {
    const res = mapStockLedgerRow({ txn_type: 'VENDOR_INWARD', qty: '1', location: 'Store' });
    expect(res.ok).toBe(false);
  });

  it('errors on a missing location', () => {
    const res = mapStockLedgerRow({ ...good, location: '' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.issue.message).toMatch(/Location is required/);
  });

  it('errors on a zero quantity', () => {
    const res = mapStockLedgerRow({ ...good, qty: '0' });
    expect(res.ok).toBe(false);
  });

  it('rejects a negative quantity on a directional type', () => {
    const res = mapStockLedgerRow({ ...good, qty: '-5' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.issue.message).toMatch(/must be positive/);
  });

  it('permits a negative quantity on an ADJUSTMENT', () => {
    const res = mapStockLedgerRow({ ...good, txn_type: 'ADJUSTMENT', qty: '-5' });
    expect(res.ok && res.value.qty).toBe(-5);
  });

  it('every mapping failure is an ERROR, never a silent skip', () => {
    for (const bad of [
      { ...good, txn_type: 'NOPE' },
      { ...good, qty: 'x' },
      { ...good, location: '' },
    ]) {
      const res = mapStockLedgerRow(bad);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.issue.status).toBe('ERROR');
    }
  });
});

describe('presentField', () => {
  it('returns a blank value when the column exists but is empty', () => {
    expect(presentField({ current_stock: '' }, 'openingStock')).toBe('');
  });

  it('returns null only when no alias column exists at all', () => {
    expect(presentField({ product_name: 'X' }, 'openingStock')).toBeNull();
  });

  it('prefers the first alias that is a column, not the first non-empty one', () => {
    // Both columns present, current_stock blank: the blank still wins, because
    // "blank Current Stock" means zero on hand, not "fall back to Opening".
    expect(presentField({ current_stock: '', opening_stock: '4' }, 'openingStock')).toBe('');
  });
});

describe('mapProductMasterRow — opening stock semantics', () => {
  it('prefers Current Stock over Opening Stock when both are present', () => {
    // Coffee Mug: 112 arrived, 111 damaged, 1 actually on the floor.
    const res = mapProductMasterRow({
      product_name: 'Coffee Mug Black With Temp.',
      opening_stock: '112',
      current_stock: '1',
      damage_qty: '111',
    });
    expect(res.ok && res.value.openingStock).toBe(1);
  });

  it('treats a blank Current Stock as zero, not as missing', () => {
    // The Halthy Binge: 4 in, 4 damaged, Current Stock left empty on the sheet.
    // Falling back to Opening Stock here would resurrect written-off units.
    const res = mapProductMasterRow({
      product_name: 'The Halthy Binge',
      opening_stock: '4',
      current_stock: '',
      damage_qty: '4',
    });
    expect(res.ok && res.value.openingStock).toBe(0);
  });

  it('falls back to Opening Stock when there is no Current Stock column', () => {
    // The generated products.csv only carries `opening_stock`, already holding
    // the authoritative Current Stock figure.
    const res = mapProductMasterRow({ product_name: 'X', opening_stock: '950' });
    expect(res.ok && res.value.openingStock).toBe(950);
  });

  it('reports no opening stock when neither column exists', () => {
    const res = mapProductMasterRow({ product_name: 'X' });
    expect(res.ok && res.value.openingStock).toBeNull();
  });

  it('still rejects a non-numeric stock value', () => {
    const res = mapProductMasterRow({ product_name: 'X', current_stock: 'lots' });
    expect(res.ok).toBe(false);
  });
});
