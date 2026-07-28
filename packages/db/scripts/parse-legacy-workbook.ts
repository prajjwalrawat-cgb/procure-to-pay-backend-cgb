/**
 * parse-legacy-workbook — turn the Artbox inventory workbook into the CSVs the
 * Slice 12 Bulk Upload pipeline expects (ADR-036).
 *
 *   pnpm --filter @procureflow/db legacy:parse -- \
 *     --file "../Docs/Master Inventory Sheets (1).xlsx" --out ./out
 *
 * Deliberately NOT a bespoke importer: it writes CSVs and stops. The rows are
 * then fed through `POST /inventory/bulk-imports` so day-one migration exercises
 * exactly the same validation and error-reporting path any future upload hits.
 *
 * Outputs:
 *   products.csv            -> importType=PRODUCT_MASTER
 *   stock_ledger_seed.csv   -> importType=STOCK_LEDGER (historical transactions)
 *   locations.csv           -> the resolved location list, for reference
 *   location_review.csv     -> rows whose location/carton text needs a human
 *   unmatched_products.csv  -> transaction names with no Master Inventory match
 *   migration_report.md     -> the numbers, for the verification checklist
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import ExcelJS from 'exceljs';

import { UNASSIGNED_LOCATION, parseLocations } from './legacy-location.parser';

// ── sheet layout (column indices are 1-based, as ExcelJS reports them) ────────

/** The Master Inventory Sheet's columns, in the order the workbook has them. */
const MASTER_COLS = {
  srNo: 1,
  productId: 2,
  sku: 3,
  name: 4,
  category: 5,
  colour: 6,
  imageLink: 7,
  openingStock: 8,
  in: 9,
  totalOut: 10,
  returnQty: 11,
  damageQty: 12,
  currentStock: 13,
  expiry: 14,
  location: 15,
  rackNo: 16,
  lastUpdated: 17,
  remark: 18,
} as const;

/**
 * The eight transaction sheets. Several are "dual block": one physical sheet
 * holding two logical tables side by side (Vendor Inward + Vendor Outward;
 * Daily IN + Daily OUT), which is why `blocks` is a list.
 */
interface Block {
  label: string;
  txnType: string;
  /** Column offset where this block starts (0 for the left-hand block). */
  offset: number;
  headerRow: number;
  cols: Record<string, number>;
  issueDept?: string;
}

const SHEETS: { sheet: string; blocks: Block[] }[] = [
  {
    sheet: 'VENDOR INWARD SHEET',
    blocks: [
      {
        label: 'vendor-inward',
        txnType: 'VENDOR_INWARD',
        offset: 0,
        headerRow: 2,
        cols: {
          txnDate: 1, grnNo: 2, vendorName: 3, invoiceNo: 4,
          productName: 7, colour: 8, category: 9,
          qty: 11, rate: 12, taxPct: 13, qcStatus: 16, damageQty: 17, remark: 18,
        },
      },
      {
        label: 'vendor-outward',
        txnType: 'VENDOR_RETURN_OUT',
        offset: 19,
        headerRow: 2,
        cols: {
          txnDate: 1, gatePassNo: 2, vendorName: 3, invoiceNo: 4,
          productName: 6, colour: 7, category: 8,
          qty: 10, purpose: 11, remark: 13,
        },
      },
    ],
  },
  {
    sheet: 'DAILY IN & OUT REPORT',
    blocks: [
      {
        label: 'daily-in',
        txnType: 'VENDOR_INWARD',
        offset: 0,
        headerRow: 2,
        cols: {
          txnDate: 1, productName: 2, qty: 3, vendorName: 4,
          receivedBy: 5, purpose: 6, damageQty: 7, remark: 8,
        },
      },
      {
        label: 'daily-out',
        txnType: 'INTERNAL_ISSUE',
        offset: 9,
        headerRow: 2,
        issueDept: 'OTHER',
        cols: {
          txnDate: 1, productName: 2, qty: 3, issuedToName: 4,
          through: 5, purpose: 6, issuePerson: 7, approvedBy: 8, remark: 9,
        },
      },
    ],
  },
  {
    sheet: 'SAMPLE INWARD SHEET',
    blocks: [
      {
        label: 'sample-inward',
        txnType: 'SAMPLE_INWARD',
        offset: 0,
        headerRow: 1,
        cols: {
          vendorName: 1, productName: 2, colour: 3, category: 4,
          qty: 5, orderValue: 6, txnDate: 7, qcStatus: 8, remark: 9,
        },
      },
    ],
  },
  {
    sheet: 'PHOTOSHOOT TEAM TRACKER',
    blocks: [
      {
        label: 'photoshoot',
        txnType: 'INTERNAL_ISSUE',
        offset: 0,
        headerRow: 2,
        issueDept: 'PHOTOSHOOT',
        cols: {
          txnDate: 1, issuedToName: 2, productName: 4, colour: 5,
          qty: 6, returnQty: 7, balanceQty: 8, remark: 11,
        },
      },
    ],
  },
  {
    sheet: 'SALES TEAM OUT & IN',
    blocks: [
      {
        label: 'sales-team',
        txnType: 'INTERNAL_ISSUE',
        offset: 0,
        headerRow: 2,
        issueDept: 'SALES',
        cols: {
          txnDate: 1, issuedToName: 2, productName: 3, qty: 4, returnQty: 5,
          balanceQty: 8, customerName: 9, locationName: 10, remark: 13,
        },
      },
    ],
  },
  {
    sheet: 'OTHER PLACE   OTHER PERSON Iss',
    blocks: [
      {
        label: 'other-issue',
        txnType: 'INTERNAL_ISSUE',
        offset: 0,
        headerRow: 2,
        issueDept: 'OTHER',
        cols: {
          txnDate: 1, issuedToName: 2, productName: 3, colour: 4,
          qty: 5, returnQty: 6, balanceQty: 7, remark: 11,
        },
      },
    ],
  },
  {
    sheet: 'DAILY ORDER REPORT',
    blocks: [
      {
        label: 'daily-order',
        txnType: 'CUSTOMER_ORDER_OUT',
        offset: 0,
        headerRow: 2,
        cols: {
          txnDate: 1, orderId: 2, platform: 3, customerName: 4,
          productName: 5, colour: 6, qty: 7,
          courierName: 9, trackingId: 10, paymentMode: 12, orderValue: 13, remark: 14,
        },
      },
    ],
  },
  {
    sheet: 'RETURN INVENTORY',
    blocks: [
      {
        label: 'return-inventory',
        txnType: 'CUSTOMER_RETURN_IN',
        offset: 0,
        headerRow: 2,
        cols: {
          orderId: 1, productName: 2, colour: 4, txnDate: 5, qty: 6,
          returnReason: 7, productCondition: 8, restockDecision: 9, remark: 10,
        },
      },
    ],
  },
];

// ── helpers ──────────────────────────────────────────────────────────────────

/** Flatten any ExcelJS cell value to trimmed plain text. */
function text(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    // ExcelJS's CellValue union has no index signature, so widen through
    // `unknown` before probing for the rich-text / formula / hyperlink shapes.
    const v = value as unknown as Record<string, unknown>;
    if (typeof v.text === 'string') return v.text.trim();
    if (Array.isArray(v.richText)) {
      return v.richText.map((r) => String((r as { text?: string }).text ?? '')).join('').trim();
    }
    if ('result' in v) return text(v.result as ExcelJS.CellValue);
    if (typeof v.hyperlink === 'string') return v.hyperlink.trim();
    return '';
  }
  return String(value).trim();
}

const BLANKS = new Set(['', 'n/a', 'na', 'nil', '-', 'none', 'null']);
const clean = (s: string): string => (BLANKS.has(s.toLowerCase()) ? '' : s);

function num(s: string): number {
  const v = clean(s).replace(/,/g, '');
  if (!v) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers: string[], rows: Record<string, unknown>[]): string {
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map((h) => csvEscape(r[h])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/** Normalised key for matching a transaction name to the product catalogue. */
const matchKey = (name: string, colour: string): string =>
  `${name.trim().toLowerCase()}|${clean(colour).toLowerCase()}`;

// ── main ─────────────────────────────────────────────────────────────────────

interface Args {
  file: string;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, fallback: string): string => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? (argv[i + 1] as string) : fallback;
  };
  return {
    file: get('--file', '../../Docs/Master Inventory Sheets (1).xlsx'),
    out: get('--out', './out'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const filePath = resolve(process.cwd(), args.file);
  const outDir = resolve(process.cwd(), args.out);
  await mkdir(outDir, { recursive: true });

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);

  // ── Master Inventory Sheet -> products.csv + opening stock ────────────────
  const master = wb.getWorksheet('Master Inventory Sheet');
  if (!master) throw new Error('Workbook has no "Master Inventory Sheet" tab.');

  const products: Record<string, unknown>[] = [];
  const locationReview: Record<string, unknown>[] = [];
  const locations = new Map<string, { name: string; rackNo: string }>();
  const catalogue = new Set<string>();

  let totalCurrentStock = 0;
  let openingEntries = 0;

  master.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= 2) return; // title + header
    const name = clean(text(row.getCell(MASTER_COLS.name).value));
    if (!name) return;

    const colour = clean(text(row.getCell(MASTER_COLS.colour).value));
    const currentStock = num(text(row.getCell(MASTER_COLS.currentStock).value));
    const damageQty = num(text(row.getCell(MASTER_COLS.damageQty).value));
    const locationText = text(row.getCell(MASTER_COLS.location).value);
    const rackText = text(row.getCell(MASTER_COLS.rackNo).value);

    const parsed = parseLocations(locationText, rackText, currentStock);
    const primary = parsed.placements[0];
    if (!primary) return;

    for (const p of parsed.placements) {
      const key = `${p.locationName}|${p.rackOrCarton ?? ''}`;
      if (!locations.has(key)) {
        locations.set(key, { name: p.locationName, rackNo: p.rackOrCarton ?? '' });
      }
    }

    if (parsed.needsReview) {
      locationReview.push({
        row_number: rowNumber,
        product_name: name,
        colour,
        current_stock: currentStock,
        location_raw: locationText,
        rack_no_raw: rackText,
        reason: parsed.reviewReason ?? '',
        parsed_placements: parsed.placements
          .map((p) => `${p.locationName}${p.rackOrCarton ? ` (${p.rackOrCarton})` : ''}=${p.qty ?? '?'}`)
          .join('; '),
      });
    }

    catalogue.add(matchKey(name, colour));
    totalCurrentStock += currentStock;
    if (currentStock !== 0) openingEntries += 1;
    if (damageQty > 0) openingEntries += 1;

    products.push({
      product_name: name,
      category: clean(text(row.getCell(MASTER_COLS.category).value)) || 'Uncategorized',
      colour,
      image_link: text(row.getCell(MASTER_COLS.imageLink).value),
      unit: 'pcs',
      // Opening Stock in the target model is the row's authoritative Current
      // Stock, not the sheet's own "Opening Stock" column: Current Stock is
      // what is on the floor today, and it is what the ledger must reproduce.
      opening_stock: currentStock,
      damage_qty: damageQty,
      location: primary.locationName,
      rack_no: primary.rackOrCarton ?? '',
      expiry_waranty_date: text(row.getCell(MASTER_COLS.expiry).value),
      // Preserved verbatim for the audit trail, "N/A" and all.
      product_id: text(row.getCell(MASTER_COLS.productId).value),
      sku: text(row.getCell(MASTER_COLS.sku).value),
      remark: text(row.getCell(MASTER_COLS.remark).value),
      source_row_ref: `master-inventory:${rowNumber}`,
    });
  });

  // ── transaction sheets -> stock_ledger_seed.csv ───────────────────────────
  const ledgerRows: Record<string, unknown>[] = [];
  const unmatched = new Map<string, { name: string; colour: string; count: number; sheets: Set<string> }>();
  const perSheetCounts: Record<string, number> = {};

  for (const { sheet, blocks } of SHEETS) {
    const ws = wb.getWorksheet(sheet);
    if (!ws) {
      console.warn(`  ! sheet "${sheet}" not found — skipped`);
      continue;
    }

    for (const block of blocks) {
      let count = 0;
      ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber <= block.headerRow) return;
        const col = (key: string): string => {
          const idx = block.cols[key];
          return idx === undefined ? '' : text(row.getCell(block.offset + idx).value);
        };

        const productName = clean(col('productName'));
        if (!productName) return;

        const qty = num(col('qty'));
        if (qty === 0) return;

        const colour = clean(col('colour'));
        if (!catalogue.has(matchKey(productName, colour))) {
          const key = matchKey(productName, colour);
          const seen = unmatched.get(key) ?? {
            name: productName,
            colour,
            count: 0,
            sheets: new Set<string>(),
          };
          seen.count += 1;
          seen.sheets.add(block.label);
          unmatched.set(key, seen);
          // Still emitted: the pipeline will quarantine it as SKIPPED, which is
          // exactly the review queue the business asked for.
        }

        count += 1;
        ledgerRows.push({
          product_name: productName,
          colour,
          txn_type: block.txnType,
          qty: Math.abs(qty),
          location: clean(col('locationName')) || UNASSIGNED_LOCATION,
          rack_no: '',
          date: col('txnDate'),
          vendor: clean(col('vendorName')),
          grn_no: clean(col('grnNo')),
          gate_pass_no: clean(col('gatePassNo')),
          rate: clean(col('rate')),
          tax: clean(col('taxPct')),
          qc_status: clean(col('qcStatus')),
          department: block.issueDept ?? '',
          issued_to: clean(col('issuedToName')) || clean(col('issuePerson')),
          platform: clean(col('platform')),
          order_id: clean(col('orderId')),
          customer_name: clean(col('customerName')),
          courier_name: clean(col('courierName')),
          tracking_id: clean(col('trackingId')),
          payment_mode: clean(col('paymentMode')),
          order_value: clean(col('orderValue')),
          reason: clean(col('returnReason')) || clean(col('purpose')),
          product_condition: clean(col('productCondition')),
          restock_yes_no: clean(col('restockDecision')),
          remark: col('remark'),
          source_row_ref: `${block.label}:${rowNumber}`,
        });

        // A tracker row that also records a return becomes a second movement,
        // so the Issue/Return/Balance columns stay reproducible.
        const returnQty = num(col('returnQty'));
        if (returnQty > 0) {
          count += 1;
          ledgerRows.push({
            product_name: productName,
            colour,
            txn_type: 'INTERNAL_RETURN',
            qty: returnQty,
            location: clean(col('locationName')) || UNASSIGNED_LOCATION,
            date: col('txnDate'),
            department: block.issueDept ?? '',
            issued_to: clean(col('issuedToName')),
            remark: col('remark'),
            source_row_ref: `${block.label}:${rowNumber}:return`,
          });
        }
      });
      perSheetCounts[block.label] = count;
    }
  }

  // ── write outputs ─────────────────────────────────────────────────────────
  const productHeaders = Object.keys(products[0] ?? { product_name: '' });
  const ledgerHeaders = Object.keys(ledgerRows[0] ?? { product_name: '' });

  await writeFile(join(outDir, 'products.csv'), toCsv(productHeaders, products), 'utf8');
  await writeFile(
    join(outDir, 'stock_ledger_seed.csv'),
    toCsv(ledgerHeaders, ledgerRows),
    'utf8',
  );
  await writeFile(
    join(outDir, 'locations.csv'),
    toCsv(['name', 'rack_no'], [...locations.values()]),
    'utf8',
  );
  await writeFile(
    join(outDir, 'location_review.csv'),
    toCsv(
      ['row_number', 'product_name', 'colour', 'current_stock', 'location_raw', 'rack_no_raw', 'parsed_placements', 'reason'],
      locationReview,
    ),
    'utf8',
  );
  await writeFile(
    join(outDir, 'unmatched_products.csv'),
    toCsv(
      ['product_name', 'colour', 'row_instances', 'sheets'],
      [...unmatched.values()]
        .sort((a, b) => b.count - a.count)
        .map((u) => ({
          product_name: u.name,
          colour: u.colour,
          row_instances: u.count,
          sheets: [...u.sheets].join(' '),
        })),
    ),
    'utf8',
  );

  const unmatchedInstances = [...unmatched.values()].reduce((s, u) => s + u.count, 0);
  const distinctLocations = new Set([...locations.values()].map((l) => l.name));

  const report = `# Legacy workbook migration — parse report

Source: \`${args.file}\`

| Metric | Count |
|---|---|
| Products parsed (Master Inventory Sheet) | ${products.length} |
| Total current-stock units to seed | ${totalCurrentStock.toLocaleString()} |
| Unique locations resolved | ${distinctLocations.size} (${[...distinctLocations].join(', ')}) |
| Location + rack combinations | ${locations.size} |
| Opening-stock + damage ledger entries | ${openingEntries} |
| Historical transaction rows | ${ledgerRows.length} |
| Location/remark strings flagged for review | ${locationReview.length} |
| Transaction names with no catalogue match | ${unmatched.size} unique (${unmatchedInstances} row instances) |

## Rows per source block

${Object.entries(perSheetCounts)
  .map(([k, v]) => `- \`${k}\`: ${v}`)
  .join('\n')}

## Next steps

1. \`POST /inventory/bulk-imports\` with \`importType=PRODUCT_MASTER\` and \`products.csv\`.
2. \`POST /inventory/bulk-imports\` with \`importType=STOCK_LEDGER\` and \`stock_ledger_seed.csv\`.
3. Work the quarantine queue: the ${unmatched.size} unmatched names land as \`SKIPPED\`
   rows, not auto-created products. Confirm each is a real SKU, then resolve it.
4. Review \`location_review.csv\` — ${locationReview.length} rows where the free-text
   location/carton split could not be proven against Current Stock.
`;
  await writeFile(join(outDir, 'migration_report.md'), report, 'utf8');

  console.log(report);
  console.log(`\nWrote 6 files to ${outDir}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
