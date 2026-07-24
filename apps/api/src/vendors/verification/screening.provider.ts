import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IntegrationProvider, ScreeningType } from '@procureflow/shared';

import {
  CircuitBreaker,
  CircuitOpenError,
} from '../../common/integrations/circuit-breaker';
import type { Env } from '../../config/env';
import { IntegrationUsageService } from '../../integrations/integration-usage.service';

/** DI token for the active screening provider (real vs sandbox). */
export const SCREENING_PROVIDER = Symbol('SCREENING_PROVIDER');

export interface ScreeningInput {
  gstin: string | null;
  pan: string | null;
  udyamNumber: string | null;
  legalEntityName: string | null;
  beneficialOwnerNames: string[];
}

export interface ProviderResult {
  status: 'CLEAR' | 'FLAGGED' | 'ERROR';
  severity?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  findings: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export interface IScreeningProvider {
  /** Never throws — a provider failure yields an ERROR result (manual follow-up). */
  screen(type: ScreeningType, input: ScreeningInput): Promise<ProviderResult>;
}

/** Maps a screening type to the IntegrationProvider used for usage/cost logging. */
export function integrationProviderFor(type: ScreeningType): IntegrationProvider {
  if (type === 'GSTIN_STATUS') return 'GSTN';
  if (type === 'PAN_STATUS') return 'PAN';
  if (type === 'UDYAM_STATUS') return 'UDYAM';
  if (type === 'MCA_DIRECTORS') return 'MCA';
  if (type === 'CREDIT_BUREAU') return 'CREDIT_BUREAU';
  if (type === 'ADVERSE_MEDIA') return 'ADVERSE_MEDIA';
  return 'SANCTIONS'; // SANCTIONS_OFAC/EU/UK, RBI_DEFAULTER
}

/** Human/audit label for the provider behind each screening type. */
export function screeningProviderName(type: ScreeningType): string {
  if (type === 'GSTIN_STATUS') return 'MOCK_GSTN_IRP';
  if (type === 'PAN_STATUS') return 'MOCK_NSDL';
  if (type === 'UDYAM_STATUS') return 'MOCK_UDYAM';
  if (type === 'MCA_DIRECTORS') return 'MOCK_MCA';
  if (type === 'CREDIT_BUREAU') return 'MOCK_DUN_BRADSTREET';
  if (type.startsWith('SANCTIONS') || type === 'RBI_DEFAULTER') return 'MOCK_REFINITIV';
  if (type === 'ADVERSE_MEDIA') return 'MOCK_ADVERSE_MEDIA';
  return 'MOCK';
}

/** Illustrative per-call cost (micros of INR) by provider. */
const SCREEN_COST: Partial<Record<IntegrationProvider, number>> = {
  GSTN: 500_000,
  PAN: 500_000,
  UDYAM: 500_000,
  MCA: 2_000_000,
  SANCTIONS: 8_000_000, // compliance screening is the pricey one
  ADVERSE_MEDIA: 6_000_000,
  CREDIT_BUREAU: 15_000_000,
};

const MOCK_SANCTIONS_LIST = [
  'GLOBAL SHELL HOLDINGS',
  'RED FLAG TRADING',
  'IVAN PETROV',
  'JOHN DOE SANCTIONED',
];

/**
 * SandboxScreeningProvider (Slice 10c). The clearly-labelled deterministic
 * simulator for all statutory/compliance screenings (GSTN, PAN, Udyam, MCA,
 * sanctions, adverse media, credit bureau) — a Karza/Signzy/Refinitiv-class set
 * of services in prod. It normalises into the exact Slice 7 `findings` shape so
 * VendorVerificationService + onboarding need no changes. Each call is wrapped in
 * the shared circuit breaker (keyed per type) + usage log; a provider outage
 * (name contains PROVIDERDOWN, or a tripped breaker) yields an ERROR result so
 * onboarding can proceed with the check flagged for manual follow-up (ADR-032/035).
 */
@Injectable()
export class SandboxScreeningProvider implements IScreeningProvider {
  constructor(
    private readonly breaker: CircuitBreaker,
    private readonly usage: IntegrationUsageService,
  ) {}

  async screen(type: ScreeningType, input: ScreeningInput): Promise<ProviderResult> {
    const provider = integrationProviderFor(type);
    const started = Date.now();
    try {
      const result = await this.breaker.run(`screening:${type}`, () =>
        Promise.resolve(this.run(type, input)),
      );
      await this.usage.log({
        provider,
        operation: `screening.${type.toLowerCase()}`,
        costMicros: SCREEN_COST[provider] ?? 1_000_000,
        simulated: true,
        latencyMs: Date.now() - started,
      });
      return result;
    } catch (err) {
      await this.usage.log({
        provider,
        operation: `screening.${type.toLowerCase()}`,
        costMicros: 0,
        outcome: err instanceof CircuitOpenError ? 'CIRCUIT_OPEN' : 'ERROR',
        simulated: true,
      });
      return {
        status: 'ERROR',
        findings: { error: 'Provider unavailable — manual follow-up required.' },
        raw: { error: String(err) },
      };
    }
  }

  private run(type: ScreeningType, input: ScreeningInput): ProviderResult {
    // Deterministic outage hook for degradation testing.
    if ((input.legalEntityName ?? '').toUpperCase().includes('PROVIDERDOWN')) {
      throw new Error('simulated provider outage');
    }
    switch (type) {
      case 'GSTIN_STATUS':
        return this.gstn(input);
      case 'PAN_STATUS':
        return this.pan(input);
      case 'UDYAM_STATUS':
        return this.udyam(input);
      case 'SANCTIONS_OFAC':
      case 'SANCTIONS_EU':
      case 'SANCTIONS_UK':
      case 'RBI_DEFAULTER':
        return this.sanctions(input, type);
      case 'ADVERSE_MEDIA':
        return this.adverseMedia(input);
      case 'CREDIT_BUREAU':
        return this.creditBureau(input);
      case 'MCA_DIRECTORS':
        return this.mca(input);
      default:
        return { status: 'CLEAR', findings: {}, raw: {} };
    }
  }

  private gstn(input: ScreeningInput): ProviderResult {
    const g = input.gstin ?? '';
    const cancelled = g.startsWith('99') || g.endsWith('ZZ');
    return cancelled
      ? {
          status: 'FLAGGED',
          severity: 'HIGH',
          findings: {
            registrationStatus: 'CANCELLED',
            reason: 'GSTIN registration cancelled',
          },
          raw: { gstin: g, status: 'Cancelled', legalName: input.legalEntityName },
        }
      : {
          status: 'CLEAR',
          findings: { registrationStatus: 'ACTIVE', legalName: input.legalEntityName },
          raw: {
            gstin: g,
            status: 'Active',
            legalName: input.legalEntityName,
            taxpayerType: 'Regular',
          },
        };
  }

  private pan(input: ScreeningInput): ProviderResult {
    const p = input.pan ?? '';
    const valid = /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(p);
    return valid
      ? {
          status: 'CLEAR',
          findings: { panStatus: 'VALID', aadhaarLinked: true },
          raw: { pan: p, status: 'Valid', aadhaarSeedingStatus: 'Y' },
        }
      : {
          status: 'FLAGGED',
          severity: 'MEDIUM',
          findings: { panStatus: 'INVALID' },
          raw: { pan: p, status: 'Invalid' },
        };
  }

  private udyam(input: ScreeningInput): ProviderResult {
    const u = input.udyamNumber ?? '';
    const valid = /^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/.test(u);
    return valid
      ? {
          status: 'CLEAR',
          findings: { classification: 'MICRO', enterpriseName: input.legalEntityName },
          raw: { udyam: u, classification: 'Micro' },
        }
      : {
          status: 'FLAGGED',
          severity: 'LOW',
          findings: { udyamStatus: 'NOT_FOUND' },
          raw: { udyam: u },
        };
  }

  private sanctions(input: ScreeningInput, type: ScreeningType): ProviderResult {
    const names = [input.legalEntityName ?? '', ...input.beneficialOwnerNames].map((n) =>
      n.toUpperCase().trim(),
    );
    const hit = names.find((n) => MOCK_SANCTIONS_LIST.includes(n));
    return hit
      ? {
          status: 'FLAGGED',
          severity: 'CRITICAL',
          findings: { list: type, matchedName: hit, matchType: 'POTENTIAL_MATCH' },
          raw: { list: type, matches: [{ name: hit, score: 0.95 }] },
        }
      : {
          status: 'CLEAR',
          findings: { list: type, matchType: 'NOT_LISTED' },
          raw: { list: type, matches: [] },
        };
  }

  private adverseMedia(input: ScreeningInput): ProviderResult {
    const flagged = (input.legalEntityName ?? '').toUpperCase().includes('SCAM');
    return flagged
      ? {
          status: 'FLAGGED',
          severity: 'HIGH',
          findings: { articles: 1, sentiment: 'NEGATIVE' },
          raw: { hits: 1 },
        }
      : { status: 'CLEAR', findings: { articles: 0 }, raw: { hits: 0 } };
  }

  private creditBureau(input: ScreeningInput): ProviderResult {
    const seed = (input.pan ?? 'AAAAA0000A').charCodeAt(4) % 40;
    const rating = 60 + seed;
    return {
      status: 'CLEAR',
      findings: { creditScore: rating, band: rating >= 80 ? 'A' : 'B' },
      raw: { score: rating },
    };
  }

  private mca(input: ScreeningInput): ProviderResult {
    const struck = (input.legalEntityName ?? '').toUpperCase().includes('STRUCK');
    return struck
      ? {
          status: 'FLAGGED',
          severity: 'CRITICAL',
          findings: { companyStatus: 'STRUCK_OFF' },
          raw: { status: 'Struck Off' },
        }
      : {
          status: 'CLEAR',
          findings: { companyStatus: 'ACTIVE', directors: 2 },
          raw: { status: 'Active' },
        };
  }
}

/**
 * RealScreeningProvider (Slice 10c). Calls real verification/screening aggregators
 * (`SCREENING_API_URL`) per check type. No contract exists here, so each call
 * throws → circuit breaker → ERROR result (manual follow-up); the sandbox runs by
 * default. Interfaces are kept separate per provider category for future
 * flexibility even though one aggregator may back several (ADR-035).
 */
@Injectable()
export class RealScreeningProvider implements IScreeningProvider {
  private readonly logger = new Logger(RealScreeningProvider.name);
  constructor(private readonly config: ConfigService<Env, true>) {}

  async screen(type: ScreeningType): Promise<ProviderResult> {
    this.logger.warn(`Real screening provider invoked for ${type} without a contract`);
    return {
      status: 'ERROR',
      findings: { error: 'Live screening provider not configured.' },
      raw: {},
    };
  }
}
