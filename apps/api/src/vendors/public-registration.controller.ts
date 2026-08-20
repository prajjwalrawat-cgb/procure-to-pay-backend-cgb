import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  AcceptInviteInputSchema,
  SelfRegistrationInputSchema,
  VENDOR_CATEGORY_CONFIGS,
  VerifyEmailInputSchema,
  type VendorCategoryOption,
  type AcceptInviteInput,
  type SelfRegistrationInput,
  type VerifyEmailInput,
} from '@procureflow/shared';

import { Public } from '../auth/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { VendorCategoriesService } from '../settings/vendor-categories.service';
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
  constructor(
    private readonly onboarding: VendorOnboardingService,
    private readonly categories: VendorCategoriesService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Categories the registration form offers. `tenant` is the id the buyer-issued
   * link carries; with it the vendor sees that organisation's own categories,
   * and without it (a link that lost its query string) the shipped starter set,
   * so the form still renders rather than showing an empty dropdown.
   */
  @Public()
  @Get('categories')
  async listCategories(
    @Query('tenant') tenantId?: string,
  ): Promise<VendorCategoryOption[]> {
    if (!tenantId) return shippedCategoryOptions();
    // No JWT here, so the tenant context has to be opened explicitly for RLS.
    return this.prisma
      .runInTenantContext(tenantId, () => this.categories.options(tenantId))
      .catch(() => shippedCategoryOptions());
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

  /** Buyer-invited vendor sets their own password from the emailed magic link. */
  @Public()
  @Post('accept-invite')
  async acceptInvite(
    @Body(new ZodValidationPipe(AcceptInviteInputSchema)) dto: AcceptInviteInput,
  ): Promise<{ email: string }> {
    return this.onboarding.acceptInvite(dto.tenantId, dto.token, dto.password);
  }
}

/** Fallback for a registration link with no tenant on it. */
function shippedCategoryOptions(): VendorCategoryOption[] {
  return VENDOR_CATEGORY_CONFIGS.map((c) => ({
    key: c.categoryKey,
    displayName: c.displayName,
    slaHours: c.slaHours,
    requiredDocuments: c.requiredDocuments,
    optionalDocuments: c.optionalDocuments,
  }));
}
