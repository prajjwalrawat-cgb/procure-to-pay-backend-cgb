import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../config/env';
import { CircuitBreaker } from '../../common/integrations/circuit-breaker';
import { PrismaService } from '../../prisma/prisma.service';
import { IntegrationUsageService } from '../integration-usage.service';
import { TenantCredentialService } from '../tenant-credential.service';

/** A GSTR-2B line as returned by the GSP (subset we reconcile against, §9). */
export interface Gstr2bEntry {
  supplierGstin: string;
  docNo: string;
  docDate: string; // yyyy-mm-dd
  invoiceValue: string; // gross, decimal string
}

export interface IrnCheckResult {
  valid: boolean;
  detail: string;
}

/**
 * GspClient (Slice 10a). The single client for all GST Suvidha Provider–mediated
 * integrations — GSTR-2B, IRN, e-Way (ADR-033). When `GSP_API_URL` + a tenant
 * credential are configured it calls the real GSP; otherwise it runs a clearly
 * labelled, deterministic **sandbox simulator** so the whole pipeline is testable
 * pre-contract. Every call is wrapped in the shared circuit breaker (ADR-032) so
 * a dead GSP degrades gracefully rather than blocking invoice/GRN flow.
 */
@Injectable()
export class GspClient {
  private readonly logger = new Logger(GspClient.name);

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly breaker: CircuitBreaker,
    private readonly usage: IntegrationUsageService,
    private readonly credentials: TenantCredentialService,
    private readonly prisma: PrismaService,
  ) {}

  private get live(): boolean {
    return Boolean(this.config.get('GSP_API_URL', { infer: true }));
  }

  /** Fetch the tenant's GSTR-2B dataset for a period. */
  async fetchGstr2b(
    tenantId: string,
  ): Promise<{ entries: Gstr2bEntry[]; simulated: boolean }> {
    const started = Date.now();
    try {
      const entries = await this.breaker.run(`gsp:gstr2b:${tenantId}`, () =>
        this.live ? this.fetchGstr2bLive(tenantId) : this.fetchGstr2bSimulated(tenantId),
      );
      await this.usage.log({
        provider: 'GSP',
        operation: 'gstr2b.fetch',
        costMicros: 250_000, // ~₹0.25 / fetch (illustrative)
        simulated: !this.live,
        latencyMs: Date.now() - started,
        tenantId,
      });
      return { entries, simulated: !this.live };
    } catch (err) {
      await this.usage.log({
        provider: 'GSP',
        operation: 'gstr2b.fetch',
        costMicros: 0,
        outcome: 'CIRCUIT_OPEN',
        simulated: !this.live,
        tenantId,
      });
      this.logger.warn(`GSTR-2B fetch degraded for tenant ${tenantId}: ${String(err)}`);
      return { entries: [], simulated: !this.live };
    }
  }

  /** Validate an IRN's authenticity. */
  async validateIrn(irn: string, tenantId: string): Promise<IrnCheckResult> {
    const started = Date.now();
    const result = await this.breaker.run(`gsp:irn:${tenantId}`, () =>
      this.live
        ? this.validateIrnLive(irn)
        : Promise.resolve(this.validateIrnSimulated(irn)),
    );
    await this.usage.log({
      provider: 'GSP',
      operation: 'irn.validate',
      costMicros: 150_000,
      outcome: result.valid ? 'OK' : 'OK',
      simulated: !this.live,
      latencyMs: Date.now() - started,
      tenantId,
    });
    return result;
  }

  /** Live e-Way bill validity check. */
  async checkEwayValidity(
    ewbNo: string,
    tenantId: string,
  ): Promise<{ valid: boolean; simulated: boolean }> {
    const valid = await this.breaker.run(`gsp:eway:${tenantId}`, () =>
      this.live
        ? this.checkEwayLive(ewbNo)
        : Promise.resolve(this.checkEwaySimulated(ewbNo)),
    );
    await this.usage.log({
      provider: 'GSP',
      operation: 'eway.validate',
      costMicros: 100_000,
      simulated: !this.live,
      tenantId,
    });
    return { valid, simulated: !this.live };
  }

  // ── Real GSP (wired but requires a signed GSP contract + creds) ─────────────

  private async fetchGstr2bLive(tenantId: string): Promise<Gstr2bEntry[]> {
    const creds = await this.credentials.getSecret('GSP', tenantId);
    if (!creds) throw new Error('GSP credentials not configured');
    // Real GSP integration goes here (POST to GSP_API_URL with creds). No signed
    // contract exists in this environment, so this throws → breaker → fallback.
    throw new Error('GSP live client not implemented (no provider contract)');
  }

  private async validateIrnLive(_irn: string): Promise<IrnCheckResult> {
    throw new Error('GSP live client not implemented (no provider contract)');
  }

  private async checkEwayLive(_ewbNo: string): Promise<boolean> {
    throw new Error('GSP live client not implemented (no provider contract)');
  }

  // ── Sandbox simulator (deterministic; clearly labelled) ─────────────────────

  /**
   * Simulator derives a self-consistent GSTR-2B dataset from the tenant's own
   * invoices, applying deterministic perturbations keyed off the invoice number
   * so a reconciliation run exercises all four §9 outcomes:
   *   hash%10==0 → omitted (NOT_FOUND) · ==1 → amount delta (MISMATCH_AMOUNT)
   *   ==2 → date shift (MISMATCH_DATE) · else → exact (MATCHED)
   */
  private async fetchGstr2bSimulated(tenantId: string): Promise<Gstr2bEntry[]> {
    const invoices = await this.prisma.client.invoice.findMany({
      where: {
        tenantId,
        vendorInvoiceRef: { not: '' },
        status: { notIn: ['REJECTED', 'OCR_PENDING', 'PENDING_VENDOR_MATCH'] },
      },
      include: { vendor: { select: { gstin: true } } },
      take: 500,
    });
    const entries: Gstr2bEntry[] = [];
    for (const inv of invoices) {
      const gstin = inv.vendor?.gstin;
      if (!gstin || !inv.vendorInvoiceRef) continue;
      const bucket = hashInt(inv.vendorInvoiceRef) % 10;
      if (bucket === 0) continue; // NOT_FOUND — vendor didn't file
      let value = Number(inv.grossAmount.toString());
      let date = inv.invoiceDate;
      if (bucket === 1) value = Math.round((value + 12.34) * 100) / 100; // rounding delta
      if (bucket === 2) date = new Date(inv.invoiceDate.getTime() + 3 * 86400000); // date shift
      entries.push({
        supplierGstin: gstin,
        docNo: inv.vendorInvoiceRef,
        docDate: date.toISOString().slice(0, 10),
        invoiceValue: value.toFixed(2),
      });
    }
    return entries;
  }

  /** Simulator: an IRN is authentic iff it's a 64-char alphanumeric NIC hash. */
  private validateIrnSimulated(irn: string): IrnCheckResult {
    const ok = /^[0-9a-f]{64}$/i.test(irn.trim());
    return ok
      ? { valid: true, detail: 'IRN authenticated against NIC IRP (sandbox).' }
      : {
          valid: false,
          detail: 'IRN failed authenticity check — not a valid 64-char NIC hash.',
        };
  }

  /** Simulator: an e-Way bill number is valid unless it starts with an odd digit
   *  after the standard 12-digit format check (deterministic test hook). */
  private checkEwaySimulated(ewbNo: string): boolean {
    const digits = ewbNo.replace(/\D/g, '');
    if (digits.length < 12) return false;
    return Number(digits[0]) % 2 === 0;
  }
}

/** Small deterministic string hash (djb2). */
function hashInt(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = (h * 33) ^ s.charCodeAt(i);
  return Math.abs(h);
}
