import { Body, Controller, Get, Headers, Ip, Param, Post, Put } from '@nestjs/common';
import {
  AcknowledgeCocInputSchema,
  ONBOARDING_STEP_SCHEMAS,
  PERMISSIONS,
  VendorChangeRequestInputSchema,
  VendorDocumentUploadSchema,
  type AcknowledgeCocInput,
  type SaveStepInput,
  type VendorChangeRequestInput,
  type VendorDocumentUpload,
} from '@procureflow/shared';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequireAudience, RequirePermission } from '../auth/decorators';
import { ZodValidationError } from '../common/errors/domain-error';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { VendorChangeService } from './vendor-change.service';
import { VendorDocumentService } from './vendor-document.service';
import { VendorOnboardingService } from './vendor-onboarding.service';

/** Vendor-portal onboarding wizard — vendor JWT audience only (§3 rule #11). */
@Controller('vendor/onboarding')
@RequireAudience('vendor')
export class VendorOnboardingController {
  constructor(
    private readonly onboarding: VendorOnboardingService,
    private readonly documents: VendorDocumentService,
    private readonly changes: VendorChangeService,
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
