import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ApprovalsModule } from '../approvals/approvals.module';
import { CircuitBreaker } from '../common/integrations/circuit-breaker';
import { DomainEventsModule } from '../common/events/domain-event.service';
import { StorageModule } from '../common/storage/storage.service';
import type { Env } from '../config/env';
import { IntegrationUsageService } from '../integrations/integration-usage.service';
import { MsmeService } from '../invoices/domain/msme.service';
import { TdsService } from '../invoices/domain/tds.service';
import { BankAccountService } from './bank-account.service';
import { BankFileService } from './bank-file.service';
import { BankSubmissionService } from './banking/bank-submission.service';
import {
  BANK_GATEWAY,
  RealBankGateway,
  SandboxBankGateway,
} from './banking/bank-gateway';
import { UtrReconciliationService } from './banking/utr-reconciliation.service';
import { PaymentRunComposerService } from './payment-run-composer.service';
import { PaymentRunMsmeService } from './payment-run-msme.service';
import { PaymentRunQueryService } from './payment-run-query.service';
import { PaymentRunService } from './payment-run.service';
import { PaymentRunsController } from './payment-runs.controller';
import { VendorBankController } from './vendor-bank.controller';
import { VendorBankVerificationService } from './vendor-bank-verification.service';

/**
 * Payment runs (Slice 3). Composes batches from approved invoices, produces the
 * tenant's bank file via the shared formatters, routes through the generic
 * approval engine (Slice 2), and posts invoices as PAID on submission (stub UTR).
 */
@Module({
  imports: [ApprovalsModule, DomainEventsModule, StorageModule],
  controllers: [PaymentRunsController, VendorBankController],
  providers: [
    PaymentRunComposerService,
    PaymentRunService,
    PaymentRunQueryService,
    PaymentRunMsmeService,
    BankAccountService,
    BankFileService,
    VendorBankVerificationService,
    TdsService,
    MsmeService,
    // Slice 10b — real (simulator-backed) bank submission + UTR reconciliation.
    BankSubmissionService,
    UtrReconciliationService,
    {
      provide: BANK_GATEWAY,
      useFactory: (
        config: ConfigService<Env, true>,
        breaker: CircuitBreaker,
        usage: IntegrationUsageService,
      ) =>
        config.get('BANK_API_URL', { infer: true })
          ? new RealBankGateway(config)
          : new SandboxBankGateway(breaker, usage),
      inject: [ConfigService, CircuitBreaker, IntegrationUsageService],
    },
  ],
  exports: [PaymentRunService],
})
export class PaymentRunsModule {}
