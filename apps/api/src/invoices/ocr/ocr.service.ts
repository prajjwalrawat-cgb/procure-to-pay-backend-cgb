import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, type ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';

import { guardBullMq } from '../../common/queue/queue-guard';
import type { Env } from '../../config/env';

export const OCR_QUEUE = 'ocr';

export interface OcrJobData {
  invoiceId: string;
  tenantId: string;
  s3Key: string;
}

/** Enqueues OCR jobs (Master Context §2 — BullMQ on Redis). */
@Injectable()
export class OcrService implements OnModuleDestroy {
  private readonly logger = new Logger(OcrService.name);
  private readonly connection: IORedis;
  private readonly queue: Queue;
  /**
   * The sandbox simulator answers instantly, so the OCR_PENDING stage used to
   * flash past before anyone could see it — the delay gave the demo a plausible
   * beat. A real provider spends seconds of its own, so there the pause is pure
   * added latency and is dropped.
   */
  private readonly startupDelayMs: number;

  constructor(private readonly config: ConfigService<Env, true>) {
    this.startupDelayMs = this.config.get('OCR_API_URL', { infer: true }) ? 0 : 2500;
    this.connection = new IORedis(this.config.get('REDIS_URL', { infer: true }), {
      maxRetriesPerRequest: null,
    });
    this.queue = new Queue(OCR_QUEUE, {
      connection: this.connection as unknown as ConnectionOptions,
    });
    guardBullMq(OCR_QUEUE, { connection: this.connection, queue: this.queue }, (m) =>
      this.logger.error(m),
    );
  }

  /** Submit a document for OCR (see `startupDelayMs` for the sandbox pause). */
  async submit(data: OcrJobData): Promise<string> {
    const job = await this.queue.add('extract', data, {
      delay: this.startupDelayMs,
      removeOnComplete: true,
      removeOnFail: 100,
    });
    return job.id ?? '';
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    this.connection.disconnect();
  }
}
