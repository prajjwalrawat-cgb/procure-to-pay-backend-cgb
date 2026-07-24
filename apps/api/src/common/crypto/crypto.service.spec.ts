import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import { CryptoService } from './crypto.service';

function svc(key = 'unit-test-key'): CryptoService {
  const config = { get: () => key } as unknown as ConfigService<never, true>;
  return new CryptoService(config);
}

describe('CryptoService (AES-256-GCM, encryption at rest)', () => {
  it('round-trips a string', () => {
    const c = svc();
    const ct = c.encrypt('super-secret-gsp-token');
    expect(ct).not.toContain('super-secret'); // ciphertext is not plaintext
    expect(c.decrypt(ct)).toBe('super-secret-gsp-token');
  });

  it('round-trips a JSON credential payload', () => {
    const c = svc();
    const payload = { clientId: 'abc', clientSecret: 'shh' };
    const ct = c.encryptJson(payload);
    expect(ct).not.toMatch(/clientSecret|shh/);
    expect(c.decryptJson(ct)).toEqual(payload);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const c = svc();
    expect(c.encrypt('x')).not.toBe(c.encrypt('x'));
  });

  it('rejects a tampered ciphertext (GCM auth tag)', () => {
    const c = svc();
    const ct = Buffer.from(c.encrypt('hello'), 'base64');
    ct[ct.length - 1] ^= 0xff; // flip a byte in the data
    expect(() => c.decrypt(ct.toString('base64'))).toThrow();
  });

  it('cannot decrypt with a different key', () => {
    const ct = svc('key-a').encrypt('secret');
    expect(() => svc('key-b').decrypt(ct)).toThrow();
  });
});
