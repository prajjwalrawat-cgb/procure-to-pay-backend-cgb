import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ApprovalsModule } from '../approvals/approvals.module';
import { CircuitBreaker } from '../common/integrations/circuit-breaker';
import type { Env } from '../config/env';
import { IntegrationUsageService } from '../integrations/integration-usage.service';
import { PublicRegistrationController } from './public-registration.controller';
import {
  CAPTCHA_PROVIDER,
  RealCaptchaProvider,
  SandboxCaptchaProvider,
} from './verification/captcha.provider';
import {
  PENNY_DROP_PROVIDER,
  RealPennyDropProvider,
  SandboxPennyDropProvider,
} from './verification/penny-drop.provider';
import {
  RealScreeningProvider,
  SandboxScreeningProvider,
  SCREENING_PROVIDER,
} from './verification/screening.provider';
import { VendorChangeService } from './vendor-change.service';
import { VendorDocumentService } from './vendor-document.service';
import { VendorLifecycleService } from './vendor-lifecycle.service';
import { VendorMaintenanceService } from './vendor-maintenance.service';
import { VendorOnboardingController } from './vendor-onboarding.controller';
import { VendorOnboardingService } from './vendor-onboarding.service';
import { VendorQueryService } from './vendor-query.service';
import { VendorScorecardService } from './vendor-scorecard.service';
import { VendorScreeningRefreshService } from './vendor-screening-refresh.service';
import { VendorVerificationService } from './vendor-verification.service';
import { VendorsController } from './vendors.controller';

/**
 * Vendor lifecycle (Slice 7). Invite / self-register → 6-step wizard with mock
 * statutory verifications, documents and screenings → Slice 2 approval
 * (VENDOR_ONBOARDING) → activation with a cold-start scorecard. Also owns the
 * suspend/blacklist lifecycle and post-activation change requests
 * (VENDOR_CHANGE). Reuses the approval engine + reads Slice 4/5/6 data for the
 * performance and risk scorecards.
 */
@Module({
  imports: [ApprovalsModule],
  controllers: [
    VendorsController,
    VendorOnboardingController,
    PublicRegistrationController,
  ],
  providers: [
    VendorOnboardingService,
    VendorVerificationService,
    VendorDocumentService,
    VendorScorecardService,
    VendorChangeService,
    VendorLifecycleService,
    VendorQueryService,
    VendorMaintenanceService,
    VendorScreeningRefreshService,
    // Slice 10b — real (simulator-backed) penny-drop behind a token/factory,
    // keyed on PENNY_DROP_API_URL (mirrors the Slice 10a OCR pattern).
    {
      provide: PENNY_DROP_PROVIDER,
      useFactory: (
        config: ConfigService<Env, true>,
        breaker: CircuitBreaker,
        usage: IntegrationUsageService,
      ) =>
        config.get('PENNY_DROP_API_URL', { infer: true })
          ? new RealPennyDropProvider(config)
          : new SandboxPennyDropProvider(breaker, usage),
      inject: [ConfigService, CircuitBreaker, IntegrationUsageService],
    },
    // Slice 10c — real (simulator-backed) statutory/compliance screening.
    {
      provide: SCREENING_PROVIDER,
      useFactory: (
        config: ConfigService<Env, true>,
        breaker: CircuitBreaker,
        usage: IntegrationUsageService,
      ) =>
        config.get('SCREENING_API_URL', { infer: true })
          ? new RealScreeningProvider(config)
          : new SandboxScreeningProvider(breaker, usage),
      inject: [ConfigService, CircuitBreaker, IntegrationUsageService],
    },
    // Slice 10c — reCAPTCHA v3 on public self-registration (sandbox stub default).
    {
      provide: CAPTCHA_PROVIDER,
      useFactory: (config: ConfigService<Env, true>, usage: IntegrationUsageService) =>
        config.get('RECAPTCHA_SECRET', { infer: true })
          ? new RealCaptchaProvider(config, usage)
          : new SandboxCaptchaProvider(usage),
      inject: [ConfigService, IntegrationUsageService],
    },
  ],
  exports: [VendorScorecardService, VendorDocumentService],
})
export class VendorsModule {}
