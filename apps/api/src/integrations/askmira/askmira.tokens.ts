import crypto from 'node:crypto';

/**
 * AskMira's signed assertions, checked here (pure: no database, unit-tested).
 *
 * Every call AskMira's server makes carries a short-lived HS256 token signed
 * with ONE connection's secret: iss "askmira", aud "askmira:procurement",
 * `use` naming the endpoint's kind, `sub` the AskMira workspace (`tid` on a
 * sign-in link), and on server-to-server calls `bh`, the SHA-256 of the exact
 * body — so a captured token can't be replayed with another body.
 */

export const PRODUCT = 'procurement';
export const BRAND = 'ProcureFlow';
export const AUDIENCE = 'askmira:procurement';
export const ISSUER = 'askmira';

/** Seconds a token's clock may differ from ours. */
const LEEWAY_S = 10;

export type Use = 'provision' | 'query' | 'act' | 'revoke' | 'launch';
export type Claims = Record<string, unknown> & { sub?: string; jti?: string; exp?: number };

export const sha256hex = (value: string | Buffer): string =>
  crypto.createHash('sha256').update(value).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** A connection's secret: derived from the server key, so the database keeps only the nonce. */
export function deriveSecret(serverKey: string, tenantId: string, nonce: string): string {
  return crypto
    .createHmac('sha256', serverKey)
    .update(`askmira-procurement:v1:${tenantId}:${nonce}`)
    .digest('hex');
}

function part(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** What a token says, before anyone has checked it. Only used to pick the secret. */
export function peek(token: string): Claims | null {
  const parts = token.split('.');
  return parts.length === 3 ? (part(parts[1] ?? '') as Claims | null) : null;
}

/** The claims of an HS256 token signed with `secret` for AskMira → ProcureFlow, or null. */
export function verify(token: string, secret: string, now = Date.now()): Claims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts as [string, string, string];
  const header = part(head);
  if (!header || header.alg !== 'HS256') return null;
  const expected = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  const claims = part(body) as Claims | null;
  if (!claims) return null;
  const seconds = Math.floor(now / 1000);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    claims.iss !== ISSUER ||
    !audience.includes(AUDIENCE) ||
    typeof claims.exp !== 'number' ||
    claims.exp + LEEWAY_S < seconds ||
    (typeof claims.iat === 'number' && claims.iat - LEEWAY_S > seconds)
  ) {
    return null;
  }
  return claims;
}

/** PKCE: whether `verifier` answers the `challenge` given at Allow (S256). */
export function answersChallenge(verifier: string, challenge: string): boolean {
  const computed = crypto.createHash('sha256').update(verifier).digest('base64url');
  return safeEqual(computed, challenge);
}

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const PKCE_RE = /^[A-Za-z0-9_-]{43,128}$/;

export function normEmail(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

export function clean(value: unknown, max = 200): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().slice(0, max);
  return text || null;
}
