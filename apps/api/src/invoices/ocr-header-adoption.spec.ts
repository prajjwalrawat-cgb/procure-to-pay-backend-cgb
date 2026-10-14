import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import { InvoiceService } from './invoice.service';
import type { OcrExtraction } from './ocr/ocr.provider';

const TENANT = 'ten_1';
const INVOICE = 'inv_1';

/**
 * `createFromUpload` stamps the date of receipt and — from email intake — the
 * message subject, then OCR reads the real ones off the page. Which of the two
 * survives is not a detail: `invoiceDate` is what the MSME due date is computed
 * from, and `vendorInvoiceRef` is what duplicate detection compares.
 *
 * The rule under test: OCR fills in placeholders, and never overwrites a value a
 * person asserted. What the document said is recorded either way, so the matcher
 * can raise DOCUMENT_MISMATCH on the disagreement rather than either side
 * quietly winning.
 */
function build(invoice: {
  headerAwaitingOcr: boolean;
  invoiceDate: Date;
  vendorInvoiceRef: string;
  isMsme?: boolean;
  status?: string;
}) {
  const updates: { data: Record<string, unknown> }[] = [];
  const tx = {
    invoice: {
      findUnique: vi.fn(async () => ({
        id: INVOICE,
        status: invoice.status ?? 'OCR_PENDING',
        headerAwaitingOcr: invoice.headerAwaitingOcr,
        invoiceDate: invoice.invoiceDate,
        vendorInvoiceRef: invoice.vendorInvoiceRef,
        // Non-empty so applyOcr's line-population branch is skipped and the
        // assertions land on the header update alone.
        lines: [{ id: 'il_1' }],
        vendor: { id: 'ven_1', isMsme: invoice.isMsme ?? true, gstin: null },
      })),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        updates.push(args);
        return {};
      }),
    },
    tenant: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ ocrConfidenceFloorPct: '80', msmePaymentCapDays: 45 }),
    },
  };
  const prisma = {
    client: {},
    runInTenantContext: vi.fn(async (_t: string, fn: (t: unknown) => Promise<void>) =>
      fn(tx),
    ),
  } as unknown as PrismaService;

  const runFor = vi.fn();
  const service = new InvoiceService(
    prisma,
    { record: vi.fn() } as never, // audit
    { emit: vi.fn() } as never, // events
    { runFor } as never, // match
    {} as never, // ocr
    { computeFor: vi.fn() } as never, // tds
    {
      computeDueDate: (d: Date, cap: number) => new Date(d.getTime() + cap * 86_400_000),
    } as never, // msme
    {} as never, // routing
  );
  return { service, updates, runFor };
}

const extraction = (over: Partial<OcrExtraction> = {}): OcrExtraction => ({
  invoiceDate: '2026-02-14T00:00:00.000Z',
  vendorInvoiceRef: 'PES/2026/4471',
  lines: [],
  confidence: 0.96,
  ...over,
});

/** The header write is the last invoice.update applyOcr performs. */
const header = (updates: { data: Record<string, unknown> }[]): Record<string, unknown> =>
  updates[updates.length - 1].data;

describe('applyOcr — document header adoption', () => {
  it('fills placeholders from the document and moves the MSME due date with it', () => {
    // The whole point: the clock must run from the date the vendor printed, not
    // from the day the email happened to arrive.
    const received = new Date('2026-03-07T00:00:00.000Z');
    const { service, updates } = build({
      headerAwaitingOcr: true,
      invoiceDate: received,
      vendorInvoiceRef: 'FW: invoice for March',
    });

    return service.applyOcr(TENANT, INVOICE, extraction()).then(() => {
      const d = header(updates);
      expect(d.invoiceDate).toEqual(new Date('2026-02-14T00:00:00.000Z'));
      expect(d.vendorInvoiceRef).toBe('PES/2026/4471');
      expect(d.msmeDueDate).toEqual(new Date('2026-03-31T00:00:00.000Z'));
      expect(d.headerAwaitingOcr).toBe(false);
      // and the document's own values are recorded regardless
      expect(d.ocrInvoiceDate).toEqual(new Date('2026-02-14T00:00:00.000Z'));
      expect(d.ocrVendorInvoiceRef).toBe('PES/2026/4471');
    });
  });

  it('never overwrites values a person asserted', async () => {
    const typed = new Date('2026-03-01T00:00:00.000Z');
    const { service, updates } = build({
      headerAwaitingOcr: false,
      invoiceDate: typed,
      vendorInvoiceRef: 'PES/2026/0001',
    });

    await service.applyOcr(TENANT, INVOICE, extraction());
    const d = header(updates);
    expect(d.invoiceDate).toBeUndefined();
    expect(d.vendorInvoiceRef).toBeUndefined();
    expect(d.msmeDueDate).toBeUndefined();
    // Recorded, so the matcher can raise DOCUMENT_MISMATCH on the difference.
    expect(d.ocrInvoiceDate).toEqual(new Date('2026-02-14T00:00:00.000Z'));
    expect(d.ocrVendorInvoiceRef).toBe('PES/2026/4471');
  });

  it('leaves the due date alone for a vendor with no statutory clock', async () => {
    const { service, updates } = build({
      headerAwaitingOcr: true,
      invoiceDate: new Date('2026-03-07T00:00:00.000Z'),
      vendorInvoiceRef: 'subject line',
      isMsme: false,
    });

    await service.applyOcr(TENANT, INVOICE, extraction());
    const d = header(updates);
    expect(d.invoiceDate).toEqual(new Date('2026-02-14T00:00:00.000Z'));
    expect(d.msmeDueDate).toBeUndefined();
  });

  it('refuses an unusable date rather than letting it move the clock', async () => {
    const { service, updates } = build({
      headerAwaitingOcr: true,
      invoiceDate: new Date('2026-03-07T00:00:00.000Z'),
      vendorInvoiceRef: 'subject line',
    });

    await service.applyOcr(
      TENANT,
      INVOICE,
      extraction({ invoiceDate: '14-02-26 (approx)' }),
    );
    const d = header(updates);
    expect(d.invoiceDate).toBeUndefined();
    expect(d.ocrInvoiceDate).toBeUndefined();
    // the reference still lands — one unreadable field does not discard the other
    expect(d.vendorInvoiceRef).toBe('PES/2026/4471');
  });

  it('clears the placeholder flag even when the document yielded nothing', async () => {
    // The page has had its chance; a second pass would not find more. Leaving the
    // flag set would let a later, unrelated run rewrite the header.
    const { service, updates } = build({
      headerAwaitingOcr: true,
      invoiceDate: new Date('2026-03-07T00:00:00.000Z'),
      vendorInvoiceRef: 'subject line',
    });

    await service.applyOcr(
      TENANT,
      INVOICE,
      extraction({ invoiceDate: undefined, vendorInvoiceRef: undefined }),
    );
    const d = header(updates);
    expect(d.headerAwaitingOcr).toBe(false);
    expect(d.invoiceDate).toBeUndefined();
    expect(d.vendorInvoiceRef).toBeUndefined();
  });
});

describe('applyOcr — rejected while extraction was queued', () => {
  // Seen locally: the buyer rejected at 10:20:59, the OCR job landed at
  // 10:21:01, re-ran the match and put the invoice back in MATCH_EXCEPTION.
  it('leaves a rejected invoice alone', async () => {
    const { service, updates, runFor } = build({
      status: 'REJECTED',
      headerAwaitingOcr: true,
      invoiceDate: new Date('2026-03-07T00:00:00.000Z'),
      vendorInvoiceRef: 'PES/2026/4471',
    });
    await service.applyOcr(TENANT, INVOICE, extraction());
    expect(updates).toHaveLength(0);
    expect(runFor).not.toHaveBeenCalled();
  });
});
