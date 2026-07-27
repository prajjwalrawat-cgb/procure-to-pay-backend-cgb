import { createHash } from 'node:crypto';

import {
  Body,
  Controller,
  Get,
  Headers,
  Ip,
  Param,
  PayloadTooLargeException,
  Post,
  Put,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { newId } from '@procureflow/db';
import {
  AcknowledgeCocInputSchema,
  ONBOARDING_STEP_SCHEMAS,
  PERMISSIONS,
  VENDOR_DOCUMENT_TYPE,
  VendorChangeRequestInputSchema,
  VendorDocumentUploadSchema,
  type AcknowledgeCocInput,
  type SaveStepInput,
  type VendorChangeRequestInput,
  type VendorDocumentUpload,
} from '@procureflow/shared';
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
import { VendorChangeService } from './vendor-change.service';
import { VendorDocumentService } from './vendor-document.service';
import { VendorOnboardingService } from './vendor-onboarding.service';

/** VendorDocument.sizeBytes is capped at 10 MB, below the 15 MB interceptor cap. */
const MAX_VENDOR_DOC_BYTES = 10 * 1024 * 1024;

/** Multipart fields alongside the file. Everything arrives as a string. */
const DocumentUploadMetaSchema = z.object({
  docType: z.enum(VENDOR_DOCUMENT_TYPE),
  documentNumber: z.string().max(80).nullish(),
  validFrom: z.string().datetime().nullish(),
  validTo: z.string().datetime().nullish(),
});

/** Vendor-portal onboarding wizard — vendor JWT audience only (§3 rule #11). */
@Controller('vendor/onboarding')
@RequireAudience('vendor')
export class VendorOnboardingController {
  constructor(
    private readonly onboarding: VendorOnboardingService,
    private readonly documents: VendorDocumentService,
    private readonly changes: VendorChangeService,
    private readonly storage: StorageService,
  ) {}

  @Get()
  @RequirePermission(PERMISSIONS.VENDOR_ONBOARDING_MANAGE)
  async resume(@CurrentUser() user: AuthUser): Promise<unknown> {
    return this.onboarding.resumeOnboarding(user.userId);
  }

  @Put('steps/:stepNumber')
  @RequirePermission(PERMISSIONS.VENDOR_ONBOARDING_MANAGE)
  async saveStep(
    @CurrentUser() user: AuthUser,
    @Param('stepNumber') stepNumber: string,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const n = Number(stepNumber);
    const schema = ONBOARDING_STEP_SCHEMAS[n];
    if (!schema) {
      throw new ZodValidationError('Unknown onboarding step', {
        issues: [
          { path: 'stepNumber', message: `Step must be 1–6, received "${stepNumber}".` },
        ],
      });
    }
    // Validate against THIS step's schema (never the union — see ONBOARDING_STEP_SCHEMAS).
    const dto = new ZodValidationPipe(schema).transform(body, {
      type: 'body',
    }) as SaveStepInput;
    return this.onboarding.saveStep(user.userId, n, dto);
  }

  /**
   * Real file upload for an onboarding document: the bytes are streamed to the
   * API (multipart), stored in S3, then recorded. Size cap and MIME allow-list
   * are enforced by the interceptor before the handler runs, same as the invoice
   * upload path.
   *
   * The browser posts to the API rather than straight to S3 deliberately —
   * a presigned PUT would need CORS configured on the bucket, and these files
   * are small enough that proxying them costs nothing.
   */
  @Post('documents/upload')
  @RequirePermission(PERMISSIONS.VENDOR_ONBOARDING_MANAGE)
  @UseInterceptors(FileInterceptor('file', DOCUMENT_UPLOAD_OPTIONS))
  async uploadDocumentFile(
    @CurrentUser() user: AuthUser,
    @UploadedFile()
    file:
      | { originalname: string; buffer: Buffer; mimetype: string; size?: number }
      | undefined,
    @Body(new ZodValidationPipe(DocumentUploadMetaSchema))
    meta: z.infer<typeof DocumentUploadMetaSchema>,
  ): Promise<{
    id: string;
    s3Key: string;
    filename: string;
    sizeBytes: number;
    url: string;
  }> {
    assertUploadSize(file);
    if (!file?.buffer) {
      throw new ZodValidationError('No file was uploaded.', {
        issues: [{ path: 'file', message: 'A file is required.' }],
      });
    }
    const sizeBytes = file.size ?? file.buffer.byteLength;
    if (sizeBytes > MAX_VENDOR_DOC_BYTES) {
      throw new PayloadTooLargeException(
        `Document exceeds the ${MAX_VENDOR_DOC_BYTES / (1024 * 1024)} MB limit.`,
      );
    }

    const vendorId = await this.onboarding.resolveVendorId(user.userId);
    const filename = safeFilename(file.originalname);
    const s3Key = `vendor-documents/${user.tenantId}/${vendorId}/${newId('vendorDocument')}-${filename}`;
    await this.storage.put(s3Key, file.buffer, file.mimetype);

    // sha256 of the actual bytes — the integrity anchor for later verification.
    const fileHash = createHash('sha256').update(file.buffer).digest('hex');
    const { id } = await this.documents.uploadDocument(
      vendorId,
      {
        docType: meta.docType,
        s3Key,
        filename,
        sizeBytes,
        fileHash,
        mimeType: file.mimetype,
        documentNumber: meta.documentNumber ?? null,
        validFrom: meta.validFrom ?? null,
        validTo: meta.validTo ?? null,
      },
      user.userId,
    );
    // Hand back a presigned URL so the vendor can immediately confirm they
    // uploaded the right file, without a round-trip to refetch the wizard.
    const url = await this.storage.presignedGetUrl(s3Key).catch(() => '');
    return { id, s3Key, filename, sizeBytes, url };
  }

  /** Metadata-only registration, for callers that uploaded to S3 themselves. */
  @Post('documents')
  @RequirePermission(PERMISSIONS.VENDOR_ONBOARDING_MANAGE)
  async uploadDocument(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(VendorDocumentUploadSchema)) dto: VendorDocumentUpload,
  ): Promise<{ id: string }> {
    const vendorId = await this.onboarding.resolveVendorId(user.userId);
    return this.documents.uploadDocument(vendorId, dto, user.userId);
  }

  @Post('coc')
  @RequirePermission(PERMISSIONS.VENDOR_ONBOARDING_MANAGE)
  async acknowledgeCoc(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(AcknowledgeCocInputSchema)) dto: AcknowledgeCocInput,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<{ ok: true }> {
    return this.onboarding.acknowledgeCoc(
      user.userId,
      dto,
      ip ?? null,
      userAgent ?? null,
    );
  }

  @Post('submit')
  @RequirePermission(PERMISSIONS.VENDOR_ONBOARDING_MANAGE)
  async submit(@CurrentUser() user: AuthUser): Promise<{ ok: true }> {
    return this.onboarding.submitOnboarding(user.userId);
  }

  /** Post-activation self-service change request (bank/GSTIN/contact/…). */
  @Post('changes')
  @RequirePermission(PERMISSIONS.VENDOR_ONBOARDING_MANAGE)
  async requestChange(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(VendorChangeRequestInputSchema))
    dto: VendorChangeRequestInput,
  ): Promise<{ id: string; status: string }> {
    const vendorId = await this.onboarding.resolveVendorId(user.userId);
    return this.changes.requestChange(vendorId, dto, user.userId);
  }
}
