import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ApprovalsModule } from '../approvals/approvals.module';
import { DomainEventsModule } from '../common/events/domain-event.service';
import { StorageModule, StorageService } from '../common/storage/storage.service';
import type { Env } from '../config/env';
import { MsmeService } from './domain/msme.service';
import { TdsService } from './domain/tds.service';
import { EmailIntakeService } from './email-intake/email-intake.service';
import { IntakeController } from './email-intake/intake.controller';
import { InvoiceQueryService } from './invoice-query.service';
import { InvoiceService } from './invoice.service';
import { InvoicesController } from './invoices.controller';
import { MatchService } from './match.service';
import { MockOcrProvider } from './ocr/ocr.provider';
import { OcrProcessor } from './ocr/ocr.processor';
import { OcrService } from './ocr/ocr.service';
import { OCR_PROVIDER } from './ocr/ocr.token';
import { RealOcrProvider } from './ocr/real-ocr.provider';
import { SandboxOcrProvider } from './ocr/sandbox-ocr.provider';
import { RefsController } from './refs.controller';
import { RefsService } from './refs.service';
import { VendorInvoiceService } from './vendor-invoice.service';
import { VendorInvoicesController } from './vendor-invoices.controller';

@Module({
  imports: [DomainEventsModule, StorageModule, ApprovalsModule],
  controllers: [
    InvoicesController,
    VendorInvoicesController,
    RefsController,
    IntakeController,
  ],
  providers: [
    InvoiceService,
    InvoiceQueryService,
    MatchService,
    RefsService,
    VendorInvoiceService,
    TdsService,
    MsmeService,
    OcrService,
    MockOcrProvider,
    OcrProcessor,
    EmailIntakeService,
    // Real vs sandbox OCR is a config switch (OCR_API_URL) behind the unchanged
    // IOcrProvider interface — MatchEngine + the pipeline need zero changes.
    {
      provide: OCR_PROVIDER,
      useFactory: (config: ConfigService<Env, true>, storage: StorageService) =>
        config.get('OCR_API_URL', { infer: true })
          ? new RealOcrProvider(config, storage)
          : new SandboxOcrProvider(),
      inject: [ConfigService, StorageService],
    },
  ],
  exports: [InvoiceService, MatchService],
})
export class InvoicesModule {}
