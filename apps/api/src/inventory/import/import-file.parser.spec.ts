import { describe, expect, it } from 'vitest';

import { ImportParseError } from '../inventory.errors';
import {
  normaliseHeader,
  parseCsv,
  parseImportFile,
  scoreHeaderRow,
  splitCsvLine,
  toCsv,
} from './import-file.parser';

const buf = (s: string): Buffer => Buffer.from(s, 'utf8');

describe('splitCsvLine', () => {
  it('splits plain fields', () => {
    expect(splitCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('keeps commas inside quoted fields', () => {
    // The legacy Remark column is full of commas — a naive split shreds it.
    expect(splitCsvLine('Candle Holder,"Carton-3, Qty-750",Brass')).toEqual([
      'Candle Holder',
      'Carton-3, Qty-750',
      'Brass',
    ]);
  });

  it('unescapes doubled quotes', () => {
    expect(splitCsvLine('a,"say ""hi""",b')).toEqual(['a', 'say "hi"', 'b']);
  });

  it('preserves empty trailing fields', () => {
    expect(splitCsvLine('a,,')).toEqual(['a', '', '']);
  });
});

describe('normaliseHeader', () => {
  it('folds spacing, case and punctuation to one key', () => {
    expect(normaliseHeader('Product Name')).toBe('product_name');
    expect(normaliseHeader('  PRODUCT   NAME ')).toBe('product_name');
    expect(normaliseHeader('Qty.')).toBe('qty');
    expect(normaliseHeader('Damage Qty.')).toBe('damage_qty');
    expect(normaliseHeader('Expiry/Waranty Date')).toBe('expiry_waranty_date');
  });
});

describe('parseCsv', () => {
  it('parses headers and rows', () => {
    const file = parseCsv(buf('Product Name,Category,Qty.\nCandle Holder,Home Decor,950'));
    expect(file.headers).toEqual(['product_name', 'category', 'qty']);
    expect(file.rows).toHaveLength(1);
    expect(file.rows[0]?.data).toEqual({
      product_name: 'Candle Holder',
      category: 'Home Decor',
      qty: '950',
    });
  });

  it('numbers rows by spreadsheet line so an error report is actionable', () => {
    const file = parseCsv(buf('name\nA\nB'));
    // Header is line 1, so the first data row is line 2.
    expect(file.rows.map((r) => r.rowNumber)).toEqual([2, 3]);
  });

  it('skips padding rows but keeps row numbers aligned to the real file lines', () => {
    //          line 1      line 2  line 3   line 4
    const file = parseCsv(buf('name,qty\nA,1\n,\nB,2'));
    expect(file.rows.map((r) => r.data.name)).toEqual(['A', 'B']);
    // B really is on line 4 — the skipped padding row does not shift it.
    expect(file.rows.map((r) => r.rowNumber)).toEqual([2, 4]);
  });

  it('keeps row numbers aligned across wholly empty lines', () => {
    //          line 1     l2   l3  l4   l5
    const file = parseCsv(buf('name\nA\n\n\nB'));
    expect(file.rows.map((r) => r.data.name)).toEqual(['A', 'B']);
    // Two blank lines sit between them, so B is line 5 — this is what makes the
    // error CSV point the uploader at the row they can actually see.
    expect(file.rows.map((r) => r.rowNumber)).toEqual([2, 5]);
  });

  it('finds the header even when the file starts with blank lines', () => {
    const file = parseCsv(buf('\n\nname,qty\nA,1'));
    expect(file.headers).toEqual(['name', 'qty']);
    expect(file.rows[0]?.rowNumber).toBe(4);
  });

  it('strips a UTF-8 BOM so the first header is not corrupted', () => {
    const file = parseCsv(Buffer.from('\uFEFFProduct Name,Qty.\nA,1', 'utf8'));
    expect(file.headers[0]).toBe('product_name');
  });

  it('handles CRLF line endings', () => {
    const file = parseCsv(buf('name,qty\r\nA,1\r\nB,2'));
    expect(file.rows).toHaveLength(2);
  });

  it('keeps a newline that sits inside a quoted field with its row', () => {
    const file = parseCsv(buf('name,remark\nA,"line one\nline two"\nB,x'));
    expect(file.rows).toHaveLength(2);
    expect(file.rows[0]?.data.remark).toBe('line one\nline two');
  });

  it('rejects an empty file', () => {
    expect(() => parseCsv(buf('   '))).toThrow(ImportParseError);
  });

  it('tolerates short rows by filling missing cells as blank', () => {
    const file = parseCsv(buf('a,b,c\n1,2'));
    expect(file.rows[0]?.data).toEqual({ a: '1', b: '2', c: '' });
  });
});

describe('parseImportFile', () => {
  it('routes .csv to the CSV parser', async () => {
    const file = await parseImportFile('products.csv', buf('name\nA'));
    expect(file.rows).toHaveLength(1);
  });

  it('rejects an unsupported extension at the boundary', async () => {
    await expect(parseImportFile('products.pdf', buf('x'))).rejects.toBeInstanceOf(
      ImportParseError,
    );
  });
});

describe('toCsv', () => {
  it('quotes fields containing commas, quotes or newlines', () => {
    const out = toCsv(
      ['row_number', 'error_message'],
      [{ row_number: 7, error_message: 'Bad "value", see row' }],
    );
    expect(out).toBe('row_number,error_message\r\n7,"Bad ""value"", see row"');
  });

  it('renders missing keys as empty cells', () => {
    expect(toCsv(['a', 'b'], [{ a: 'x' }])).toBe('a,b\r\nx,');
  });

  it('round-trips through the CSV parser', () => {
    const csv = toCsv(['name', 'remark'], [{ name: 'Candle Holder', remark: 'Carton-3, Qty-750' }]);
    const parsed = parseCsv(buf(csv));
    expect(parsed.rows[0]?.data).toEqual({
      name: 'Candle Holder',
      remark: 'Carton-3, Qty-750',
    });
  });
});

describe('scoreHeaderRow', () => {
  it('scores a real header row above a merged title row', () => {
    const title = ['MASTER INVENTORY SHEET', '', '', ''];
    const header = ['Sr. No.', 'Product Name', 'Category', 'Colour', 'Current Stock'];
    expect(scoreHeaderRow(header, 'PRODUCT_MASTER')).toBeGreaterThan(
      scoreHeaderRow(title, 'PRODUCT_MASTER'),
    );
  });

  it('counts a merged title spilled across columns only once', () => {
    // ExcelJS reports a merged cell's value in every column it spans; without
    // de-duplication a spilled recognised word would outscore a real header.
    expect(scoreHeaderRow(['Category', 'Category', 'Category', 'Category'])).toBe(1);
  });

  it('weights columns that signal the expected import type', () => {
    const productish = ['Product Name', 'Opening Stock', 'SKU'];
    expect(scoreHeaderRow(productish, 'PRODUCT_MASTER')).toBeGreaterThan(
      scoreHeaderRow(productish, 'STOCK_LEDGER'),
    );
  });

  it('ignores columns it does not recognise', () => {
    expect(scoreHeaderRow(['wibble', 'wobble'])).toBe(0);
  });
});

describe('parseCsv — header row detection', () => {
  it('skips a title line above the real header', () => {
    const file = parseCsv(
      buf('MASTER INVENTORY SHEET\nProduct Name,Category,Current Stock\nCandle Holder,Home Decor,950'),
      { importType: 'PRODUCT_MASTER' },
    );
    expect(file.headerRowNumber).toBe(2);
    expect(file.headers).toContain('product_name');
    expect(file.rows).toHaveLength(1);
    // Row number still points at the real line in the file.
    expect(file.rows[0]?.rowNumber).toBe(3);
  });

  it('falls back to the first line when no header is recognisable', () => {
    const file = parseCsv(buf('wibble,wobble\n1,2'));
    expect(file.headerRowNumber).toBe(1);
    expect(file.rows).toHaveLength(1);
  });

  it('reports no worksheet for CSV', () => {
    expect(parseCsv(buf('name\nA')).sheetName).toBeNull();
  });
});
