import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, type ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';

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
  private readonly connection: IORedis;
  private readonly queue: Queue;

  constructor(private readonly config: ConfigService<Env, true>) {
    this.connection = new IORedis(this.config.get('REDIS_URL', { infer: true }), {
      maxRetriesPerRequest: null,
    });
    this.queue = new Queue(OCR_QUEUE, {
      connection: this.connection as unknown as ConnectionOptions,
    });
  }

  /** Submit a document for OCR; ~2.5s mock latency so the UI shows OCR_PENDING. */
  async submit(data: OcrJobData): Promise<string> {
    const job = await this.queue.add('extract', data, {
      delay: 2500,
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
