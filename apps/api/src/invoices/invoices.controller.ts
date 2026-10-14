import {
  BadRequestException,
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
  DocumentKindInputSchema,
  ExceptionResolutionInputSchema,
  HoldInputSchema,
  RejectInvoiceInputSchema,
  InvoiceCreateInputSchema,
  InvoiceListQuerySchema,
  PERMISSIONS,
  TaxInvoiceInputSchema,
  type AssignInput,
  type CommentInput,
  type DocumentKindInput,
  type ExceptionResolutionInput,
  type HoldInput,
  type RejectInvoiceInput,
  type InvoiceCreateInput,
  type InvoiceDetailResponse,
  type InvoiceListQuery,
  type InvoiceListResponse,
  type InvoiceTabCounts,
  type ResolveAndRouteResult,
  type TaxInvoiceInput,
} from '@procureflow/shared';
import { z } from 'zod';

import { newId } from '@procureflow/db';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import {
  INVOICE_OPERATE_SCOPES,
  INVOICE_READ_SCOPES,
  invoiceScope,
} from './invoice-scope';
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
  @RequirePermission(INVOICE_OPERATE_SCOPES)
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
  @RequirePermission(INVOICE_OPERATE_SCOPES)
  async hold(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(HoldInputSchema)) dto: HoldInput,
  ): Promise<{ ok: true }> {
    await this.assertVisible(user, id);
    await this.invoices.hold(id, dto.reason, user.userId);
    return { ok: true };
  }

  /**
   * Reject before approval — a duplicate or the wrong document. Gated on
   * resolve-exception like resolve-and-route: refusing a bill is a decision
   * about money, not an intake chore.
   */
  @Post(':id/reject')
  @RequirePermission(PERMISSIONS.INVOICE_RESOLVE_EXCEPTION)
  async reject(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RejectInvoiceInputSchema)) dto: RejectInvoiceInput,
  ): Promise<{ ok: true }> {
    await this.assertVisible(user, id);
    await this.invoices.reject(id, dto.reason, user.userId);
    return { ok: true };
  }

  @Post(':id/comments')
  @RequirePermission(INVOICE_OPERATE_SCOPES)
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

  /**
   * Re-queue extraction for an invoice stuck before the matcher ever ran.
   *
   * Gated on intake-manage OR resolve-exception, not resolve-exception alone.
   * Re-reading a document is an intake recovery, not a financial judgement — it
   * approves nothing and changes no amount — and `invoice:intake_manage` is the
   * permission that already covers "email queues + manual OCR review".
   *
   * The distinction matters for who ends up able to do it. A tenant admin holds
   * intake-manage but deliberately NOT resolve-exception: administering the
   * system and waving through invoice exceptions are separate duties, and the
   * first gating left an admin able to see a stranded invoice and unable to do
   * the one harmless thing that would free it.
   */
  @Post(':id/ocr/retry')
  @RequirePermission(INVOICE_OPERATE_SCOPES)
  async retryOcr(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<{ ok: true }> {
    return this.invoices.retryOcr(id, user.userId);
  }

  @Post(':id/match/run')
  @RequirePermission(INVOICE_OPERATE_SCOPES)
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
  ): Promise<ResolveAndRouteResult> {
    await this.assertVisible(user, id);
    return this.invoices.resolveAndRoute(id, user.userId);
  }

  /**
   * Proforma or tax invoice. Gated on resolve-exception, not intake: marking a
   * record as a proforma blocks its balance from being paid, which is a
   * decision about money rather than about intake.
   */
  @Post(':id/document-kind')
  @RequirePermission(PERMISSIONS.INVOICE_RESOLVE_EXCEPTION)
  async setDocumentKind(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(DocumentKindInputSchema)) dto: DocumentKindInput,
  ): Promise<{ ok: true }> {
    await this.assertVisible(user, id);
    await this.invoices.setDocumentKind(id, dto.kind, user.userId);
    return { ok: true };
  }

  /**
   * Store the tax invoice for a proforma and hand back its key. Two steps, like
   * the vendor portal, because the header and lines travel as JSON with it.
   */
  @Post(':id/tax-invoice/file')
  @RequirePermission(INVOICE_OPERATE_SCOPES)
  @UseInterceptors(FileInterceptor('file', DOCUMENT_UPLOAD_OPTIONS))
  async uploadTaxInvoiceFile(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @UploadedFile()
    file:
      | { originalname: string; buffer: Buffer; mimetype: string; size?: number }
      | undefined,
  ): Promise<{ s3Key: string }> {
    await this.assertVisible(user, id);
    assertUploadSize(file);
    if (!file?.buffer) {
      throw new BadRequestException('No file received — attach the tax invoice.');
    }
    const s3Key = `invoices/${user.tenantId}/${newId('invoiceAttachment')}-${safeFilename(file.originalname)}`;
    await this.storage.put(s3Key, file.buffer, file.mimetype ?? 'application/pdf');
    return { s3Key };
  }

  @Post(':id/tax-invoice')
  @RequirePermission(INVOICE_OPERATE_SCOPES)
  async attachTaxInvoice(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(TaxInvoiceInputSchema)) dto: TaxInvoiceInput,
  ): Promise<{ ok: true }> {
    await this.assertVisible(user, id);
    // The key comes back from the browser, so it is re-checked: this tenant's
    // invoice prefix, and an object that actually exists.
    if (!dto.s3Key.startsWith(`invoices/${user.tenantId}/`)) {
      throw new BadRequestException('Upload the tax invoice before attaching it.');
    }
    if (!(await this.storage.exists(dto.s3Key))) {
      throw new BadRequestException(
        'The uploaded tax invoice could not be found in storage — attach it again.',
      );
    }
    await this.invoices.attachTaxInvoice(id, dto, { id: user.userId, type: 'USER' });
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
