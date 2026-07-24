import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../config/env';
import { IntegrationUsageService } from '../../integrations/integration-usage.service';

/** DI token for the active CAPTCHA provider (real reCAPTCHA vs sandbox). */
export const CAPTCHA_PROVIDER = Symbol('CAPTCHA_PROVIDER');

export interface CaptchaResult {
  ok: boolean;
  score?: number;
  reason?: string;
}

export interface ICaptchaProvider {
  verify(token: string): Promise<CaptchaResult>;
}

/**
 * Minimal shape of the `fetch` Response we consume. Annotated explicitly so the
 * build never depends on the ambient global `Response` type, which — under
 * `lib: ["ES2022"]` (no DOM) — can resolve to `{}` in environments where DOM-ish
 * globals leak onto `globalThis`, dropping `json` (breaks the Vercel build while
 * compiling fine locally).
 */
interface FetchResponse {
  json(): Promise<unknown>;
}

/**
 * SandboxCaptchaProvider (Slice 10c). Deterministic stand-in for reCAPTCHA v3 on
 * public self-registration until a real key is configured. A token containing
 * 'bot' / 'invalid' / 'fail' (or empty) is rejected — enough to prove scripted
 * submissions without a valid token are blocked in tests.
 */
@Injectable()
export class SandboxCaptchaProvider implements ICaptchaProvider {
  constructor(private readonly usage: IntegrationUsageService) {}

  async verify(token: string): Promise<CaptchaResult> {
    await this.usage.log({
      provider: 'CAPTCHA',
      operation: 'captcha.verify',
      costMicros: 0,
      simulated: true,
    });
    const bad = !token || /bot|invalid|fail/i.test(token);
    return bad
      ? { ok: false, score: 0, reason: 'Suspected automated submission (sandbox).' }
      : { ok: true, score: 0.9 };
  }
}

/**
 * RealCaptchaProvider (Slice 10c). Verifies a reCAPTCHA v3 token against Google's
 * siteverify with `RECAPTCHA_SECRET`, requiring `success && score >=
 * RECAPTCHA_MIN_SCORE`. Selected only when `RECAPTCHA_SECRET` is set.
 */
@Injectable()
export class RealCaptchaProvider implements ICaptchaProvider {
  private readonly logger = new Logger(RealCaptchaProvider.name);
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly usage: IntegrationUsageService,
  ) {}

  async verify(token: string): Promise<CaptchaResult> {
    const secret = this.config.get('RECAPTCHA_SECRET', { infer: true });
    const minScore = this.config.get('RECAPTCHA_MIN_SCORE', { infer: true });
    try {
      const res = (await fetch('https://www.google.com/recaptcha/api/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret, response: token }),
      })) as FetchResponse;
      const body = (await res.json()) as { success: boolean; score?: number };
      const score = body.score ?? 0;
      const ok = body.success && score >= minScore;
      await this.usage.log({
        provider: 'CAPTCHA',
        operation: 'captcha.verify',
        costMicros: 0,
        simulated: false,
      });
      return ok
        ? { ok: true, score }
        : { ok: false, score, reason: 'reCAPTCHA score below threshold.' };
    } catch (err) {
      this.logger.warn(`reCAPTCHA verification failed: ${String(err)}`);
      // Fail-closed for a public anti-bot control.
      return { ok: false, reason: 'CAPTCHA verification unavailable.' };
    }
  }
}
