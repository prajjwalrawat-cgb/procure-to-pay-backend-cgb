import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  DOCUMENT_UPLOAD_OPTIONS,
  assertUploadSize,
  safeFilename,
} from '../common/upload/upload-options';
import {
  AssignInputSchema,
  CommentInputSchema,
  ExceptionResolutionInputSchema,
  HoldInputSchema,
  InvoiceCreateInputSchema,
  InvoiceListQuerySchema,
  PERMISSIONS,
  type AssignInput,
  type CommentInput,
  type ExceptionResolutionInput,
  type HoldInput,
  type InvoiceCreateInput,
  type InvoiceDetailResponse,
  type InvoiceListQuery,
  type InvoiceListResponse,
  type InvoiceTabCounts,
} from '@procureflow/shared';
import { z } from 'zod';

import { newId } from '@procureflow/db';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { INVOICE_READ_SCOPES, invoiceScope } from './invoice-scope';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { StorageService } from '../common/storage/storage.service';
import { InvoiceQueryService } from './invoice-query.service';
import { InvoiceService } from './invoice.service';
import { MatchService } from './match.service';

const UploadMetaSchema = z.object({
  vendorId: z.string().min(1),
  poId: z.string().nullish(),
  vendorInvoiceRef: z.string().min(1),
});

@Controller('invoices')
export class InvoicesController {
  constructor(
    private readonly invoices: InvoiceService,
    private readonly query: InvoiceQueryService,
    private readonly match: MatchService,
    private readonly storage: StorageService,
  ) {}

  @Get()
  @RequirePermission(INVOICE_READ_SCOPES)
  async list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(InvoiceListQuerySchema)) q: InvoiceListQuery,
  ): Promise<InvoiceListResponse> {
    return this.query.find(q, invoiceScope(user));
  }

  @Get('counts')
  @RequirePermission(INVOICE_READ_SCOPES)
  async counts(@CurrentUser() user: AuthUser): Promise<InvoiceTabCounts> {
    return this.query.getTabCounts(invoiceScope(user));
  }

  @Get(':id')
  @RequirePermission(INVOICE_READ_SCOPES)
  async detail(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<InvoiceDetailResponse> {
    return this.query.findById(id, user.userId, invoiceScope(user));
  }

  @Post()
  @RequirePermission(PERMISSIONS.INVOICE_CREATE)
  async create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(InvoiceCreateInputSchema)) dto: InvoiceCreateInput,
  ): Promise<{ id: string }> {
    const id = await this.invoices.create(user.tenantId, user.userId, dto);
    return { id };
  }

  @Post('upload')
  @RequirePermission(PERMISSIONS.INVOICE_CREATE)
  @UseInterceptors(FileInterceptor('file', DOCUMENT_UPLOAD_OPTIONS))
  async upload(
    @CurrentUser() user: AuthUser,
    @UploadedFile()
    file:
      | { originalname: string; buffer: Buffer; mimetype: string; size?: number }
      | undefined,
    @Body(new ZodValidationPipe(UploadMetaSchema)) meta: z.infer<typeof UploadMetaSchema>,
  ): Promise<{ id: string; s3Key: string }> {
    // Slice 11b — size cap + MIME allow-list are enforced by the interceptor;
    // sanitise the filename before it becomes part of the object key.
    assertUploadSize(file);
    const s3Key = `invoices/${user.tenantId}/${newId('invoiceAttachment')}-${safeFilename(file?.originalname)}`;
    if (file?.buffer) {
      await this.storage.put(s3Key, file.buffer, file.mimetype ?? 'application/pdf');
    }
    const id = await this.invoices.createFromUpload(user.tenantId, user.userId, {
      vendorId: meta.vendorId,
      poId: meta.poId ?? null,
      vendorInvoiceRef: meta.vendorInvoiceRef,
      s3Key,
    });
    return { id, s3Key };
  }

  @Post(':id/assign')
  @RequirePermission(PERMISSIONS.INVOICE_RESOLVE_EXCEPTION)
  async assign(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AssignInputSchema)) dto: AssignInput,
  ): Promise<{ ok: true }> {
    await this.assertVisible(user, id);
    await this.invoices.assign(id, dto.userId, user.userId);
    return { ok: true };
  }

  @Post(':id/hold')
  @RequirePermission(PERMISSIONS.INVOICE_RESOLVE_EXCEPTION)
  async hold(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(HoldInputSchema)) dto: HoldInput,
  ): Promise<{ ok: true }> {
    await this.assertVisible(user, id);
    await this.invoices.hold(id, dto.reason, user.userId);
    return { ok: true };
  }

  @Post(':id/comments')
  @RequirePermission(PERMISSIONS.INVOICE_RESOLVE_EXCEPTION)
  async comment(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CommentInputSchema)) dto: CommentInput,
  ): Promise<{ ok: true }> {
    await this.assertVisible(user, id);
    await this.invoices.addComment(id, user.userId, dto.body);
    return { ok: true };
  }

  @Post(':id/exceptions/:excId/resolve')
  @RequirePermission(PERMISSIONS.INVOICE_RESOLVE_EXCEPTION)
  async resolve(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('excId') excId: string,
    @Body(new ZodValidationPipe(ExceptionResolutionInputSchema))
    dto: ExceptionResolutionInput,
  ): Promise<{ ok: true }> {
    await this.assertVisible(user, id);
    await this.match.resolveException(
      id,
      excId,
      dto.action,
      dto.notes ?? null,
      user.userId,
    );
    return { ok: true };
  }

  @Post(':id/match/run')
  @RequirePermission(PERMISSIONS.INVOICE_RESOLVE_EXCEPTION)
  async runMatch(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    await this.assertVisible(user, id);
    await this.match.runFor(id, user.userId);
    return { ok: true };
  }

  @Post(':id/resolve-and-route')
  @RequirePermission(PERMISSIONS.INVOICE_RESOLVE_EXCEPTION)
  async resolveAndRoute(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    await this.assertVisible(user, id);
    await this.invoices.resolveAndRoute(id, user.userId);
    return { ok: true };
  }

  /**
   * Acting on an invoice needs the same visibility as reading it. Every action
   * route below is gated on `invoice:resolve_exception`, which procurement
   * holds tenant-wide — without this, a buyer who cannot open somebody else's
   * invoice could still comment on it or push it into approval by id.
   */
  private async assertVisible(user: AuthUser, id: string): Promise<void> {
    await this.query.assertVisible(id, invoiceScope(user));
  }
}
