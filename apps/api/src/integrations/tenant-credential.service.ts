import { Injectable } from '@nestjs/common';
import { newId } from '@procureflow/db';
import type { CredentialStatusItem, IntegrationProvider } from '@procureflow/shared';

import { AuditLogService } from '../audit/audit.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * TenantIntegrationCredentialService (Slice 10a). The encrypted-at-rest vault for
 * per-tenant integration secrets (GSP, OCR, email). The plaintext payload is
 * accepted on write, encrypted immediately, and NEVER returned by any read that
 * a controller can reach — `getStatus` returns configured/label only. Decryption
 * is available solely to server-side provider clients via `getSecret`.
 */
@Injectable()
export class TenantCredentialService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditLogService,
  ) {}

  async setCredential(
    provider: IntegrationProvider,
    label: string | null,
    payload: Record<string, string>,
    actorId: string,
    tenantId?: string,
  ): Promise<{ ok: true }> {
    const tid = tenantId ?? this.tenantId();
    const ciphertext = this.crypto.encryptJson(payload);
    const existing = await this.prisma.client.tenantIntegrationCredential.findUnique({
      where: { tenantId_provider: { tenantId: tid, provider } },
    });
    if (existing) {
      await this.prisma.client.tenantIntegrationCredential.update({
        where: { id: existing.id },
        data: { ciphertext, label, isActive: true, lastRotatedAt: new Date() },
      });
    } else {
      await this.prisma.client.tenantIntegrationCredential.create({
        data: {
          id: newId('tenantIntegrationCredential'),
          tenantId: tid,
          provider,
          label,
          ciphertext,
        },
      });
    }
    // Audit records the ACTION only — never the payload (which is the secret).
    await this.audit.record({
      action: 'INTEGRATION_CREDENTIAL_SET',
      entityType: 'TenantIntegrationCredential',
      entityId: provider,
      actorId,
      tenantId: tid,
      after: { provider, label, keys: Object.keys(payload) },
    });
    return { ok: true };
  }

  /** Server-side only: decrypt a tenant's secret for a provider client. */
  async getSecret(
    provider: IntegrationProvider,
    tenantId?: string,
  ): Promise<Record<string, string> | null> {
    const tid = tenantId ?? this.tenantId();
    const row = await this.prisma.client.tenantIntegrationCredential.findUnique({
      where: { tenantId_provider: { tenantId: tid, provider } },
    });
    if (!row || !row.isActive) return null;
    return this.crypto.decryptJson(row.ciphertext);
  }

  /** UI-safe status — never includes ciphertext or decrypted values. */
  async getStatus(): Promise<CredentialStatusItem[]> {
    const rows = await this.prisma.client.tenantIntegrationCredential.findMany({
      orderBy: { provider: 'asc' },
    });
    return rows.map((r) => ({
      provider: r.provider as IntegrationProvider,
      label: r.label,
      isActive: r.isActive,
      configured: true,
      lastRotatedAt: r.lastRotatedAt?.toISOString() ?? null,
    }));
  }

  private tenantId(): string {
    const tid = this.prisma.currentTenantId;
    if (!tid) throw new Error('No tenant context');
    return tid;
  }
}
