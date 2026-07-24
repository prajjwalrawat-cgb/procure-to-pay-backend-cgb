import { Prisma } from '@procureflow/db';
import type { RfqPublishInput } from '@procureflow/shared';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import { RfqService } from './rfq.service';
import { SourcingStateError, SourcingValidationError } from './sourcing.errors';

const DAY = 24 * 60 * 60 * 1000;

interface RfqShape {
  status: string;
  rfqType: string;
  lines: unknown[];
  invitations: unknown[];
  evaluationCriteria: Array<{ weight: number }>;
  bidDeadline?: Date | null;
}

function makeService(rfq: Partial<RfqShape>): RfqService {
  const full: RfqShape = {
    status: 'DRAFT',
    rfqType: 'SINGLE_ENVELOPE',
    lines: [{ id: 'l1' }],
    invitations: [{ id: 'i1' }, { id: 'i2' }],
    evaluationCriteria: [{ weight: 60 }, { weight: 20 }, { weight: 10 }, { weight: 10 }],
    bidDeadline: null,
    ...rfq,
  };
  const prisma = {
    currentTenantId: 'ten_1',
    client: {
      rfq: {
        findUnique: vi.fn().mockResolvedValue(full),
        update: vi.fn().mockResolvedValue({}),
      },
      tenant: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          rfqMinNoticeDays: 3,
          rfqMultiPartyOpenThreshold: new Prisma.Decimal('2500000'),
        }),
      },
      rfqInvitation: { findMany: vi.fn().mockResolvedValue([]) },
      quote: { findMany: vi.fn().mockResolvedValue([]) },
      vendorContact: { findFirst: vi.fn().mockResolvedValue(null) },
      user: { findFirst: vi.fn().mockResolvedValue(null) },
    },
  } as unknown as PrismaService;

  const audit = { rfq: vi.fn().mockResolvedValue(undefined) } as never;
  const events = { emit: vi.fn().mockResolvedValue(undefined) } as never;
  const notifications = { notify: vi.fn().mockResolvedValue(undefined) } as never;
  return new RfqService(prisma, audit, events, notifications);
}

const validTiming = (): RfqPublishInput => ({
  bidDeadline: new Date(Date.now() + 10 * DAY).toISOString(),
  qaDeadline: new Date(Date.now() + 3 * DAY).toISOString(),
  techOpenAt: null,
  commercialOpenAt: null,
  awardDeadline: null,
  spotBuyException: false,
});

describe('RfqService.publish guards', () => {
  it('publishes a valid draft → Q_AND_A_OPEN', async () => {
    const svc = makeService({});
    const r = await svc.publish('rfq_1', validTiming(), 'usr_1');
    expect(r.status).toBe('Q_AND_A_OPEN');
  });

  it('goes straight to BIDDING_OPEN when qaDeadline is absent', async () => {
    const svc = makeService({});
    const r = await svc.publish('rfq_1', { ...validTiming(), qaDeadline: null }, 'usr_1');
    expect(r.status).toBe('BIDDING_OPEN');
  });

  it('rejects a non-draft RFQ', async () => {
    const svc = makeService({ status: 'PUBLISHED' });
    await expect(svc.publish('rfq_1', validTiming(), 'usr_1')).rejects.toThrow(
      SourcingStateError,
    );
  });

  it('rejects an RFQ with no lines', async () => {
    const svc = makeService({ lines: [] });
    await expect(svc.publish('rfq_1', validTiming(), 'usr_1')).rejects.toThrow(
      SourcingValidationError,
    );
  });

  it('rejects fewer than 2 invitations without a spot-buy exception', async () => {
    const svc = makeService({ invitations: [{ id: 'i1' }] });
    await expect(svc.publish('rfq_1', validTiming(), 'usr_1')).rejects.toThrow(
      /Single-source/,
    );
  });

  it('allows single-source with a spot-buy exception', async () => {
    const svc = makeService({ invitations: [{ id: 'i1' }] });
    const r = await svc.publish(
      'rfq_1',
      { ...validTiming(), spotBuyException: true },
      'usr_1',
    );
    expect(r.status).toBe('Q_AND_A_OPEN');
  });

  it('rejects criteria that do not sum to 100', async () => {
    const svc = makeService({ evaluationCriteria: [{ weight: 60 }, { weight: 30 }] });
    await expect(svc.publish('rfq_1', validTiming(), 'usr_1')).rejects.toThrow(
      /sum to 100/,
    );
  });

  it('rejects a bid deadline inside the minimum notice window', async () => {
    const svc = makeService({});
    const soon = new Date(Date.now() + 1 * DAY).toISOString();
    await expect(
      svc.publish(
        'rfq_1',
        { ...validTiming(), bidDeadline: soon, qaDeadline: null },
        'usr_1',
      ),
    ).rejects.toThrow(/at least 3 days/);
  });

  it('rejects a QA deadline after the bid deadline', async () => {
    const svc = makeService({});
    const input = {
      ...validTiming(),
      qaDeadline: new Date(Date.now() + 12 * DAY).toISOString(),
    };
    await expect(svc.publish('rfq_1', input, 'usr_1')).rejects.toThrow(/precede the bid/);
  });

  it('requires tech-open + commercial-open for two-envelope RFQs', async () => {
    const svc = makeService({ rfqType: 'TWO_ENVELOPE' });
    await expect(svc.publish('rfq_1', validTiming(), 'usr_1')).rejects.toThrow(
      /two-envelope/i,
    );
  });

  it('accepts two-envelope with both open dates set', async () => {
    const svc = makeService({ rfqType: 'TWO_ENVELOPE' });
    const input = {
      ...validTiming(),
      techOpenAt: new Date(Date.now() + 11 * DAY).toISOString(),
      commercialOpenAt: new Date(Date.now() + 14 * DAY).toISOString(),
    };
    const r = await svc.publish('rfq_1', input, 'usr_1');
    expect(r.status).toBe('Q_AND_A_OPEN');
  });
});
