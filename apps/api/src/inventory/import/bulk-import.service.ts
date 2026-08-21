import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, newId } from '@procureflow/db';
import {
  DOMAIN_EVENTS,
  type ImportBatchDetailResponse,
  type ImportBatchListResponse,
  type ImportBatchView,
  type ImportRowResolve,
  type ImportRowView,
  type ImportRowsQuery,
  type ImportType,
} from '@procureflow/shared';

import { AuditLogService } from '../../audit/audit.service';
import { DomainEventService } from '../../common/events/domain-event.service';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryLedgerService } from '../inventory-ledger.service';
import { ImportStateError } from '../inventory.errors';
import { LocationService } from '../location.service';
import { ProductService } from '../product.service';
import { parseImportFile, toCsv } from './import-file.parser';
import {
  mapProductMasterRow,
  mapStockLedgerRow,
  type RowIssue,
} from './import-row.mapper';

/** Location used when a ledger row names none and the file gives no hint. */
const FALLBACK_LOCATION = 'Unassigned';

/** Marks the ADJUSTMENT rows the summary view counts as Opening Stock. */
export const OPENING_STOCK_REMARK = 'opening-stock';

/**
 * BulkImportService (Slice 12a). Bulk upload is a permanent capability, not a
 * one-off migration script: staged, validated, resumable.
 *
 * Flow: upload -> parse into ImportRow (status PENDING, rawData preserved) -> a
 * background job validates each row -> valid rows post to Product /
 * StockLedgerEntry and flip to CREATED/UPDATED; rows that cannot be resolved
 * (typically a product name with no catalogue match) flip to SKIPPED with a
 * reason and wait in a quarantine queue -> the batch finalises with a
 * downloadable error/skip report.
 *
 * Re-running a batch can never double-post: `[importBatchId, sourceRowRef]` is
 * unique on StockLedgerEntry, so a retry of an already-posted row is a no-op.
 */
@Injectable()
export class BulkImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductService,
    private readonly locations: LocationService,
    private readonly ledger: InventoryLedgerService,
    private readonly audit: AuditLogService,
    private readonly events: DomainEventService,
  ) {}

  /** Stage an upload: parse to rows, persist raw, leave processing to the job. */
  async createBatch(
    importType: ImportType,
    fileName: string,
    buffer: Buffer,
    actorId: string,
    opts: { sheetName?: string | null } = {},
  ): Promise<{
    batchId: string;
    totalRows: number;
    sheetName: string | null;
    headerRowNumber: number;
  }> {
    // The import type biases worksheet + header-row detection: a raw workbook
    // has several sheets and the relevant one is rarely the first.
    const parsed = await parseImportFile(fileName, buffer, {
      importType,
      sheetName: opts.sheetName ?? null,
    });

    const batchId = newId('importBatch');
    await this.prisma.client.importBatch.create({
      data: {
        id: batchId,
        tenantId: this.tenantId(),
        importType,
        fileName,
        uploadedById: actorId,
        status: 'PROCESSING',
        totalRows: parsed.rows.length,
      },
    });

    // createMany keeps a 50k-row upload to a handful of round trips.
    const CHUNK = 1_000;
    for (let i = 0; i < parsed.rows.length; i += CHUNK) {
      await this.prisma.client.importRow.createMany({
        data: parsed.rows.slice(i, i + CHUNK).map((r) => ({
          id: newId('importRow'),
          tenantId: this.tenantId(),
          batchId,
          rowNumber: r.rowNumber,
          rawData: r.data as Prisma.InputJsonValue,
          status: 'PENDING' as const,
        })),
      });
    }

    await this.audit.record({
      action: 'INVENTORY_IMPORT_UPLOADED',
      entityType: 'ImportBatch',
      entityId: batchId,
      actorId,
      after: {
        importType,
        fileName,
        totalRows: parsed.rows.length,
        sheetName: parsed.sheetName,
        headerRowNumber: parsed.headerRowNumber,
      },
    });
    return {
      batchId,
      totalRows: parsed.rows.length,
      sheetName: parsed.sheetName,
      headerRowNumber: parsed.headerRowNumber,
    };
  }

  /**
   * IDs of rows still waiting to be processed, oldest first.
   *
   * Rows are handed out in batches but applied one transaction at a time — see
   * `processRow` for why they cannot share one.
   */
  async pendingRowIds(batchId: string, limit: number): Promise<string[]> {
    const rows = await this.prisma.client.importRow.findMany({
      where: { batchId, status: 'PENDING' },
      orderBy: { rowNumber: 'asc' },
      take: limit,
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /**
   * Apply exactly one staged row. MUST run in its own transaction.
   *
   * Postgres aborts the entire transaction on any error, so a batch of rows
   * sharing one transaction cannot survive a single bad row: the failure poisons
   * the transaction and even writing the row's error message back fails with
   * 25P02. One transaction per row is what actually delivers the promise that a
   * malformed row never takes the batch down with it.
   *
   * Idempotent: a row that is no longer PENDING is skipped, so a retry after a
   * crash re-applies only what is genuinely outstanding.
   */
  async processRow(batchId: string, rowId: string): Promise<void> {
    const batch = await this.requireBatch(batchId);
    const row = await this.prisma.client.importRow.findFirst({
      where: { id: rowId, batchId },
    });
    if (!row || row.status !== 'PENDING') return;

    const raw = (row.rawData ?? {}) as Record<string, unknown>;
    const outcome =
      batch.importType === 'PRODUCT_MASTER'
        ? await this.applyProductRow(batchId, row.id, row.rowNumber, raw, batch.uploadedById)
        : await this.applyLedgerRow(batchId, row.id, row.rowNumber, raw, batch.uploadedById);

    if (outcome.status === 'ERROR' || outcome.status === 'SKIPPED') {
      await this.markRow(row.id, outcome.status, { errorMessage: outcome.message });
    }
  }

  /**
   * Record why a row failed, from a FRESH transaction — the row's own
   * transaction is already aborted by the time this is needed.
   */
  async markRowFailed(rowId: string, message: string): Promise<void> {
    await this.markRow(rowId, 'ERROR', { errorMessage: message.slice(0, 1000) });
  }

  /** Recompute tallies and close the batch out. */
  async finalise(batchId: string): Promise<ImportBatchView> {
    const counts = await this.prisma.client.importRow.groupBy({
      by: ['status'],
      where: { batchId },
      _count: { _all: true },
    });
    const tally = (s: string): number =>
      counts.find((c) => c.status === s)?._count._all ?? 0;

    const successRows = tally('CREATED') + tally('UPDATED');
    const errorRows = tally('ERROR');
    const skippedRows = tally('SKIPPED');
    const pendingRows = tally('PENDING') + tally('VALID');

    const status =
      pendingRows > 0
        ? 'PROCESSING'
        : errorRows + skippedRows > 0
          ? 'COMPLETED_WITH_ERRORS'
          : 'COMPLETED';

    const updated = await this.prisma.client.importBatch.update({
      where: { id: batchId },
      data: {
        status,
        successRows,
        errorRows,
        skippedRows,
        completedAt: pendingRows > 0 ? null : new Date(),
      },
    });

    if (pendingRows === 0) {
      await this.events.emit(DOMAIN_EVENTS.INVENTORY_IMPORT_COMPLETED, {
        batchId,
        importType: updated.importType,
        status,
        totalRows: updated.totalRows,
        successRows,
        errorRows,
        skippedRows,
      });
    }
    return this.toBatchView(updated, pendingRows);
  }

  /** Mark a batch failed when the job itself blew up (not an individual row). */
  async failBatch(batchId: string, message: string): Promise<void> {
    await this.prisma.client.importBatch.update({
      where: { id: batchId },
      data: { status: 'FAILED', errorMessage: message, completedAt: new Date() },
    });
  }

  // ══════════════════════ Row application ══════════════════════

  /**
   * PRODUCT_MASTER: create the product if its `(name, colour)` is new, update it
   * otherwise, then seed opening stock and damage as ledger entries.
   */
  private async applyProductRow(
    batchId: string,
    rowId: string,
    rowNumber: number,
    raw: Record<string, unknown>,
    actorId: string,
  ): Promise<{ status: 'DONE' } | RowIssue> {
    const mapped = mapProductMasterRow(raw);
    if (!mapped.ok) return mapped.issue;
    const v = mapped.value;

    const existing = await this.products.findByNameAndColour(v.name, v.colour);
    let productId: string;
    let status: 'CREATED' | 'UPDATED';

    if (existing) {
      await this.products.update(
        existing.id,
        {
          category: v.category,
          // Re-uploading the sheet is how a catalogue gets barcoded in bulk, so
          // a value here updates the product. A blank cell leaves the existing
          // barcode alone rather than wiping it — a sheet exported before the
          // barcode column existed must not silently unlabel 600 products.
          ...(v.barcode ? { barcode: v.barcode } : {}),
          imageUrl: v.imageUrl,
          unit: v.unit,
          reorderPoint: v.reorderPoint,
          expiryOrWarrantyDate: v.expiryOrWarrantyDate?.toISOString() ?? null,
          remark: v.remark,
          legacyProductId: v.legacyProductId,
          legacySku: v.legacySku,
        },
        actorId,
      );
      productId = existing.id;
      status = 'UPDATED';
    } else {
      const created = await this.products.create(
        {
          name: v.name,
          category: v.category,
          colour: v.colour,
          barcode: v.barcode,
          imageUrl: v.imageUrl,
          unit: v.unit,
          // Batch tracking stays off on import: it changes what a receipt is
          // allowed to omit, and that is a per-product decision somebody makes
          // deliberately, not a default a spreadsheet should set for 600 rows.
          requiresBatchTracking: false,
          reorderPoint: v.reorderPoint,
          expiryOrWarrantyDate: v.expiryOrWarrantyDate?.toISOString() ?? null,
          remark: v.remark,
          legacyProductId: v.legacyProductId,
          legacySku: v.legacySku,
        },
        actorId,
        { importBatchId: batchId },
      );
      productId = created.id;
      status = 'CREATED';
    }

    // Opening stock is a ledger entry, not a mutable Product column — it stays
    // visible in history and can never drift from the ledger.
    //
    // The damaged quantity is added back into the opening adjustment because the
    // write-off below immediately removes it again. `openingStock` carries the
    // sheet's Current Stock (what is on the floor, damage already deducted), so
    // seeding it raw and then writing damage off a second time would deduct the
    // same units twice — Coffee Mug would land at 1 − 111 = −110 instead of 1.
    // Seeding (current + damage) makes the net exactly Current Stock while still
    // reporting Damage Qty. in product_stock_summary.
    const damageQty = v.damageQty !== null && v.damageQty > 0 ? v.damageQty : 0;
    const openingSeed = (v.openingStock ?? 0) + damageQty;

    let ledgerEntryId: string | null = null;
    if (openingSeed !== 0) {
      const location = await this.locations.findOrCreate(
        v.locationName ?? FALLBACK_LOCATION,
        v.rackNo,
      );
      ledgerEntryId = await this.postOnce({
        productId,
        locationId: location.id,
        txnType: 'ADJUSTMENT',
        signedQty: openingSeed,
        performedById: actorId,
        remark: OPENING_STOCK_REMARK,
        importBatchId: batchId,
        sourceRowRef: `product-master:${rowNumber}:opening`,
        allowNegativeStock: true,
      });
    }

    if (v.damageQty !== null && v.damageQty > 0) {
      const location = await this.locations.findOrCreate(
        v.locationName ?? FALLBACK_LOCATION,
        v.rackNo,
      );
      await this.postOnce({
        productId,
        locationId: location.id,
        txnType: 'DAMAGE_WRITE_OFF',
        qty: v.damageQty,
        performedById: actorId,
        remark: 'Damage carried over from the legacy Master Inventory Sheet',
        importBatchId: batchId,
        sourceRowRef: `product-master:${rowNumber}:damage`,
        allowNegativeStock: true,
      });
    }

    await this.markRow(rowId, status, { productId, ledgerEntryId });
    return { status: 'DONE' };
  }

  /**
   * STOCK_LEDGER: resolve the product, then post the movement. An unmatched
   * product name is SKIPPED into the quarantine queue, never auto-created —
   * someone has to confirm it is a real SKU first.
   */
  private async applyLedgerRow(
    batchId: string,
    rowId: string,
    rowNumber: number,
    raw: Record<string, unknown>,
    actorId: string,
  ): Promise<{ status: 'DONE' } | RowIssue> {
    const mapped = mapStockLedgerRow(raw);
    if (!mapped.ok) return mapped.issue;
    const v = mapped.value;

    const product = v.productCode
      ? await this.products.findByCode(v.productCode)
      : await this.products.findByNameAndColour(v.productName, v.colour);

    if (!product) {
      return {
        status: 'SKIPPED',
        message: `No catalogue match for "${v.productName || v.productCode}"${v.colour ? ` (${v.colour})` : ''}. Confirm it is a real SKU, then resolve this row.`,
      };
    }

    const location = await this.locations.findOrCreate(v.locationName, v.rackNo);
    const vendorId = v.vendorName ? await this.resolveVendorId(v.vendorName) : null;

    const ledgerEntryId = await this.postOnce({
      productId: product.id,
      locationId: location.id,
      txnType: v.txnType,
      ...(v.txnType === 'ADJUSTMENT' ? { signedQty: v.qty } : { qty: v.qty }),
      vendorId,
      grnNo: v.grnNo,
      gatePassNo: v.gatePassNo,
      rate: v.rate ? new Prisma.Decimal(v.rate) : null,
      taxPct: v.taxPct ? new Prisma.Decimal(v.taxPct) : null,
      qcStatus: v.qcStatus,
      issueDept: v.issueDept,
      issuedToName: v.issuedToName,
      balanceQty: v.txnType === 'INTERNAL_ISSUE' ? Math.abs(v.qty) : null,
      platform: v.platform,
      orderId: v.orderId,
      customerName: v.customerName,
      courierName: v.courierName,
      trackingId: v.trackingId,
      paymentMode: v.paymentMode,
      orderValue: v.orderValue ? new Prisma.Decimal(v.orderValue) : null,
      returnReason: v.returnReason,
      productCondition: v.productCondition,
      restockDecision: v.restockDecision,
      performedById: actorId,
      remark: v.remark,
      txnDate: v.txnDate,
      importBatchId: batchId,
      sourceRowRef: v.sourceRowRef ?? `stock-ledger:${rowNumber}`,
      // Historical rows are replayed out of order, so a mid-import negative
      // balance is expected and not an error.
      allowNegativeStock: true,
    });

    await this.markRow(rowId, 'CREATED', { productId: product.id, ledgerEntryId });
    return { status: 'DONE' };
  }

  /**
   * Post a ledger entry, tolerating the unique-constraint hit that a re-run of
   * an already-imported row produces. This is what makes an accidental
   * double-submit a no-op rather than a duplicate movement.
   */
  private async postOnce(
    input: Parameters<InventoryLedgerService['post']>[0],
  ): Promise<string | null> {
    try {
      return await this.ledger.post(input);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' &&
        String(err.meta?.target ?? '').includes('source_row_ref')
      ) {
        const existing = await this.prisma.client.stockLedgerEntry.findFirst({
          where: {
            importBatchId: input.importBatchId ?? undefined,
            sourceRowRef: input.sourceRowRef ?? undefined,
          },
          select: { id: true },
        });
        return existing?.id ?? null;
      }
      throw err;
    }
  }

  /** Best-effort vendor match by name; an unknown vendor is not fatal. */
  private async resolveVendorId(name: string): Promise<string | null> {
    const vendor = await this.prisma.client.vendor.findFirst({
      where: { name: { equals: name.trim(), mode: 'insensitive' } },
      select: { id: true },
    });
    return vendor?.id ?? null;
  }

  // ══════════════════════ Quarantine triage ══════════════════════

  /**
   * Resolve one SKIPPED row: create the product it referenced, map it onto an
   * existing product, or discard it. The row goes back to PENDING so the next
   * process run picks it up through the normal path.
   */
  async resolveRow(
    batchId: string,
    rowId: string,
    input: ImportRowResolve,
    actorId: string,
  ): Promise<{ ok: true; status: string }> {
    const row = await this.prisma.client.importRow.findFirst({
      where: { id: rowId, batchId },
    });
    if (!row) throw new NotFoundException('Import row not found');
    if (row.status !== 'SKIPPED') {
      throw new ImportStateError(
        `Only skipped rows can be resolved; this row is ${row.status}.`,
      );
    }

    const raw = (row.rawData ?? {}) as Record<string, unknown>;
    const mapped = mapStockLedgerRow(raw);

    if (input.action === 'DISCARD') {
      await this.markRow(rowId, 'SKIPPED', { errorMessage: 'Discarded by reviewer.' });
      await this.audit.record({
        action: 'INVENTORY_IMPORT_ROW_DISCARDED',
        entityType: 'ImportRow',
        entityId: rowId,
        actorId,
      });
      return { ok: true, status: 'SKIPPED' };
    }

    if (input.action === 'CREATE_PRODUCT') {
      if (!mapped.ok) {
        throw new ImportStateError(
          `Cannot create a product from this row: ${mapped.issue.message}`,
        );
      }
      await this.products.create(
        {
          name: mapped.value.productName,
          category: input.category ?? 'Uncategorized',
          colour: mapped.value.colour,
          unit: 'pcs',
          requiresBatchTracking: false,
        },
        actorId,
        { importBatchId: batchId },
      );
    } else {
      // MAP_TO_PRODUCT — confirm the target exists before re-queuing the row.
      const target = await this.products.require(input.productId as string);
      raw.code = target.code;
      await this.prisma.client.importRow.update({
        where: { id: rowId },
        data: { rawData: raw as Prisma.InputJsonValue },
      });
    }

    await this.markRow(rowId, 'PENDING', { errorMessage: null });
    await this.prisma.client.importBatch.update({
      where: { id: batchId },
      data: { status: 'PROCESSING', completedAt: null },
    });
    await this.audit.record({
      action: 'INVENTORY_IMPORT_ROW_RESOLVED',
      entityType: 'ImportRow',
      entityId: rowId,
      actorId,
      after: { action: input.action, productId: input.productId ?? null },
    });
    return { ok: true, status: 'PENDING' };
  }

  // ══════════════════════ Reads ══════════════════════

  async listBatches(limit = 25, cursor?: string | null): Promise<ImportBatchListResponse> {
    const rows = await this.prisma.client.importBatch.findMany({
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: page.map((b) =>
        this.toBatchView(b, b.totalRows - b.successRows - b.errorRows - b.skippedRows),
      ),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  async batchDetail(
    batchId: string,
    query: ImportRowsQuery,
  ): Promise<ImportBatchDetailResponse> {
    const batch = await this.requireBatch(batchId);
    const rows = await this.prisma.client.importRow.findMany({
      where: { batchId, ...(query.status ? { status: query.status } : {}) },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ rowNumber: 'asc' }, { id: 'asc' }],
    });
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;

    const pendingRows = await this.prisma.client.importRow.count({
      where: { batchId, status: { in: ['PENDING', 'VALID'] } },
    });

    return {
      ...this.toBatchView(batch, pendingRows),
      rows: page.map((r) => this.toRowView(r)),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /**
   * The error/skip report. Emitting the original columns plus the reason means
   * the uploader can fix the file in place and re-submit it as a fresh batch —
   * already-successful rows are simply not in it.
   */
  async errorReportCsv(batchId: string): Promise<string> {
    await this.requireBatch(batchId);
    const rows = await this.prisma.client.importRow.findMany({
      where: { batchId, status: { in: ['ERROR', 'SKIPPED'] } },
      orderBy: { rowNumber: 'asc' },
    });

    const sourceHeaders = new Set<string>();
    for (const r of rows) {
      Object.keys((r.rawData ?? {}) as Record<string, unknown>).forEach((k) =>
        sourceHeaders.add(k),
      );
    }
    const headers = ['row_number', 'status', 'error_message', ...[...sourceHeaders].sort()];

    return toCsv(
      headers,
      rows.map((r) => ({
        row_number: r.rowNumber,
        status: r.status,
        error_message: r.errorMessage ?? '',
        ...((r.rawData ?? {}) as Record<string, unknown>),
      })),
    );
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async markRow(
    rowId: string,
    status: 'PENDING' | 'VALID' | 'CREATED' | 'UPDATED' | 'ERROR' | 'SKIPPED',
    data: {
      productId?: string | null;
      ledgerEntryId?: string | null;
      errorMessage?: string | null;
    } = {},
  ): Promise<void> {
    await this.prisma.client.importRow.update({
      where: { id: rowId },
      data: {
        status,
        ...(data.productId !== undefined ? { productId: data.productId } : {}),
        ...(data.ledgerEntryId !== undefined ? { ledgerEntryId: data.ledgerEntryId } : {}),
        ...(data.errorMessage !== undefined ? { errorMessage: data.errorMessage } : {}),
      },
    });
  }

  private async requireBatch(batchId: string) {
    const batch = await this.prisma.client.importBatch.findUnique({
      where: { id: batchId },
    });
    if (!batch) throw new NotFoundException('Import batch not found');
    return batch;
  }

  private toBatchView(
    b: {
      id: string;
      importType: string;
      fileName: string;
      uploadedById: string;
      status: string;
      totalRows: number;
      successRows: number;
      errorRows: number;
      skippedRows: number;
      errorMessage: string | null;
      createdAt: Date;
      completedAt: Date | null;
    },
    pendingRows: number,
  ): ImportBatchView {
    return {
      id: b.id,
      importType: b.importType,
      fileName: b.fileName,
      uploadedById: b.uploadedById,
      status: b.status,
      totalRows: b.totalRows,
      successRows: b.successRows,
      errorRows: b.errorRows,
      skippedRows: b.skippedRows,
      pendingRows: Math.max(0, pendingRows),
      errorMessage: b.errorMessage,
      createdAt: b.createdAt.toISOString(),
      completedAt: b.completedAt?.toISOString() ?? null,
    };
  }

  private toRowView(r: {
    id: string;
    rowNumber: number;
    status: string;
    productId: string | null;
    ledgerEntryId: string | null;
    errorMessage: string | null;
    rawData: Prisma.JsonValue;
  }): ImportRowView {
    return {
      id: r.id,
      rowNumber: r.rowNumber,
      status: r.status,
      productId: r.productId,
      ledgerEntryId: r.ledgerEntryId,
      errorMessage: r.errorMessage,
      rawData: (r.rawData ?? {}) as Record<string, unknown>,
    };
  }

  private tenantId(): string {
    const tid = this.prisma.currentTenantId;
    if (!tid) throw new Error('No tenant context');
    return tid;
  }
}
