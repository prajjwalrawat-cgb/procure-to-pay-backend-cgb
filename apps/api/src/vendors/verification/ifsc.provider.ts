import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  CircuitBreaker,
  CircuitOpenError,
} from '../../common/integrations/circuit-breaker';
import type { Env } from '../../config/env';
import { IntegrationUsageService } from '../../integrations/integration-usage.service';

/** DI token for the active IFSC directory provider (real vs sandbox). */
export const IFSC_PROVIDER = Symbol('IFSC_PROVIDER');

export interface IfscDetails {
  ifsc: string;
  bank: string;
  branch: string | null;
  city: string | null;
  state: string | null;
}

export interface IIfscProvider {
  /** Never throws — an unresolvable IFSC (or a provider outage) returns null,
   *  and the vendor is asked to type the bank name instead. */
  lookup(ifsc: string): Promise<IfscDetails | null>;
}

/** `HDFC0001234`: four letters for the bank, a reserved 0, six for the branch. */
export const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export function isIfscFormatValid(ifsc: string): boolean {
  return IFSC_REGEX.test((ifsc ?? '').trim().toUpperCase());
}

/**
 * Bank codes, which are the stable half of an IFSC — assigned by RBI and
 * effectively permanent, unlike branch codes, which change with every merger and
 * relocation. That asymmetry is why the sandbox resolves the bank confidently
 * and says nothing at all about the branch: a made-up branch name printed next
 * to a real bank name would read as verified data.
 */
const BANK_CODES: Record<string, string> = {
  SBIN: 'State Bank of India',
  HDFC: 'HDFC Bank',
  ICIC: 'ICICI Bank',
  UTIB: 'Axis Bank',
  PUNB: 'Punjab National Bank',
  BARB: 'Bank of Baroda',
  CNRB: 'Canara Bank',
  UBIN: 'Union Bank of India',
  IOBA: 'Indian Overseas Bank',
  IDIB: 'Indian Bank',
  CBIN: 'Central Bank of India',
  MAHB: 'Bank of Maharashtra',
  BKID: 'Bank of India',
  UCBA: 'UCO Bank',
  PSIB: 'Punjab & Sind Bank',
  KKBK: 'Kotak Mahindra Bank',
  YESB: 'YES Bank',
  INDB: 'IndusInd Bank',
  IDFB: 'IDFC FIRST Bank',
  FDRL: 'Federal Bank',
  RATN: 'RBL Bank',
  KARB: 'Karnataka Bank',
  CIUB: 'City Union Bank',
  SIBL: 'South Indian Bank',
  TMBL: 'Tamilnad Mercantile Bank',
  DCBL: 'DCB Bank',
  BDBL: 'Bandhan Bank',
  AUBL: 'AU Small Finance Bank',
  ESFB: 'Equitas Small Finance Bank',
  UJVN: 'Ujjivan Small Finance Bank',
  JAKA: 'Jammu & Kashmir Bank',
  KVBL: 'Karur Vysya Bank',
  SCBL: 'Standard Chartered Bank',
  CITI: 'Citibank',
  HSBC: 'HSBC',
  DEUT: 'Deutsche Bank',
  ABNA: 'RBS / ABN AMRO',
  BARC: 'Barclays Bank',
  AIRP: 'Airtel Payments Bank',
  PYTM: 'Paytm Payments Bank',
  IPOS: 'India Post Payments Bank',
};

/** Cost of one directory lookup (micros of INR) — trivial, but logged like the rest. */
const LOOKUP_COST_MICROS = 100_000;

/**
 * SandboxIfscProvider — the default. Resolves the bank from the IFSC's own bank
 * code, which needs no network call and is exactly the fact the vendor was
 * previously being asked to type (and getting wrong: "HDFC" vs "HDFC Bank Ltd"
 * vs "hdfc bank", none of which reconcile against a bank statement).
 *
 * An unrecognised code returns null rather than a guess, and the vendor types
 * the name — the same fallback shape as everywhere else in onboarding.
 */
@Injectable()
export class SandboxIfscProvider implements IIfscProvider {
  constructor(
    private readonly breaker: CircuitBreaker,
    private readonly usage: IntegrationUsageService,
  ) {}

  async lookup(ifsc: string): Promise<IfscDetails | null> {
    const code = (ifsc ?? '').trim().toUpperCase();
    if (!isIfscFormatValid(code)) return null;
    const started = Date.now();
    try {
      const details = await this.breaker.run('ifsc:lookup', () =>
        Promise.resolve(this.resolve(code)),
      );
      await this.usage.log({
        provider: 'BANK',
        operation: 'ifsc.lookup',
        costMicros: LOOKUP_COST_MICROS,
        simulated: true,
        latencyMs: Date.now() - started,
      });
      return details;
    } catch (err) {
      await this.usage.log({
        provider: 'BANK',
        operation: 'ifsc.lookup',
        costMicros: 0,
        outcome: err instanceof CircuitOpenError ? 'CIRCUIT_OPEN' : 'ERROR',
        simulated: true,
      });
      return null;
    }
  }

  private resolve(ifsc: string): IfscDetails | null {
    const bank = BANK_CODES[ifsc.slice(0, 4)];
    if (!bank) return null;
    return { ifsc, bank, branch: null, city: null, state: null };
  }
}

interface IfscApiResponse {
  BANK?: string;
  BRANCH?: string;
  CITY?: string;
  STATE?: string;
  IFSC?: string;
}

interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

const REQUEST_TIMEOUT_MS = 8_000;

/**
 * RealIfscProvider. Calls a configured IFSC directory (`IFSC_API_URL`, e.g.
 * Razorpay's public `https://ifsc.razorpay.com`, or RBI master data behind your
 * own gateway) and normalises it into the same contract. A 404 there means "no
 * such IFSC", which is a genuine answer and returns null; anything else is an
 * outage, which also returns null so the vendor can proceed by typing.
 */
@Injectable()
export class RealIfscProvider implements IIfscProvider {
  private readonly logger = new Logger(RealIfscProvider.name);

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly usage: IntegrationUsageService,
  ) {}

  async lookup(ifsc: string): Promise<IfscDetails | null> {
    const code = (ifsc ?? '').trim().toUpperCase();
    if (!isIfscFormatValid(code)) return null;
    const baseUrl = this.config.get('IFSC_API_URL', { infer: true });
    const started = Date.now();
    try {
      const res = (await fetch(`${baseUrl}/${code}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })) as FetchResponse;
      if (res.status === 404) {
        await this.usage.log({
          provider: 'BANK',
          operation: 'ifsc.lookup',
          costMicros: LOOKUP_COST_MICROS,
          latencyMs: Date.now() - started,
        });
        return null;
      }
      if (!res.ok) throw new Error(`IFSC directory responded ${res.status}`);
      const body = (await res.json()) as IfscApiResponse;
      await this.usage.log({
        provider: 'BANK',
        operation: 'ifsc.lookup',
        costMicros: LOOKUP_COST_MICROS,
        latencyMs: Date.now() - started,
      });
      if (!body.BANK) return null;
      return {
        ifsc: body.IFSC ?? code,
        bank: body.BANK,
        branch: body.BRANCH ?? null,
        city: body.CITY ?? null,
        state: body.STATE ?? null,
      };
    } catch (err) {
      this.logger.warn(`IFSC lookup failed for ${code}: ${String(err)}`);
      await this.usage.log({
        provider: 'BANK',
        operation: 'ifsc.lookup',
        costMicros: 0,
        outcome: 'ERROR',
        latencyMs: Date.now() - started,
      });
      return null;
    }
  }
}
