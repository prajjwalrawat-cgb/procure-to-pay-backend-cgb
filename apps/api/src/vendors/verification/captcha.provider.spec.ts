import { describe, expect, it, vi } from 'vitest';

import { IntegrationUsageService } from '../../integrations/integration-usage.service';
import { SandboxCaptchaProvider } from './captcha.provider';

function build() {
  const usage = { log: vi.fn() } as unknown as IntegrationUsageService;
  return new SandboxCaptchaProvider(usage);
}

describe('SandboxCaptchaProvider.verify (Slice 10c reCAPTCHA seam)', () => {
  it('accepts a plausible human token', async () => {
    const r = await build().verify('valid-recaptcha-token-abc123');
    expect(r.ok).toBe(true);
  });

  it('rejects an empty token (scripted submission without a token)', async () => {
    const r = await build().verify('');
    expect(r.ok).toBe(false);
  });

  it('rejects a token flagged as a bot', async () => {
    const r = await build().verify('this-is-a-bot');
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
  });
});
