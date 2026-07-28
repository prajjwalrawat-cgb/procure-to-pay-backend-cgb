import ExcelJS from 'exceljs';
import { beforeAll, describe, expect, it } from 'vitest';

import { ImportParseError } from '../inventory.errors';
import { parseXlsx } from './import-file.parser';

/**
 * Regression cover for a real failure: uploading the Artbox workbook produced
 * 63 identical "Product Name or Code is required" errors because the parser
 * took worksheet[0] and row 1 as the header. Both are wrong for that file —
 * the catalogue is on sheet 2 under a merged title row.
 */
async function buildWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();

  // Sheet 1: a movement log, mirroring DAILY ORDER REPORT sitting first.
  const orders = wb.addWorksheet('DAILY ORDER REPORT');
  orders.addRow(['DAILY ORDER REPORT']);
  orders.addRow([
    'Order Date', 'Order Id', 'Platefrom', 'Customer Name', 'Product Name',
    'Qty.', 'Courier Name', 'Tracking Id', 'Location',
  ]);
  orders.addRow([
    '27/05/2026', '6149', 'Shopify', 'Nihar More', 'Tea Box',
    '1', 'Bluedart', 'BD123', 'Store',
  ]);

  // Sheet 2: the product catalogue, under its own merged title row.
  const master = wb.addWorksheet('Master Inventory Sheet');
  master.addRow(['', 'MASTER INVENTORY SHEET']);
  master.addRow([
    'Sr. No.', 'Product ID', 'SKU', 'Product Name', 'Category',
    'Colour', 'Opening Stock', 'Damage Qty.', 'Current Stock', 'Location ', 'Rack No.',
  ]);
  master.addRow(['1', 'N/A', 'N/A', 'Candle Holder', 'Home Decor', 'Brass', '950', '0', '950', 'Store', 'Rack-6']);
  // Current Stock deliberately blank: Opening − Damage nets to nil.
  master.addRow(['2', 'N/A', 'N/A', 'The Halthy Binge', 'Home Decor', '', '4', '4', '', 'Store', 'R-8']);

  return (await wb.xlsx.writeBuffer()) as Buffer;
}

describe('parseXlsx — worksheet and header detection', () => {
  let buf: Buffer;
  beforeAll(async () => {
    buf = await buildWorkbook();
  });

  it('picks the catalogue sheet for PRODUCT_MASTER, not worksheet[0]', async () => {
    const f = await parseXlsx(buf, { importType: 'PRODUCT_MASTER' });
    expect(f.sheetName).toBe('Master Inventory Sheet');
  });

  it('finds the header under a merged title row', async () => {
    const f = await parseXlsx(buf, { importType: 'PRODUCT_MASTER' });
    expect(f.headerRowNumber).toBe(2);
    expect(f.headers).toContain('product_name');
    expect(f.headers).toContain('current_stock');
  });

  it('returns the data rows, not the title or header', async () => {
    const f = await parseXlsx(buf, { importType: 'PRODUCT_MASTER' });
    expect(f.rows).toHaveLength(2);
    expect(f.rows[0]?.data.product_name).toBe('Candle Holder');
    // rowNumber stays the real spreadsheet row so error reports are actionable.
    expect(f.rows[0]?.rowNumber).toBe(3);
  });

  it('prefers a movement sheet for STOCK_LEDGER', async () => {
    const f = await parseXlsx(buf, { importType: 'STOCK_LEDGER' });
    expect(f.sheetName).toBe('DAILY ORDER REPORT');
  });

  it('honours an explicit sheet name over detection', async () => {
    const f = await parseXlsx(buf, {
      importType: 'PRODUCT_MASTER',
      sheetName: 'DAILY ORDER REPORT',
    });
    expect(f.sheetName).toBe('DAILY ORDER REPORT');
  });

  it('rejects an unknown sheet name, listing what the workbook has', async () => {
    await expect(
      parseXlsx(buf, { sheetName: 'Nope' }),
    ).rejects.toThrow(/Master Inventory Sheet/);
  });

  it('fails with a diagnostic when no sheet has a usable header', async () => {
    const wb = new ExcelJS.Workbook();
    const s = wb.addWorksheet('Junk');
    s.addRow(['wibble', 'wobble']);
    s.addRow(['1', '2']);
    const junk = (await wb.xlsx.writeBuffer()) as Buffer;

    await expect(parseXlsx(junk)).rejects.toBeInstanceOf(ImportParseError);
    await expect(parseXlsx(junk)).rejects.toThrow(/recognisable header row/i);
  });
});
