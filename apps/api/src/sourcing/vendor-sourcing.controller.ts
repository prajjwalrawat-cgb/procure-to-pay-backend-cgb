import { createHash } from 'node:crypto';

import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  PayloadTooLargeException,
  Post,
  Sse,
  UploadedFile,
  UseInterceptors,
  type MessageEvent,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { newId } from '@procureflow/db';
import {
  PERMISSIONS,
  QUOTE_ATTACHMENT_TYPE,
  QUOTE_ENVELOPE,
  QuoteAttachmentInputSchema,
  QuoteCreateInputSchema,
  QuoteUpdateInputSchema,
  QuoteWithdrawInputSchema,
  ReverseAuctionBidInputSchema,
  RfqDeclineInputSchema,
  RfqQuestionInputSchema,
  type QuoteAttachmentInput,
  type QuoteCreateInput,
  type QuoteUpdateInput,
  type QuoteView,
  type QuoteWithdrawInput,
  type ReverseAuctionBidInput,
  type RfqDeclineInput,
  type RfqDetailResponse,
  type RfqQuestionInput,
  type RfqQuestionView,
  type VendorRfqListResponse,
} from '@procureflow/shared';
import type { Observable } from 'rxjs';
import { z } from 'zod';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequireAudience, RequirePermission } from '../auth/decorators';
import { ZodValidationError } from '../common/errors/domain-error';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { StorageService } from '../common/storage/storage.service';
import {
  DOCUMENT_UPLOAD_OPTIONS,
  assertUploadSize,
  safeFilename,
} from '../common/upload/upload-options';
import { QuoteService } from './quote.service';
import { ReverseAuctionService } from './reverse-auction.service';
import { RfqQaService } from './rfq-qa.service';
import { VendorRfqService } from './vendor-rfq.service';

const MAX_QUOTE_DOC_BYTES = 10 * 1024 * 1024;

/** Multipart fields that ride alongside the uploaded quote document. */
const QuoteUploadMetaSchema = z.object({
  envelope: z.enum(QUOTE_ENVELOPE).default('COMMERCIAL'),
  docType: z.enum(QUOTE_ATTACHMENT_TYPE).default('COMMERCIAL_BID'),
});

/** Vendor-portal sourcing endpoints — vendor JWT audience only (§3 rule #11). */
@Controller('vendor')
@RequireAudience('vendor')
export class VendorSourcingController {
  constructor(
    private readonly vendorRfq: VendorRfqService,
    private readonly quotes: QuoteService,
    private readonly qa: RfqQaService,
    private readonly reverseAuction: ReverseAuctionService,
    private readonly storage: StorageService,
  ) {}

  @Get('rfq')
  @RequirePermission(PERMISSIONS.VENDOR_RFQ_READ)
  async list(@CurrentUser() user: AuthUser): Promise<VendorRfqListResponse> {
    return this.vendorRfq.listInvited(user.userId);
  }

  @Get('rfq/:id')
  @RequirePermission(PERMISSIONS.VENDOR_RFQ_READ)
  async detail(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<RfqDetailResponse> {
    return this.vendorRfq.detail(user.userId, id);
  }

  @Get('rfq/:id/questions')
  @RequirePermission(PERMISSIONS.VENDOR_RFQ_READ)
  async questions(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<RfqQuestionView[]> {
    return this.qa.listQuestions(id, { isVendor: true, userId: user.userId });
  }

  @Post('rfq/:id/acknowledge')
  @RequirePermission(PERMISSIONS.VENDOR_RFQ_READ)
  async acknowledge(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    return this.vendorRfq.acknowledge(user.userId, id);
  }

  @Post('rfq/:id/decline')
  @RequirePermission(PERMISSIONS.VENDOR_RFQ_READ)
  async decline(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RfqDeclineInputSchema)) dto: RfqDeclineInput,
  ): Promise<{ ok: true }> {
    return this.vendorRfq.decline(user.userId, id, dto.reason);
  }

  @Post('rfq/:id/questions')
  @RequirePermission(PERMISSIONS.VENDOR_QUOTE_MANAGE)
  async ask(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RfqQuestionInputSchema)) dto: RfqQuestionInput,
  ): Promise<{ id: string }> {
    return this.qa.askQuestion(id, dto, user.userId);
  }

  @Get('quotes')
  @RequirePermission(PERMISSIONS.VENDOR_QUOTE_MANAGE)
  async myQuotes(@CurrentUser() user: AuthUser): Promise<QuoteView[]> {
    return this.vendorRfq.myQuotes(user.userId);
  }

  @Get('quotes/:id')
  @RequirePermission(PERMISSIONS.VENDOR_QUOTE_MANAGE)
  async quote(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<QuoteView> {
    return this.vendorRfq.myQuote(user.userId, id);
  }

  @Post('quotes')
  @RequirePermission(PERMISSIONS.VENDOR_QUOTE_MANAGE)
  async createQuote(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(QuoteCreateInputSchema)) dto: QuoteCreateInput,
  ): Promise<{ id: string }> {
    return this.quotes.createDraft(dto, user.userId);
  }

  @Patch('quotes/:id')
  @RequirePermission(PERMISSIONS.VENDOR_QUOTE_MANAGE)
  async updateQuote(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(QuoteUpdateInputSchema)) dto: QuoteUpdateInput,
  ): Promise<{ ok: true }> {
    return this.quotes.updateDraft(id, dto, user.userId);
  }

  /** Metadata-only, for callers that uploaded to S3 themselves. */
  @Post('quotes/:id/attachments')
  @RequirePermission(PERMISSIONS.VENDOR_QUOTE_MANAGE)
  async attach(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(QuoteAttachmentInputSchema)) dto: QuoteAttachmentInput,
  ): Promise<{ id: string }> {
    return this.quotes.attachFile(id, dto, user.userId);
  }

  /**
   * Real file upload for a quote document — the vendor's own quotation PDF,
   * spec sheet or certificate. Same shape as the onboarding document upload:
   * bytes come to the API (no bucket CORS to configure), the interceptor
   * enforces the MIME allow-list and size cap, and the sha256 of the bytes is
   * the integrity anchor stored alongside the record.
   */
  @Post('quotes/:id/attachments/upload')
  @RequirePermission(PERMISSIONS.VENDOR_QUOTE_MANAGE)
  @UseInterceptors(FileInterceptor('file', DOCUMENT_UPLOAD_OPTIONS))
  async uploadAttachment(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @UploadedFile()
    file:
      | { originalname: string; buffer: Buffer; mimetype: string; size?: number }
      | undefined,
    @Body(new ZodValidationPipe(QuoteUploadMetaSchema))
    meta: z.infer<typeof QuoteUploadMetaSchema>,
  ): Promise<{ id: string; filename: string; sizeBytes: number }> {
    assertUploadSize(file);
    if (!file?.buffer) {
      throw new ZodValidationError('No file was uploaded.', {
        issues: [{ path: 'file', message: 'A file is required.' }],
      });
    }
    const sizeBytes = file.size ?? file.buffer.byteLength;
    if (sizeBytes > MAX_QUOTE_DOC_BYTES) {
      throw new PayloadTooLargeException(
        `Document exceeds the ${MAX_QUOTE_DOC_BYTES / (1024 * 1024)} MB limit.`,
      );
    }
    const filename = safeFilename(file.originalname);
    const s3Key = `quote-documents/${user.tenantId}/${id}/${newId('quoteAttachment')}-${filename}`;
    await this.storage.put(s3Key, file.buffer, file.mimetype);
    const { id: attachmentId } = await this.quotes.attachFile(
      id,
      {
        envelope: meta.envelope,
        docType: meta.docType,
        s3Key,
        filename,
        sizeBytes,
        mimeType: file.mimetype,
        fileHash: createHash('sha256').update(file.buffer).digest('hex'),
      },
      user.userId,
    );
    return { id: attachmentId, filename, sizeBytes };
  }

  @Post('quotes/:id/submit')
  @RequirePermission(PERMISSIONS.VENDOR_QUOTE_MANAGE)
  async submit(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<{ submissionHash: string; short: string }> {
    return this.quotes.submit(id, user.userId);
  }

  @Post('quotes/:id/withdraw')
  @RequirePermission(PERMISSIONS.VENDOR_QUOTE_MANAGE)
  async withdraw(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(QuoteWithdrawInputSchema)) dto: QuoteWithdrawInput,
  ): Promise<{ ok: true }> {
    return this.quotes.withdraw(id, dto.reason, user.userId);
  }

  @Post('rfq/:id/reverse-auction/bid')
  @RequirePermission(PERMISSIONS.VENDOR_QUOTE_MANAGE)
  async bid(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(ReverseAuctionBidInputSchema))
    dto: ReverseAuctionBidInput,
    @Param('id') _id: string,
  ): Promise<{ accepted: true; extended: boolean }> {
    return this.reverseAuction.submitBidAsUser(dto.roundId, dto, user.userId);
  }

  @Sse('rfq/:id/reverse-auction/:roundId/leaderboard/stream')
  @RequireAudience('vendor')
  @RequirePermission(PERMISSIONS.VENDOR_RFQ_READ)
  stream(
    @CurrentUser() user: AuthUser,
    @Param('roundId') roundId: string,
  ): Observable<MessageEvent> {
    return this.reverseAuction.streamForUser(
      roundId,
      user.userId,
    ) as unknown as Observable<MessageEvent>;
  }
}
