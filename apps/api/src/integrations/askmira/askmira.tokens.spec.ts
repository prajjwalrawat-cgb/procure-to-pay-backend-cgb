import crypto from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { answersChallenge, deriveSecret, peek, sha256hex, verify } from './askmira.tokens';

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** A token as AskMira mints it (HS256, iss askmira, aud askmira:procurement). */
function token(secret: string, claims: Record<string, unknown>, alg = 'HS256'): string {
  const head = b64({ alg, typ: 'JWT' });
  const body = b64(claims);
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

const SECRET = deriveSecret('server-key-0123456789abcdef0123456789', 'tenant-1', 'nonce-1');
const now = Math.floor(Date.now() / 1000);
const good = {
  iss: 'askmira',
  aud: 'askmira:procurement',
  sub: '6f1c0e1e-1111-4111-8111-111111111111',
  use: 'query',
  iat: now,
  exp: now + 60,
  jti: 'j1',
};

describe('AskMira tokens', () => {
  it('accepts a token signed with the connection secret for ProcureFlow', () => {
    expect(verify(token(SECRET, good), SECRET)?.sub).toBe(good.sub);
    expect(peek(token(SECRET, good))?.use).toBe('query');
  });

  it("refuses another connection's secret, another product, another issuer, an old token, none", () => {
    const other = deriveSecret('server-key-0123456789abcdef0123456789', 'tenant-2', 'nonce-1');
    expect(verify(token(other, good), SECRET)).toBeNull();
    expect(verify(token(SECRET, { ...good, aud: 'askmira:saleinx' }), SECRET)).toBeNull();
    expect(verify(token(SECRET, { ...good, iss: 'someone' }), SECRET)).toBeNull();
    expect(verify(token(SECRET, { ...good, exp: now - 60 }), SECRET)).toBeNull();
    expect(verify(token(SECRET, good, 'none'), SECRET)).toBeNull();
    expect(verify('not.a.token', SECRET)).toBeNull();
  });

  it('derives one secret per tenant and nonce, never the same for two', () => {
    expect(deriveSecret('k'.repeat(40), 't1', 'n')).not.toBe(deriveSecret('k'.repeat(40), 't2', 'n'));
    expect(deriveSecret('k'.repeat(40), 't1', 'n')).not.toBe(deriveSecret('k'.repeat(40), 't1', 'm'));
  });

  it('checks the PKCE verifier against the challenge given at Allow', () => {
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    expect(answersChallenge(verifier, challenge)).toBe(true);
    expect(answersChallenge(`${verifier}x`, challenge)).toBe(false);
  });

  it('hashes the exact body', () => {
    expect(sha256hex('{"a":1}')).toBe(crypto.createHash('sha256').update('{"a":1}').digest('hex'));
  });
});
