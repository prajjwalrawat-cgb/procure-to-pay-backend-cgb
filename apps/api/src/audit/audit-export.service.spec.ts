import type { AuditQueryInput } from '@procureflow/shared';
import { describe, expect, it } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import { AuditExportService } from './audit-export.service';
import type { AuditQueryService } from './audit-query.service';

function makeService(verified: boolean): AuditExportService {
  const query = {
    find: async () => ({
      items: [
        {
          timestamp: '2026-07-17T10:00:00.000Z',
          actorName: 'Harpreet Singh',
          actorId: 'usr_1',
          action: 'invoice.approve',
          entityType: 'Invoice',
          entityId: 'inv_01ABCDEF',
          hashCurrent: 'a1b2c3d4e5f6a7b8',
        },
        {
          timestamp: '2026-07-17T10:05:00.000Z',
          actorName: null,
          actorId: null,
          action: 'payment_run.submit',
          entityType: 'PaymentRun',
          entityId: 'pay_01',
          hashCurrent: 'ffeeddccbbaa0011',
        },
      ],
      nextCursor: null,
      totalEstimate: 2,
    }),
    verifyChain: async () => ({
      verified,
      eventsChecked: 2,
      firstBreakAt: verified ? null : 'aud_9',
    }),
  } as unknown as AuditQueryService;
  const prisma = {} as unknown as PrismaService;
  return new AuditExportService(prisma, query);
}

const INPUT = { limit: 200 } as unknown as AuditQueryInput;

describe('AuditExportService.buildReportPdf', () => {
  it('returns a real binary PDF (magic %PDF-) for a verified chain', async () => {
    const pdf = await makeService(true).buildReportPdf('Star Cement Ltd', INPUT);
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // trailer present → well-formed document, not a truncated stream
    expect(pdf.subarray(-6).toString('latin1')).toContain('EOF');
    expect(pdf.length).toBeGreaterThan(800);
  });

  it('renders the broken-chain banner path without throwing', async () => {
    const pdf = await makeService(false).buildReportPdf('Raychem Industries', INPUT);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
