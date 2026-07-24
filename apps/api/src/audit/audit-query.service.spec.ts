import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import { AuditQueryService } from './audit-query.service';

interface Row {
  id: string;
  timestamp: Date;
  hash_current: string;
  hash_previous: string | null;
  prev_link: string | null;
  recomputed: string;
}

function makeService(rows: Row[]): AuditQueryService {
  const prisma = {
    client: { $queryRaw: vi.fn().mockResolvedValue(rows) },
  } as unknown as PrismaService;
  return new AuditQueryService(prisma);
}

const t = (n: number): Date => new Date(2026, 0, 1, 0, 0, n);

describe('AuditQueryService.verifyChain', () => {
  it('returns verified for an intact chain', async () => {
    const service = makeService([
      {
        id: 'a1',
        timestamp: t(1),
        hash_current: 'h1',
        hash_previous: null,
        prev_link: null,
        recomputed: 'h1',
      },
      {
        id: 'a2',
        timestamp: t(2),
        hash_current: 'h2',
        hash_previous: 'h1',
        prev_link: 'h1',
        recomputed: 'h2',
      },
      {
        id: 'a3',
        timestamp: t(3),
        hash_current: 'h3',
        hash_previous: 'h2',
        prev_link: 'h2',
        recomputed: 'h3',
      },
    ]);
    const result = await service.verifyChain(null, null);
    expect(result.verified).toBe(true);
    expect(result.eventsChecked).toBe(3);
    expect(result.firstBreakAt).toBeNull();
  });

  it('detects a tampered row (integrity failure)', async () => {
    const service = makeService([
      {
        id: 'a1',
        timestamp: t(1),
        hash_current: 'h1',
        hash_previous: null,
        prev_link: null,
        recomputed: 'h1',
      },
      // recomputed no longer matches the stored hash → the row was edited.
      {
        id: 'a2',
        timestamp: t(2),
        hash_current: 'h2',
        hash_previous: 'h1',
        prev_link: 'h1',
        recomputed: 'DIFFERENT',
      },
      {
        id: 'a3',
        timestamp: t(3),
        hash_current: 'h3',
        hash_previous: 'h2',
        prev_link: 'h2',
        recomputed: 'h3',
      },
    ]);
    const result = await service.verifyChain(null, null);
    expect(result.verified).toBe(false);
    expect(result.firstBreakAt).toBe('a2');
  });

  it('scopes the report to the [from, to] window but still walks the whole chain', async () => {
    const service = makeService([
      {
        id: 'a1',
        timestamp: t(1),
        hash_current: 'h1',
        hash_previous: null,
        prev_link: null,
        recomputed: 'h1',
      },
      {
        id: 'a2',
        timestamp: t(2),
        hash_current: 'h2',
        hash_previous: 'h1',
        prev_link: 'h1',
        recomputed: 'h2',
      },
    ]);
    const result = await service.verifyChain(t(2).toISOString(), null);
    expect(result.eventsChecked).toBe(1);
    expect(result.verified).toBe(true);
  });
});
