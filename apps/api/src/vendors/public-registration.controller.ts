import { Body, Controller, Get, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  SelfRegistrationInputSchema,
  VENDOR_CATEGORY_CONFIGS,
  VerifyEmailInputSchema,
  type SelfRegistrationInput,
  type VerifyEmailInput,
} from '@procureflow/shared';

import { Public } from '../auth/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { VendorOnboardingService } from './vendor-onboarding.service';

/**
 * Public vendor self-registration (no JWT). The service opens its own tenant
 * context for the writes (Slice 7 §2). Multi-tenant routing by subdomain is a
 * later concern; the demo tenant is resolved server-side.
 */
// Public, unauthenticated, internet-facing → strictest limit (per IP): 5/min.
// The highest-abuse-risk endpoint in the system (Slice 11b security review).
@Throttle({ default: { limit: 5, ttl: 60_000 } })
@Controller('public/vendors')
export class PublicRegistrationController {
  constructor(private readonly onboarding: VendorOnboardingService) {}

  @Public()
  @Get('categories')
  categories(): Array<{ key: string; displayName: string; slaHours: number }> {
    return VENDOR_CATEGORY_CONFIGS.map((c) => ({
      key: c.categoryKey,
      displayName: c.displayName,
      slaHours: c.slaHours,
    }));
  }

  @Public()
  @Post('register')
  async register(
    @Body(new ZodValidationPipe(SelfRegistrationInputSchema)) dto: SelfRegistrationInput,
  ): Promise<{ vendorId: string; token: string }> {
    return this.onboarding.startSelfRegistration(dto);
  }

  @Public()
  @Post('verify-email')
  async verifyEmail(
    @Body(new ZodValidationPipe(VerifyEmailInputSchema)) dto: VerifyEmailInput,
  ): Promise<{ vendorId: string }> {
    return this.onboarding.verifyEmail(dto.token);
  }
}
