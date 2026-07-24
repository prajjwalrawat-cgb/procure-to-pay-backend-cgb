import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import type { Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';

export type SubsystemStatus = 'ok' | 'down';

export interface HealthReport {
  status: 'ok' | 'degraded';
  db: SubsystemStatus;
  redis: SubsystemStatus;
  s3: SubsystemStatus;
}

/** Health probes for the load balancer (Master Context §10 observability). */
@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly redis: Redis;
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {
    this.redis = new Redis(this.config.get('REDIS_URL', { infer: true }), {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    this.bucket = this.config.get('S3_BUCKET', { infer: true });
    this.s3 = new S3Client({
      endpoint: this.config.get('S3_ENDPOINT', { infer: true }),
      region: this.config.get('S3_REGION', { infer: true }),
      forcePathStyle: this.config.get('S3_FORCE_PATH_STYLE', { infer: true }),
      credentials: {
        accessKeyId: this.config.get('S3_ACCESS_KEY', { infer: true }),
        secretAccessKey: this.config.get('S3_SECRET_KEY', { infer: true }),
      },
    });
  }

  async check(): Promise<HealthReport> {
    const [db, redis, s3] = await Promise.all([
      this.checkDb(),
      this.checkRedis(),
      this.checkS3(),
    ]);
    const status = db === 'ok' && redis === 'ok' && s3 === 'ok' ? 'ok' : 'degraded';
    return { status, db, redis, s3 };
  }

  private async checkDb(): Promise<SubsystemStatus> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'ok';
    } catch {
      return 'down';
    }
  }

  private async checkRedis(): Promise<SubsystemStatus> {
    try {
      if (this.redis.status !== 'ready') await this.redis.connect();
      const pong = await this.redis.ping();
      return pong === 'PONG' ? 'ok' : 'down';
    } catch {
      return 'down';
    }
  }

  private async checkS3(): Promise<SubsystemStatus> {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return 'ok';
    } catch {
      return 'down';
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect();
    this.s3.destroy();
  }
}
