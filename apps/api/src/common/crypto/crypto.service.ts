import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { Global, Injectable, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../config/env';

/**
 * AES-256-GCM encryption for secrets at rest (Slice 10a). Used by the
 * TenantIntegrationCredential vault — ciphertext is never logged or returned in
 * any API response (Master Context §3 rule #7; ADR-033). The key is derived from
 * `INTEGRATION_ENC_KEY` via SHA-256 so any-length env value yields a 32-byte key.
 */
@Injectable()
export class CryptoService {
  private readonly key: Buffer;

  constructor(config: ConfigService<Env, true>) {
    const raw = config.get('INTEGRATION_ENC_KEY', { infer: true });
    // Normalise any env value to a fixed 32-byte key.
    this.key = createHash('sha256').update(raw).digest();
  }

  /** Encrypt a UTF-8 string → base64 of `iv:tag:ciphertext`. */
  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64');
  }

  /** Inverse of {@link encrypt}. Throws on tamper (GCM auth tag mismatch). */
  decrypt(ciphertext: string): string {
    const buf = Buffer.from(ciphertext, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }

  encryptJson(obj: Record<string, unknown>): string {
    return this.encrypt(JSON.stringify(obj));
  }

  decryptJson<T = Record<string, string>>(ciphertext: string): T {
    return JSON.parse(this.decrypt(ciphertext)) as T;
  }
}

@Global()
@Module({ providers: [CryptoService], exports: [CryptoService] })
export class CryptoModule {}
