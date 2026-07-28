import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  IMPORT_TYPE,
  ImportRowResolveSchema,
  ImportRowsQuerySchema,
  PERMISSIONS,
  type ImportBatchDetailResponse,
  type ImportBatchListResponse,
  type ImportRowResolve,
  type ImportRowsQuery,
  type ImportType,
} from '@procureflow/shared';

import type { AuthUser } from '../../auth/auth.types';
import { CurrentUser, RequirePermission } from '../../auth/decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { assertUploadSize } from '../../common/upload/upload-options';
import { IMPORT_UPLOAD_OPTIONS } from './import-upload-options';
import { BulkImportProcessor } from './bulk-import.processor';
import { BulkImportService } from './bulk-import.service';

/**
 * BulkImportsController (Slice 12a). Staged, validated, resumable imports.
 *
 * The upload returns a batchId immediately; validation and posting happen on a
 * BullMQ worker so a 50k-row file does not hold an HTTP connection open.
 */
@Controller('inventory/bulk-imports')
export class BulkImportsController {
  constructor(
    private readonly imports: BulkImportService,
    private readonly processor: BulkImportProcessor,
  ) {}

  @Post()
  @RequirePermission(PERMISSIONS.INVENTORY_IMPORT)
  @UseInterceptors(FileInterceptor('file', IMPORT_UPLOAD_OPTIONS))
  async upload(
    @CurrentUser() user: AuthUser,
    @UploadedFile()
    file: { originalname: string; buffer: Buffer; mimetype: string; size?: number } | undefined,
    @Body('importType') importType: string,
    @Body('sheetName') sheetName?: string,
  ): Promise<{
    batchId: string;
    totalRows: number;
    queued: boolean;
    sheetName: string | null;
    headerRowNumber: number;
  }> {
    if (!file) throw new BadRequestException('A file upload is required.');
    assertUploadSize(file);

    if (!(IMPORT_TYPE as readonly string[]).includes(importType)) {
      throw new BadRequestException(
        `importType must be one of: ${IMPORT_TYPE.join(', ')}.`,
      );
    }

    const batch = await this.imports.createBatch(
      importType as ImportType,
      file.originalname,
      file.buffer,
      user.userId,
      // Optional: pin a worksheet instead of letting detection choose.
      { sheetName: sheetName?.trim() || null },
    );
    const { queued } = await this.processor.enqueue(user.tenantId, batch.batchId);
    return { ...batch, queued };
  }

  @Get()
  @RequirePermission(PERMISSIONS.INVENTORY_READ)
  async list(
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<ImportBatchListResponse> {
    return this.imports.listBatches(limit ? Number(limit) : 25, cursor ?? null);
  }

  /** Live progress: rows processed / created / updated / skipped / errored. */
  @Get(':id')
  @RequirePermission(PERMISSIONS.INVENTORY_READ)
  async detail(
    @Param('id') id: string,
    @Query(new ZodValidationPipe(ImportRowsQuerySchema)) q: ImportRowsQuery,
  ): Promise<ImportBatchDetailResponse> {
    return this.imports.batchDetail(id, q);
  }

  /**
   * The failed/skipped rows as CSV. Fixing a row and re-uploading resolves it
   * without re-processing anything that already succeeded — the successful rows
   * are simply not in this file.
   */
  @Get(':id/errors.csv')
  @RequirePermission(PERMISSIONS.INVENTORY_READ)
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="import-errors.csv"')
  async errorsCsv(@Param('id') id: string): Promise<string> {
    return this.imports.errorReportCsv(id);
  }

  /** Triage one quarantined row: create the SKU, map it, or discard the row. */
  @Post(':id/rows/:rowId/resolve')
  @RequirePermission(PERMISSIONS.INVENTORY_IMPORT)
  async resolveRow(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('rowId') rowId: string,
    @Body(new ZodValidationPipe(ImportRowResolveSchema)) dto: ImportRowResolve,
  ): Promise<{ ok: true; status: string }> {
    return this.imports.resolveRow(id, rowId, dto, user.userId);
  }

  /** Re-run the pending rows of a batch (after resolving quarantined rows). */
  @Post(':id/reprocess')
  @RequirePermission(PERMISSIONS.INVENTORY_IMPORT)
  async reprocess(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<{ queued: boolean }> {
    return this.processor.enqueue(user.tenantId, id);
  }
}
