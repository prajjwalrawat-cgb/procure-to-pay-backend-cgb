import { describe, expect, it, vi } from 'vitest';

import { CircuitBreaker } from '../../common/integrations/circuit-breaker';
import { IntegrationUsageService } from '../../integrations/integration-usage.service';
import { SandboxPennyDropProvider } from './penny-drop.provider';

function build() {
  const usage = { log: vi.fn() } as unknown as IntegrationUsageService;
  return new SandboxPennyDropProvider(new CircuitBreaker(), usage);
}

describe('SandboxPennyDropProvider (Slice 10b, behind the provider interface)', () => {
  it('returns the declared name + a high score for a matching account', async () => {
    const r = await build().verify('Patel Engineering', '5011234567');
    expect(r.registeredName).toBe('Patel Engineering');
    expect(r.matchScore).toBeGreaterThan(0.85);
  });

  it('returns a mismatched name + a low score for a 9999 test account', async () => {
    const r = await build().verify('Patel Engineering', '9999000111');
    expect(r.registeredName).toBe('MISMATCHED ACCOUNT HOLDER');
    expect(r.matchScore).toBeLessThan(0.85);
  });

  it('feeds the shared NameMatchService scoring (deterministic)', async () => {
    const a = await build().verify('Star Cement Ltd', '5010000000');
    const b = await build().verify('Star Cement Ltd', '5010000000');
    expect(a.matchScore).toBe(b.matchScore);
  });
});
