import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker, type ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';
import { PinoLogger } from 'nestjs-pino';

import {
  CircuitBreaker,
  CircuitOpenError,
} from '../../common/integrations/circuit-breaker';
import { guardBullMq } from '../../common/queue/queue-guard';
import type { Env } from '../../config/env';
import { IntegrationUsageService } from '../../integrations/integration-usage.service';
import { InvoiceService } from '../invoice.service';
import type { IOcrProvider } from './ocr.provider';
import { OCR_PROVIDER } from './ocr.token';
import { OCR_QUEUE, type OcrJobData } from './ocr.service';

/**
 * BullMQ worker that runs OCR extraction and feeds the result into the invoice
 * pipeline (applyOcr → confidence routing → 3-way match). Slice 10a wraps the
 * provider call in the shared circuit breaker + retry (ADR-032), logs per-document
 * cost to IntegrationUsageLog, and — critically — routes a permanent provider
 * failure to `OCR_FAILED` (manual data-entry fallback) so an invoice is NEVER lost.
 */
@Injectable()
export class OcrProcessor implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker<OcrJobData>;
  private connection?: IORedis;

  constructor(
    private readonly config: ConfigService<Env, true>,
    @Inject(OCR_PROVIDER) private readonly provider: IOcrProvider,
    private readonly invoices: InvoiceService,
    private readonly breaker: CircuitBreaker,
    private readonly usage: IntegrationUsageService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(OcrProcessor.name);
  }

  onModuleInit(): void {
    if (this.config.get('DISABLE_BACKGROUND_JOBS', { infer: true })) return;
    this.connection = new IORedis(this.config.get('REDIS_URL', { infer: true }), {
      maxRetriesPerRequest: null,
    });
    this.worker = new Worker<OcrJobData>(OCR_QUEUE, (job) => this.process(job.data), {
      connection: this.connection as unknown as ConnectionOptions,
    });
    this.worker.on('failed', (job, err) => {
      this.logger.error({ jobId: job?.id, err: err.message }, 'OCR job failed');
    });
    guardBullMq(OCR_QUEUE, { connection: this.connection, worker: this.worker }, (m) =>
      this.logger.error(m),
    );
  }

  /** Extract → apply, with retry/circuit-breaker + graceful OCR_FAILED fallback. */
  async process(data: OcrJobData): Promise<void> {
    const { invoiceId, tenantId, s3Key } = data;
    const simulated = !this.config.get('OCR_API_URL', { infer: true });
    const started = Date.now();
    try {
      // breaker.run retries transient failures (3× exp backoff) and fast-fails
      // when the circuit is OPEN — a dead provider degrades, never blocks.
      const extraction = await this.breaker.run('ocr:extract', () =>
        this.provider.extract(s3Key),
      );
      await this.usage.log({
        provider: 'OCR',
        operation: 'ocr.extract',
        costMicros: 500_000, // ~₹0.50 / page (illustrative)
        simulated,
        latencyMs: Date.now() - started,
        tenantId,
        documentType: 'Invoice',
        documentId: invoiceId,
      });
      await this.invoices.applyOcr(tenantId, invoiceId, extraction);
    } catch (err) {
      const circuitOpen = err instanceof CircuitOpenError;
      await this.usage.log({
        provider: 'OCR',
        operation: 'ocr.extract',
        costMicros: 0,
        outcome: circuitOpen ? 'CIRCUIT_OPEN' : 'ERROR',
        simulated,
        tenantId,
        documentType: 'Invoice',
        documentId: invoiceId,
      });
      this.logger.warn(
        { invoiceId, err: String(err) },
        'OCR extraction failed — routing to manual data-entry fallback',
      );
      await this.invoices.markOcrFailed(tenantId, invoiceId, String(err));
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    this.connection?.disconnect();
  }
}
