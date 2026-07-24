import { Injectable } from '@nestjs/common';
import { newId } from '@procureflow/db';
import type {
  IntegrationProvider,
  IntegrationUsageResponse,
  IntegrationUsageRow,
} from '@procureflow/shared';
import Decimal from 'decimal.js';

import { PrismaService } from '../prisma/prisma.service';

export interface UsageEntry {
  provider: IntegrationProvider;
  operation: string;
  costMicros: number; // INR × 1e6
  outcome?: 'OK' | 'ERROR' | 'CIRCUIT_OPEN' | 'FALLBACK';
  simulated?: boolean;
  latencyMs?: number;
  documentType?: string | null;
  documentId?: string | null;
  tenantId?: string;
}

/**
 * IntegrationUsageService (Slice 10a). Per-call cost/usage ledger for priced
 * integrations. Written from provider clients + jobs; queried per tenant per
 * month for cost visibility (feeds future billing). Never fails the caller —
 * a logging error is swallowed so it can't block core P2P flow.
 */
@Injectable()
export class IntegrationUsageService {
  constructor(private readonly prisma: PrismaService) {}

  async log(entry: UsageEntry): Promise<void> {
    const tenantId = entry.tenantId ?? this.prisma.currentTenantId;
    if (!tenantId) return;
    try {
      await this.prisma.client.integrationUsageLog.create({
        data: {
          id: newId('integrationUsageLog'),
          tenantId,
          provider: entry.provider,
          operation: entry.operation,
          documentType: entry.documentType ?? null,
          documentId: entry.documentId ?? null,
          costMicros: Math.round(entry.costMicros),
          outcome: entry.outcome ?? 'OK',
          simulated: entry.simulated ?? true,
          latencyMs: entry.latencyMs ?? null,
        },
      });
    } catch {
      // Usage logging is best-effort — never let it break the integration.
    }
  }

  async summary(
    month: string,
    provider?: IntegrationProvider | null,
  ): Promise<IntegrationUsageResponse> {
    const [y, m] = month.split('-').map(Number);
    const start = new Date(Date.UTC(y!, m! - 1, 1));
    const end = new Date(Date.UTC(y!, m!, 1));
    const rows = await this.prisma.client.integrationUsageLog.findMany({
      where: {
        createdAt: { gte: start, lt: end },
        ...(provider ? { provider } : {}),
      },
    });

    const byKey = new Map<string, IntegrationUsageRow & { _micros: number }>();
    for (const r of rows) {
      const key = `${r.provider}|${r.operation}`;
      const agg =
        byKey.get(key) ??
        ({
          provider: r.provider as IntegrationProvider,
          operation: r.operation,
          calls: 0,
          errors: 0,
          simulatedCalls: 0,
          costInr: '0',
          _micros: 0,
        } satisfies IntegrationUsageRow & { _micros: number });
      agg.calls += 1;
      if (r.outcome !== 'OK') agg.errors += 1;
      if (r.simulated) agg.simulatedCalls += 1;
      agg._micros += r.costMicros;
      byKey.set(key, agg);
    }

    let total = new Decimal(0);
    const out: IntegrationUsageRow[] = [];
    for (const agg of byKey.values()) {
      const inr = new Decimal(agg._micros).dividedBy(1_000_000);
      total = total.plus(inr);
      out.push({
        provider: agg.provider,
        operation: agg.operation,
        calls: agg.calls,
        errors: agg.errors,
        simulatedCalls: agg.simulatedCalls,
        costInr: inr.toFixed(4),
      });
    }
    out.sort((a, b) => b.calls - a.calls);
    return { month, rows: out, totalInr: total.toFixed(4) };
  }
}
