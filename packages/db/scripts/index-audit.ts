/**
 * Slice 11a — index audit. Runs EXPLAIN (ANALYZE, BUFFERS) on the hottest list /
 * aggregation queries as the runtime app role (procureflow_app) with the RLS GUC
 * set, against load-scale data, so plans reflect production reality. Flags Seq
 * Scans on large tables and expensive Sort nodes. Findings feed
 * docs/database/index-rationale.md.
 *
 * Run: node scripts/with-env.mjs pnpm --filter @procureflow/db index:audit
 */
import { PrismaClient } from '@prisma/client';

// App-role connection (DATABASE_URL) → RLS is active, exactly like the runtime.
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL ?? '' } },
});

interface Probe {
  name: string;
  sql: string;
  note: string;
}

const OPEN =
  "'RECEIVED','OCR_PENDING','OCR_DONE','OCR_LOW_CONFIDENCE','OCR_FAILED','PENDING_VENDOR_MATCH','MATCH_EXCEPTION','AWAITING_APPROVAL','HELD'";

const PROBES: Probe[] = [
  {
    name: 'invoice_list_open (Slice 1 inbox)',
    sql: `SELECT * FROM "Invoice" WHERE status IN (${OPEN}) ORDER BY "receivedAt" ASC, id ASC LIMIT 51`,
    note: 'buyer inbox default tab + cursor',
  },
  {
    name: 'invoice_count_tab',
    sql: `SELECT count(*) FROM "Invoice" WHERE status = 'PAID'`,
    note: 'tab counts',
  },
  {
    name: 'invoice_by_vendor_filter',
    sql: `SELECT * FROM "Invoice" WHERE vendor_id = (SELECT id FROM "Vendor" WHERE status='ACTIVE' LIMIT 1) ORDER BY "receivedAt" ASC LIMIT 51`,
    note: 'inbox filtered by vendor',
  },
  {
    name: 'payment_suggest (Slice 3)',
    sql: `SELECT * FROM "Invoice" WHERE status IN ('APPROVED','SCHEDULED') ORDER BY "invoiceDate" ASC LIMIT 200`,
    note: 'payment-run composer suggestions',
  },
  {
    name: 'po_list (Slice 4)',
    sql: `SELECT * FROM "PurchaseOrder" WHERE status IN ('ISSUED','PARTIALLY_RECEIVED','RECEIVED') ORDER BY "createdAt" DESC LIMIT 51`,
    note: 'PO list open tab',
  },
  {
    name: 'vendor_list (Slice 7)',
    sql: `SELECT * FROM "Vendor" WHERE status = 'ACTIVE' ORDER BY "name" ASC LIMIT 51`,
    note: 'vendor master list',
  },
];

function classify(plan: string): { scan: string; sort: boolean; ms: number } {
  const scan = /Seq Scan on "?(Invoice|PurchaseOrder|Vendor)/.test(plan)
    ? 'SEQ SCAN ⚠'
    : /Index Only Scan/.test(plan)
      ? 'index-only'
      : /Index Scan|Bitmap/.test(plan)
        ? 'index'
        : 'other';
  const m = plan.match(/Execution Time: ([\d.]+) ms/);
  return { scan, sort: /\bSort\b/.test(plan), ms: m ? Number(m[1]) : NaN };
}

async function main(): Promise<void> {
  const tenant = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id::text FROM "Tenant" WHERE name = 'Star Cement Ltd' LIMIT 1`,
  );
  const tid = tenant[0]?.id;
  if (!tid) throw new Error('Star Cement tenant not found');
  console.log(`Index audit @ tenant ${tid} (app role, RLS active)\n`);
  console.log('probe'.padEnd(38), 'scan'.padEnd(12), 'sort', 'exec(ms)');
  console.log('-'.repeat(72));

  for (const p of PROBES) {
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${tid}', true)`);
      const rows = await tx.$queryRawUnsafe<Record<string, string>[]>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${p.sql}`,
      );
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    });
    const c = classify(plan);
    console.log(
      p.name.padEnd(38),
      c.scan.padEnd(12),
      (c.sort ? 'yes' : 'no ').padEnd(4),
      Number.isFinite(c.ms) ? c.ms.toFixed(2) : '?',
    );
    if (process.env.VERBOSE) console.log(plan, '\n');
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
