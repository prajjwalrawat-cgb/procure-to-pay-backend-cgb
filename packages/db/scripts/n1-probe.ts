/**
 * Slice 11a — N+1 audit. Counts the actual DB round-trips a "logical request"
 * makes by replaying the exact query shapes the hot read services use, with
 * Prisma query-event logging. Flags anything > 20 queries/request. Findings feed
 * docs/database/index-rationale.md (N+1 section).
 *
 * Run: node scripts/with-env.mjs pnpm --filter @procureflow/db n1:probe
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL ?? '' },
  },
  log: [{ emit: 'event', level: 'query' }],
});

let count = 0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(prisma as any).$on('query', () => {
  count += 1;
});

async function measure(name: string, fn: () => Promise<unknown>): Promise<void> {
  count = 0;
  await fn();
  const flag = count > 20 ? ' ⚠ >20' : '';
  console.log(`${name.padEnd(42)} ${String(count).padStart(3)} queries${flag}`);
}

async function main(): Promise<void> {
  const tenant = await prisma.tenant.findFirstOrThrow({
    where: { name: 'Star Cement Ltd' },
  });
  const t = tenant.id;
  console.log('N+1 audit — DB round-trips per logical request (load-scale data)\n');

  // Invoice list page of 50 (the exact shape of InvoiceQueryService.find).
  await measure('invoice_list (page=50)', async () => {
    const items = await prisma.invoice.findMany({
      where: { tenantId: t },
      take: 51,
      orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
      include: {
        vendor: { select: { id: true, name: true, isMsme: true } },
        po: { select: { number: true, grns: { select: { number: true }, take: 1 } } },
        exceptions: { where: { resolvedAt: null }, select: { id: true } },
      },
    });
    await prisma.invoice.count({ where: { tenantId: t } });
    const ids = [
      ...new Set(items.map((i) => i.assignedToId).filter((v): v is string => !!v)),
    ];
    await prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
  });

  // Same but a 500-row page — proves the count does NOT scale with row count.
  await measure('invoice_list (page=500) — no growth', async () => {
    const items = await prisma.invoice.findMany({
      where: { tenantId: t },
      take: 500,
      orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
      include: {
        vendor: { select: { id: true, name: true, isMsme: true } },
        po: { select: { number: true, grns: { select: { number: true }, take: 1 } } },
        exceptions: { where: { resolvedAt: null }, select: { id: true } },
      },
    });
    const ids = [
      ...new Set(items.map((i) => i.assignedToId).filter((v): v is string => !!v)),
    ];
    await prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
  });

  // Invoice detail (full include).
  const anyInv = await prisma.invoice.findFirst({
    where: { tenantId: t },
    select: { id: true },
  });
  await measure('invoice_detail (full include)', async () => {
    await prisma.invoice.findUnique({
      where: { id: anyInv!.id },
      include: {
        vendor: true,
        lines: { orderBy: { lineNo: 'asc' } },
        exceptions: true,
        attachments: true,
        comments: true,
        po: { include: { lines: true, grns: { take: 1 } } },
      },
    });
  });

  // Vendor list.
  await measure('vendor_list (page=50)', async () => {
    await prisma.vendor.findMany({
      where: { tenantId: t, status: 'ACTIVE' },
      take: 51,
      orderBy: { name: 'asc' },
    });
    await prisma.vendor.count({ where: { tenantId: t, status: 'ACTIVE' } });
  });

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
