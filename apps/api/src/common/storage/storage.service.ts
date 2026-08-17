import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Global, Injectable, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../config/env';

/** S3/MinIO storage (Master Context §2). Never local disk in prod. */
@Injectable()
export class StorageService {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(private readonly config: ConfigService<Env, true>) {
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

  async put(key: string, body: Buffer, contentType: string): Promise<string> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    return key;
  }

  /** Object bytes, or null when the key does not exist. Used where the API
   *  itself needs the content (e.g. embedding a logo in a rendered PDF). */
  async getBuffer(key: string): Promise<Buffer | null> {
    try {
      const res = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const bytes = await res.Body?.transformToByteArray();
      return bytes ? Buffer.from(bytes) : null;
    } catch {
      // NoSuchKey, or storage is unreachable — callers treat both as "absent"
      // rather than failing the document they are assembling.
      return null;
    }
  }

  /** Whether an object exists, without downloading it. */
  async exists(key: string): Promise<boolean> {
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  /** Time-limited download URL for an attachment (default 10 minutes). */
  async presignedGetUrl(key: string, expiresIn = 600): Promise<string> {
    // Cast bridges a minor @smithy client-identity mismatch between the s3 client
    // and the presigner packages; both are the same runtime S3Client.
    const client = this.s3 as unknown as Parameters<typeof getSignedUrl>[0];
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    }) as unknown as Parameters<typeof getSignedUrl>[1];
    return getSignedUrl(client, command, { expiresIn });
  }
}

@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
