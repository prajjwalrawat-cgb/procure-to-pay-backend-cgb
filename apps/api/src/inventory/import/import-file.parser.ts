import { ImportParseError } from '../inventory.errors';
import { KNOWN_HEADER_KEYS, TYPE_SIGNAL_HEADERS } from './import-row.mapper';

/** One parsed source row: header -> cell, plus its 1-based line number. */
export interface ParsedRow {
  rowNumber: number;
  data: Record<string, string>;
}

export interface ParsedFile {
  headers: string[];
  rows: ParsedRow[];
  /** Worksheet the rows came from (null for CSV). */
  sheetName: string | null;
  /** 1-based row the headers were found on — often not row 1. */
  headerRowNumber: number;
}

export interface ParseOptions {
  /** Biases worksheet/header selection toward the expected shape. */
  importType?: string;
  /** Explicit worksheet name, bypassing auto-detection. */
  sheetName?: string | null;
}

/** Guard rail against a runaway upload exhausting memory. */
export const MAX_IMPORT_ROWS = 50_000;

/**
 * How far down a sheet to look for the header row. Real workbooks put a merged
 * title (and sometimes a blank spacer) above the headers; 15 is generous.
 */
const HEADER_SCAN_ROWS = 15;

/** Below this many recognised columns a row is not a header. */
const MIN_HEADER_SCORE = 2;

/**
 * Score a candidate header row: how many of its cells are column names the
 * mapper understands. Columns matching the expected import type count double so
 * a product catalogue is not mistaken for a movement log, or vice versa.
 */
export function scoreHeaderRow(cells: string[], importType?: string): number {
  const signals = new Set(importType ? (TYPE_SIGNAL_HEADERS[importType] ?? []) : []);
  const seen = new Set<string>();
  let score = 0;
  for (const cell of cells) {
    const key = normaliseHeader(cell);
    // A merged title spills the same value across every column — count once.
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (!KNOWN_HEADER_KEYS.has(key)) continue;
    score += signals.has(key) ? 2 : 1;
  }
  return score;
}

/**
 * Split one CSV line, honouring RFC 4180 quoting: fields may contain commas,
 * newlines are handled by the caller, and `""` inside a quoted field is a
 * literal quote. The legacy workbook's remark column is full of commas, so a
 * naive `split(',')` would silently shred it.
 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

/**
 * Split a CSV document into logical lines, keeping newlines that sit inside a
 * quoted field attached to their row.
 */
function splitCsvRecords(text: string): string[] {
  const records: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      // A doubled quote inside a quoted field is an escaped literal, not a close.
      if (inQuotes === false && text[i + 1] === '"') {
        inQuotes = true;
        current += '""';
        i += 1;
        continue;
      }
      current += ch;
      continue;
    }
    if (!inQuotes && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      records.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.length > 0) records.push(current);
  return records;
}

/** Normalise a header cell so `Product Name`, `product_name` and `PRODUCT NAME` match. */
export function normaliseHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Parse a CSV buffer into headed rows, skipping wholly blank lines. */
export function parseCsv(buffer: Buffer, opts: ParseOptions = {}): ParsedFile {
  // Strip a UTF-8 BOM — Excel writes one and it would corrupt the first header.
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  // Blank lines are NOT filtered out up front: `rowNumber` has to stay the real
  // 1-based line in the uploaded file, or the error report sends the uploader
  // to the wrong row.
  const records = splitCsvRecords(text);
  if (records.every((r) => r.trim().length === 0)) {
    throw new ImportParseError('The uploaded file is empty.');
  }

  // A CSV exported from a spreadsheet can carry a title line above the headers,
  // so score the first few lines instead of assuming the first one is it.
  let headerIndex = -1;
  let bestScore = -1;
  for (let i = 0; i < Math.min(records.length, HEADER_SCAN_ROWS); i += 1) {
    const record = records[i] as string;
    if (record.trim().length === 0) continue;
    const score = scoreHeaderRow(splitCsvLine(record), opts.importType);
    if (score > bestScore) {
      bestScore = score;
      headerIndex = i;
    }
  }
  // Nothing recognisable — fall back to the first non-blank line so a file with
  // entirely custom headers still parses and fails per-row with real reasons.
  if (bestScore < MIN_HEADER_SCORE) {
    headerIndex = records.findIndex((r) => r.trim().length > 0);
  }

  const headers = splitCsvLine(records[headerIndex] as string).map(normaliseHeader);
  if (headers.every((h) => h === '')) {
    throw new ImportParseError('The uploaded file has no header row.');
  }

  const rows: ParsedRow[] = [];
  for (let i = headerIndex + 1; i < records.length; i += 1) {
    const record = records[i] as string;
    if (record.trim().length === 0) continue;

    if (rows.length >= MAX_IMPORT_ROWS) {
      throw new ImportParseError(
        `File exceeds the ${MAX_IMPORT_ROWS.toLocaleString()} row import limit. Split it into smaller batches.`,
      );
    }
    const cells = splitCsvLine(record);
    const data: Record<string, string> = {};
    headers.forEach((h, idx) => {
      if (h) data[h] = (cells[idx] ?? '').trim();
    });
    // A row of empty cells is spreadsheet padding, not data.
    if (Object.values(data).every((v) => v === '')) continue;
    rows.push({ rowNumber: i + 1, data });
  }
  return {
    headers: headers.filter(Boolean),
    rows,
    sheetName: null,
    headerRowNumber: headerIndex + 1,
  };
}

/**
 * Parse an XLSX buffer into headed rows.
 *
 * Real workbooks are not tidy: the relevant sheet is often not the first one
 * (the Artbox workbook opens on `DAILY ORDER REPORT`, with the product
 * catalogue on sheet 2), and the header row usually sits under a merged title.
 * So rather than assuming `worksheets[0]` and row 1, every sheet is scored on
 * how many recognised column names its candidate header rows contain, biased
 * toward the expected import type, and the best match wins.
 */
export async function parseXlsx(
  buffer: Buffer,
  opts: ParseOptions = {},
): Promise<ParsedFile> {
  // Imported lazily so the ~2 MB exceljs bundle is only loaded on an actual
  // spreadsheet upload, not on every API boot.
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

  const sheets = workbook.worksheets.filter((w) => w.rowCount > 0);
  if (sheets.length === 0) throw new ImportParseError('The workbook has no worksheets.');

  const candidates = opts.sheetName
    ? sheets.filter((w) => w.name.trim().toLowerCase() === opts.sheetName?.trim().toLowerCase())
    : sheets;
  if (candidates.length === 0) {
    throw new ImportParseError(
      `No worksheet named "${opts.sheetName}". This workbook has: ${sheets.map((w) => w.name).join(', ')}.`,
    );
  }

  let best: { sheet: (typeof sheets)[number]; headerRow: number; score: number } | null = null;
  for (const sheet of candidates) {
    const limit = Math.min(sheet.rowCount, HEADER_SCAN_ROWS);
    for (let r = 1; r <= limit; r += 1) {
      const cells: string[] = [];
      sheet.getRow(r).eachCell({ includeEmpty: true }, (cell, col) => {
        cells[col - 1] = cellText(cell.value);
      });
      const score = scoreHeaderRow(cells, opts.importType);
      if (!best || score > best.score) best = { sheet, headerRow: r, score };
    }
  }

  if (!best || best.score < MIN_HEADER_SCORE) {
    throw new ImportParseError(
      `Could not find a recognisable header row in this workbook. Sheets checked: ${candidates
        .map((w) => w.name)
        .join(', ')}. Expected columns such as Product Name, Category, Qty. or Location in one of the first ${HEADER_SCAN_ROWS} rows.`,
    );
  }

  const { sheet, headerRow } = best;
  const headers: string[] = [];
  sheet.getRow(headerRow).eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col - 1] = normaliseHeader(cellText(cell.value));
  });

  // A merged title spills one value across many columns; de-duplicate so the
  // second occurrence does not overwrite a real column of the same name.
  const seen = new Set<string>();
  const uniqueHeaders = headers.map((h) => {
    if (!h || seen.has(h)) return '';
    seen.add(h);
    return h;
  });

  const rows: ParsedRow[] = [];
  let overflow = false;
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= headerRow) return;
    if (rows.length >= MAX_IMPORT_ROWS) {
      overflow = true;
      return;
    }

    const data: Record<string, string> = {};
    uniqueHeaders.forEach((h, idx) => {
      if (!h) return;
      data[h] = cellText(row.getCell(idx + 1).value).trim();
    });
    if (Object.values(data).every((v) => v === '')) return;
    rows.push({ rowNumber, data });
  });

  if (overflow) {
    throw new ImportParseError(
      `File exceeds the ${MAX_IMPORT_ROWS.toLocaleString()} row import limit. Split it into smaller batches.`,
    );
  }
  return {
    headers: uniqueHeaders.filter(Boolean),
    rows,
    sheetName: sheet.name,
    headerRowNumber: headerRow,
  };
}

/** Coerce any ExcelJS cell value (rich text, formula, date, link) to plain text. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.text === 'string') return v.text;
    if (Array.isArray(v.richText)) {
      return v.richText.map((r) => String((r as { text?: string }).text ?? '')).join('');
    }
    // A formula cell carries its computed result alongside the expression.
    if ('result' in v) return cellText(v.result);
    if ('hyperlink' in v && typeof v.hyperlink === 'string') return v.hyperlink;
    return '';
  }
  return String(value);
}

/** Dispatch on filename extension; anything else is rejected at the boundary. */
export async function parseImportFile(
  fileName: string,
  buffer: Buffer,
  opts: ParseOptions = {},
): Promise<ParsedFile> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.csv')) return parseCsv(buffer, opts);
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) return parseXlsx(buffer, opts);
  throw new ImportParseError(
    `Unsupported file type "${fileName}". Upload a .csv or .xlsx file.`,
  );
}

/** Serialise rows back to CSV for the error/skip report download. */
export function toCsv(headers: string[], rows: Record<string, unknown>[]): string {
  const escape = (v: unknown): string => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(escape).join(',')];
  for (const row of rows) lines.push(headers.map((h) => escape(row[h])).join(','));
  return lines.join('\r\n');
}
