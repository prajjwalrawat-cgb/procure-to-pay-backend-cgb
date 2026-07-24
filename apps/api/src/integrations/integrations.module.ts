import { Global, Module } from '@nestjs/common';

import { CircuitBreaker } from '../common/integrations/circuit-breaker';
import { GspClient } from './gsp/gsp-client';
import { IntegrationUsageService } from './integration-usage.service';
import { IntegrationsController } from './integrations.controller';
import { TenantCredentialService } from './tenant-credential.service';

/**
 * Integrations module (Slice 10a). The shared integration substrate — the
 * encrypted credential vault, the usage/cost ledger, the GSP client, and one
 * process-wide circuit breaker — reused by invoices (OCR), compliance
 * (GSTR-2B/IRN/e-Way), and later 10b/10c. Global so any module can inject them.
 */
@Global()
@Module({
  controllers: [IntegrationsController],
  providers: [
    TenantCredentialService,
    IntegrationUsageService,
    GspClient,
    // One breaker instance shared across all providers; per-key isolation is
    // handled internally (e.g. `ocr:extract`, `gsp:gstr2b:<tenant>`).
    { provide: CircuitBreaker, useFactory: () => new CircuitBreaker() },
  ],
  exports: [TenantCredentialService, IntegrationUsageService, GspClient, CircuitBreaker],
})
export class IntegrationsModule {}
