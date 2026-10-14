import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import { MatchService } from './match.service';

/**
 * Rejection is final. Every route into the matcher — the OCR job, "run match",
 * resolving an exception — must leave a REJECTED invoice where it is, or a
 * refused bill reappears in the exception queue.
 */
describe('MatchService.runFor — rejected invoice', () => {
  it('does not re-match or change the status', async () => {
    const update = vi.fn();
    const record = vi.fn();
    const prisma = {
      client: {
        invoice: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'inv_1',
            tenantId: 'ten_1',
            status: 'REJECTED',
            lines: [],
            po: null,
            exceptions: [],
            vendor: { lifecycleStatus: 'ACTIVE', name: 'Patel' },
          }),
          update,
          count: vi.fn(),
        },
        tenantMatchConfig: { findUnique: vi.fn() },
      },
    } as unknown as PrismaService;
    const service = new MatchService(prisma, { record } as never, { emit: vi.fn() } as never);

    await service.runFor('inv_1');

    expect(prisma.client.tenantMatchConfig.findUnique).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});
