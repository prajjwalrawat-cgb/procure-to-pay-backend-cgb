import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { compare } from '@procureflow/shared';

import { CircuitBreaker } from '../../common/integrations/circuit-breaker';
import type { Env } from '../../config/env';
import { IntegrationUsageService } from '../../integrations/integration-usage.service';

/** DI token for the active penny-drop provider (real vs sandbox). */
export const PENNY_DROP_PROVIDER = Symbol('PENNY_DROP_PROVIDER');

export interface PennyDropResult {
  registeredName: string;
  matchScore: number;
}

export interface IPennyDropProvider {
  verify(declaredHolderName: string, accountNumber: string): Promise<PennyDropResult>;
}

/**
 * SandboxPennyDropProvider (Slice 10b). The clearly-labelled deterministic
 * simulator for penny-drop bank verification (a Karza/Signzy-class service in
 * prod), used until a real verification contract exists. Behaviour matches Slice
 * 7's original mock — accounts starting `9999` return a mismatched holder name —
 * so the NameMatchService scoring + onboarding acceptance are unchanged. Wrapped
 * in the shared circuit breaker + usage log.
 */
@Injectable()
export class SandboxPennyDropProvider implements IPennyDropProvider {
  constructor(
    private readonly breaker: CircuitBreaker,
    private readonly usage: IntegrationUsageService,
  ) {}

  async verify(
    declaredHolderName: string,
    accountNumber: string,
  ): Promise<PennyDropResult> {
    const result = await this.breaker.run('penny-drop:verify', () => {
      const registeredName = accountNumber.startsWith('9999')
        ? 'MISMATCHED ACCOUNT HOLDER'
        : declaredHolderName;
      const { score } = compare(declaredHolderName, registeredName);
      return Promise.resolve({ registeredName, matchScore: score });
    });
    await this.usage.log({
      provider: 'PENNY_DROP',
      operation: 'penny_drop.verify',
      costMicros: 3_000_000, // ~₹3 / verification (illustrative)
      simulated: true,
    });
    return result;
  }
}

/**
 * RealPennyDropProvider (Slice 10b). Calls a real bank-verification aggregator
 * (`PENNY_DROP_API_URL`). No contract exists here, so this throws → circuit
 * breaker → the caller's manual-review fallback; the sandbox runs by default.
 */
@Injectable()
export class RealPennyDropProvider implements IPennyDropProvider {
  private readonly logger = new Logger(RealPennyDropProvider.name);
  constructor(private readonly config: ConfigService<Env, true>) {}

  async verify(): Promise<PennyDropResult> {
    this.logger.warn('Real penny-drop provider invoked without a contract');
    throw new Error('Penny-drop live client not implemented (no provider contract)');
  }
}
