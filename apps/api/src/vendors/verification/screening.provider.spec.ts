import { describe, expect, it, vi } from 'vitest';

import { CircuitBreaker } from '../../common/integrations/circuit-breaker';
import { IntegrationUsageService } from '../../integrations/integration-usage.service';
import { SandboxScreeningProvider, type ScreeningInput } from './screening.provider';

function build() {
  const usage = { log: vi.fn() } as unknown as IntegrationUsageService;
  return new SandboxScreeningProvider(new CircuitBreaker(), usage);
}

const input = (over: Partial<ScreeningInput> = {}): ScreeningInput => ({
  gstin: '17AAACS1234M1Z9',
  pan: 'AAACS1234M',
  udyamNumber: 'UDYAM-MH-01-1234567',
  legalEntityName: 'Acme Pumps Pvt Ltd',
  beneficialOwnerNames: [],
  ...over,
});

describe('SandboxScreeningProvider.screen (Slice 10c, findings shape unchanged)', () => {
  it('GSTIN — CLEAR for an active registration, FLAGGED (HIGH) when cancelled', async () => {
    const ok = await build().screen('GSTIN_STATUS', input());
    expect(ok.status).toBe('CLEAR');
    expect(ok.findings.registrationStatus).toBe('ACTIVE');
    const bad = await build().screen('GSTIN_STATUS', input({ gstin: '99AAACS1234M1Z9' }));
    expect(bad.status).toBe('FLAGGED');
    expect(bad.severity).toBe('HIGH');
  });

  it('PAN — FLAGGED for an invalid PAN', async () => {
    const r = await build().screen('PAN_STATUS', input({ pan: 'BADPAN' }));
    expect(r.status).toBe('FLAGGED');
    expect(r.findings.panStatus).toBe('INVALID');
  });

  it('SANCTIONS — CRITICAL flag on a watchlist name match', async () => {
    const r = await build().screen(
      'SANCTIONS_OFAC',
      input({ beneficialOwnerNames: ['Ivan Petrov'] }),
    );
    expect(r.status).toBe('FLAGGED');
    expect(r.severity).toBe('CRITICAL');
    expect(r.findings.matchType).toBe('POTENTIAL_MATCH');
  });

  it('MCA — CRITICAL flag for a struck-off company', async () => {
    const r = await build().screen(
      'MCA_DIRECTORS',
      input({ legalEntityName: 'STRUCK Holdings' }),
    );
    expect(r.status).toBe('FLAGGED');
    expect(r.findings.companyStatus).toBe('STRUCK_OFF');
  });

  it('CREDIT_BUREAU — always CLEAR with a score band', async () => {
    const r = await build().screen('CREDIT_BUREAU', input());
    expect(r.status).toBe('CLEAR');
    expect(r.findings).toHaveProperty('creditScore');
  });

  it('degrades to ERROR (not throw) on a provider outage — onboarding can proceed', async () => {
    const r = await build().screen(
      'SANCTIONS_OFAC',
      input({ legalEntityName: 'PROVIDERDOWN Corp' }),
    );
    expect(r.status).toBe('ERROR');
    expect(r.findings).toHaveProperty('error');
  });
});
