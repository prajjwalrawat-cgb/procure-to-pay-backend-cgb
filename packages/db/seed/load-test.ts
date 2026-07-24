/**
 * Slice 11a — load-scale seed. Generates realistic multi-tenant volume so the
 * index audit + N+1 audit + load probe run against production-shaped data, not
 * the handful of demo rows. Three tenants (Star Cement + two synthetic) to catch
 * cross-tenant contention. Idempotent: deterministic numbers → createMany
 * skipDuplicates makes re-runs a no-op. Tunable via env.
 *
 *   VENDORS_PER_TENANT (default 800)
 *   INVOICES_PER_TENANT (default 5000)
 *   POS_PER_TENANT (default 2000)
 *
 * Run: node scripts/with-env.mjs pnpm --filter @procureflow/db seed:load
 */
import { PrismaClient } from '@prisma/client';

import { newId } from '../src/ids';

const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL ?? '' },
  },
});

const VENDORS = Number(process.env.VENDORS_PER_TENANT ?? 800);
const INVOICES = Number(process.env.INVOICES_PER_TENANT ?? 5000);
const POS = Number(process.env.POS_PER_TENANT ?? 2000);
const BATCH = 2000;

const INV_STATUSES = [
  'RECEIVED',
  'OCR_DONE',
  'MATCH_EXCEPTION',
  'AWAITING_APPROVAL',
  'APPROVED',
  'SCHEDULED',
  'PAID',
  'PAID',
  'PAID',
  'HELD',
] as const;
const PO_STATUSES = [
  'ISSUED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'INVOICED',
  'CLOSED',
] as const;
const GSTR = ['PENDING', 'MATCHED', 'MATCHED', 'MISMATCH_AMOUNT', 'NOT_FOUND'] as const;

/** deterministic pseudo-random in [0,1) from an integer seed (no Math.random). */
function rnd(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

async function ensureTenant(name: string, gstin: string): Promise<string> {
  const existing = await prisma.tenant.findFirst({ where: { name } });
  if (existing) return existing.id;
  const t = await prisma.tenant.create({ data: { name, gstin } });
  return t.id;
}

async function chunkCreate<T>(
  rows: T[],
  create: (batch: T[]) => Promise<unknown>,
): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) {
    await create(rows.slice(i, i + BATCH));
  }
}

async function seedTenant(tenantId: string, tag: string): Promise<void> {
  const base = new Date('2025-07-20T00:00:00.000Z').getTime();

  // Vendors — deterministic codes so re-runs skip.
  const vendorIds: string[] = [];
  const vendorRows = Array.from({ length: VENDORS }, (_, i) => {
    const id = newId('vendor');
    vendorIds.push(id);
    return {
      id,
      tenantId,
      code: `LT-${tag}-V-${String(i + 1).padStart(5, '0')}`,
      name: `${tag} Supplier ${i + 1}`,
      gstin: `17AAA${tag}${String(i).padStart(4, '0')}1Z9`.slice(0, 15),
      isMsme: i % 4 === 0,
      status: 'ACTIVE' as const,
      onTimePct: 80 + (i % 20),
      qualityPct: 85 + (i % 15),
    };
  });
  // Codes are stable; if vendors already exist we must reuse their ids for FKs.
  const existingVendors = await prisma.vendor.findMany({
    where: { tenantId, code: { startsWith: `LT-${tag}-V-` } },
    select: { id: true },
    orderBy: { code: 'asc' },
  });
  if (existingVendors.length >= VENDORS) {
    vendorIds.length = 0;
    vendorIds.push(...existingVendors.map((v) => v.id));
  } else {
    await chunkCreate(vendorRows, (b) =>
      prisma.vendor.createMany({ data: b, skipDuplicates: true }),
    );
  }

  // Purchase orders.
  const poRows = Array.from({ length: POS }, (_, i) => ({
    id: newId('purchaseOrder'),
    tenantId,
    number: `LT-${tag}-PO-${String(i + 1).padStart(6, '0')}`,
    vendorId: vendorIds[Math.floor(rnd(i + 1) * vendorIds.length)]!,
    status: PO_STATUSES[i % PO_STATUSES.length]!,
    totalAmount: (10000 + Math.floor(rnd(i + 7) * 4_000_000)).toString(),
    taxAmount: (1800 + Math.floor(rnd(i + 11) * 720_000)).toString(),
    createdAt: new Date(base - Math.floor(rnd(i + 3) * 330) * 86_400_000),
  }));
  await chunkCreate(poRows, (b) =>
    prisma.purchaseOrder.createMany({ data: b, skipDuplicates: true }),
  );

  // Invoices — the heaviest list/detail surface.
  const invRows = Array.from({ length: INVOICES }, (_, i) => {
    const created = new Date(base - Math.floor(rnd(i + 5) * 360) * 86_400_000);
    const gross = 5000 + Math.floor(rnd(i + 13) * 2_000_000);
    return {
      id: newId('invoice'),
      tenantId,
      number: `LT-${tag}-INV-${String(i + 1).padStart(6, '0')}`,
      vendorId: vendorIds[Math.floor(rnd(i + 17) * vendorIds.length)]!,
      vendorInvoiceRef: `${tag}/2026/${i + 1}`,
      invoiceDate: created,
      receivedAt: created,
      status: INV_STATUSES[i % INV_STATUSES.length]!,
      source: 'MANUAL' as const,
      grossAmount: gross.toString(),
      taxAmount: Math.floor(gross * 0.18).toString(),
      tdsAmount: Math.floor(gross * 0.001).toString(),
      netAmount: Math.floor(gross * 0.999).toString(),
      gstr2bStatus: GSTR[i % GSTR.length]!,
      createdAt: created,
    };
  });
  await chunkCreate(invRows, (b) =>
    prisma.invoice.createMany({ data: b, skipDuplicates: true }),
  );
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const star = await prisma.tenant.findFirstOrThrow({
    where: { name: 'Star Cement Ltd' },
  });
  const alpha = await ensureTenant('LoadTest Alpha Ltd', '29AAALT0001A1Z5');
  const beta = await ensureTenant('LoadTest Beta Ltd', '27AAALT0002B1Z3');

  console.log(
    `Seeding ${VENDORS} vendors, ${POS} POs, ${INVOICES} invoices per tenant …`,
  );
  await seedTenant(star.id, 'STAR');
  await seedTenant(alpha, 'ALPHA');
  await seedTenant(beta, 'BETA');

  const totals = await Promise.all([
    prisma.invoice.count(),
    prisma.purchaseOrder.count(),
    prisma.vendor.count(),
  ]);
  console.log(
    `Load seed complete in ${((Date.now() - t0) / 1000).toFixed(1)}s — ` +
      `invoices=${totals[0]} pos=${totals[1]} vendors=${totals[2]} across 3 tenants.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
