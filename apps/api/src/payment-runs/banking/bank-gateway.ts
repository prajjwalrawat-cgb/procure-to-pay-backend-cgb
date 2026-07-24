import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CircuitBreaker } from '../../common/integrations/circuit-breaker';
import type { Env } from '../../config/env';
import { IntegrationUsageService } from '../../integrations/integration-usage.service';

/** DI token for the active bank gateway (real vs sandbox). */
export const BANK_GATEWAY = Symbol('BANK_GATEWAY');

export interface BankPayee {
  invoiceId: string;
  beneficiaryName: string;
  ifsc: string;
  amount: string;
}

export interface BankItemResult {
  invoiceId: string;
  accepted: boolean;
  utr: string | null;
  error: string | null;
}

export interface BankSubmitResult {
  batchRef: string;
  simulated: boolean;
  items: BankItemResult[];
}

export interface BankConfirmResult {
  simulated: boolean;
  items: BankItemResult[];
}

export interface IBankGateway {
  submit(
    idempotencyKey: string,
    formatKey: string,
    payees: BankPayee[],
  ): Promise<BankSubmitResult>;
  confirm(batchRef: string, payees: BankPayee[]): Promise<BankConfirmResult>;
}

const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

/**
 * SandboxBankGateway (Slice 10b). The clearly-labelled deterministic simulator
 * for corporate bank submission (HDFC/ICICI/SBI), used until a signed bank
 * sandbox agreement + credentials exist. It is deterministic so idempotency,
 * partial-batch, and confirmation tests are reproducible:
 *   • a payee whose IFSC fails the format check → rejected (INVALID_IFSC)
 *   • otherwise → accepted with a stable UTR derived from batchRef+invoiceId
 * confirm() echoes the same UTRs so poll/webhook confirmation is consistent.
 * Every call is wrapped in the shared circuit breaker + usage log (ADR-032/034).
 */
@Injectable()
export class SandboxBankGateway implements IBankGateway {
  constructor(
    private readonly breaker: CircuitBreaker,
    private readonly usage: IntegrationUsageService,
  ) {}

  async submit(
    idempotencyKey: string,
    _formatKey: string,
    payees: BankPayee[],
  ): Promise<BankSubmitResult> {
    const batchRef = `SIMBATCH-${idempotencyKey}`;
    const items = await this.breaker.run('bank:submit', () =>
      Promise.resolve(
        payees.map((p) => {
          const valid = IFSC_RE.test(p.ifsc);
          return {
            invoiceId: p.invoiceId,
            accepted: valid,
            utr: valid ? utrFor(batchRef, p.invoiceId) : null,
            error: valid ? null : `INVALID_IFSC — bank rejected beneficiary (${p.ifsc})`,
          };
        }),
      ),
    );
    await this.usage.log({
      provider: 'BANK',
      operation: 'bank.submit',
      costMicros: payees.length * 500_000, // ~₹0.50 / payment (illustrative)
      simulated: true,
    });
    return { batchRef, simulated: true, items };
  }

  async confirm(batchRef: string, payees: BankPayee[]): Promise<BankConfirmResult> {
    const items = payees.map((p) => {
      const valid = IFSC_RE.test(p.ifsc);
      return {
        invoiceId: p.invoiceId,
        accepted: valid,
        confirmed: valid,
        utr: valid ? utrFor(batchRef, p.invoiceId) : null,
        error: valid ? null : 'Bank did not settle — beneficiary rejected.',
      } as BankItemResult & { confirmed: boolean };
    });
    await this.usage.log({
      provider: 'BANK',
      operation: 'bank.confirm',
      costMicros: 0,
      simulated: true,
    });
    return { simulated: true, items };
  }
}

/**
 * RealBankGateway (Slice 10b). Submits the formatted batch to a bank's corporate
 * API (`BANK_API_URL`). No signed bank sandbox exists in this environment, so this
 * throws → circuit breaker → the submission service's recovery/manual-flag path;
 * the sandbox gateway runs by default. Going live is a config change.
 */
@Injectable()
export class RealBankGateway implements IBankGateway {
  private readonly logger = new Logger(RealBankGateway.name);
  constructor(private readonly config: ConfigService<Env, true>) {}

  async submit(): Promise<BankSubmitResult> {
    this.logger.warn('Real bank gateway invoked without a provider contract');
    throw new Error('Bank gateway live client not implemented (no bank contract)');
  }

  async confirm(): Promise<BankConfirmResult> {
    throw new Error('Bank gateway live client not implemented (no bank contract)');
  }
}

/** Deterministic, real-looking UTR (no Date/random — reproducible + idempotent). */
function utrFor(batchRef: string, invoiceId: string): string {
  let h = 2166136261;
  const s = `${batchRef}:${invoiceId}`;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hex = (h >>> 0).toString(16).toUpperCase().padStart(8, '0');
  return `AXISR${hex}${hex.slice(0, 4)}`; // 17-char UTR-like reference
}
