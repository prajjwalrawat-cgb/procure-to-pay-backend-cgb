/**
 * Cross-tenant isolation check for the Home + Analytics overview endpoints.
 *
 * The API specs mock Prisma, so this runs the REAL services against a real
 * Postgres. Everything happens inside ONE transaction that is rolled back at
 * the end — nothing is left in the database:
 *
 *   1. As the owner, seed a throwaway tenant B (user, MSME vendor, PO, invoice
 *      with a marker amount, PO_ISSUED audit row, invoice exception).
 *   2. SET LOCAL ROLE procureflow_app (the RLS-subject runtime role) and point
 *      app.tenant_id at B: refresh B's AnalyticsDaily rollup and read its
 *      summary / overview / activity (sanity: B sees its own marker).
 *   3. Point app.tenant_id at tenant A (an existing tenant) and read A's
 *      summary / overview / activity: none of B's rows, numbers or amounts
 *      may appear, and RLS alone must hide B's rows from raw SELECTs.
 *
 * Run from apps/api (DB urls from the repo .env):
 *   ../../packages/db/node_modules/.bin/tsx scripts/home-isolation-check.ts
 * Exit code 1 on any leak.
 */
import 'reflect-metadata';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { newId, PrismaClient } from '@procureflow/db';

import { AnalyticsDailyService } from '../src/analytics/analytics-daily.service';
import { AnalyticsInsightsService } from '../src/analytics/analytics-insights.service';
import { HomeActivityService } from '../src/home/home-activity.service';
import { HomeService } from '../src/home/home.service';
import type { PrismaService } from '../src/prisma/prisma.service';

function envUrl(): string {
  if (process.env.DIRECT_DATABASE_URL) return process.env.DIRECT_DATABASE_URL;
  const env = readFileSync(join(__dirname, '..', '..', '..', '.env'), 'utf8');
  const m = env.match(/^DIRECT_DATABASE_URL="?([^"\n]+)"?/m);
  if (!m) throw new Error('DIRECT_DATABASE_URL not found');
  return m[1]!;
}

class Rollback extends Error {}

const MARKER_AMOUNT = '987654321.1234';
const failures: string[] = [];
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures.push(msg);
};

async function main(): Promise<void> {
  const prisma = new PrismaClient({ datasources: { db: { url: envUrl() } } });
  try {
    await prisma.$transaction(
      async (tx) => {
        const tenantA = await tx.tenant.findFirstOrThrow({ orderBy: { name: 'asc' } });

        // ── 1. seed tenant B (as owner; RLS not yet in force) ──────────────
        const b = await tx.tenant.create({ data: { name: 'Isolation Probe B' } });
        const userB = await tx.user.create({
          data: { id: newId('user'), tenantId: b.id, email: 'probe-b@example.invalid', name: 'Probe Bee', argonHash: 'x' },
        });
        const vendorB = await tx.vendor.create({
          data: { id: newId('vendor'), tenantId: b.id, code: 'PROBE-V', name: 'Probe Vendor B', isMsme: true },
        });
        const poB = await tx.purchaseOrder.create({
          data: {
            id: newId('purchaseOrder'), tenantId: b.id, number: 'PO-PROBE-B', vendorId: vendorB.id,
            status: 'ISSUED', totalAmount: MARKER_AMOUNT, issuedAt: new Date(),
          },
        });
        const now = new Date();
        const invB = await tx.invoice.create({
          data: {
            id: newId('invoice'), tenantId: b.id, number: 'INV-PROBE-B', vendorId: vendorB.id, poId: poB.id,
            vendorInvoiceRef: 'PROBE', invoiceDate: now, receivedAt: now, status: 'APPROVED',
            grossAmount: MARKER_AMOUNT, netAmount: MARKER_AMOUNT,
            msmeDueDate: new Date(now.getTime() - 86_400_000),
          },
        });
        await tx.$executeRawUnsafe(
          `INSERT INTO "AuditLog" (id, tenant_id, actor_id, action, "entityType", "entityId", after, hash_current)
           VALUES ($1, $2::uuid, $3, 'PO_ISSUED', 'PurchaseOrder', $4, '{}'::jsonb, '')`,
          newId('auditLog'), b.id, userB.id, poB.id,
        );
        await tx.invoiceException.create({
          data: {
            id: newId('invoiceException'), tenantId: b.id, invoiceId: invB.id,
            exceptionType: 'QTY_VARIANCE', details: {}, raisedBy: userB.id,
          },
        });

        // ── 2. switch to the RLS-subject app role ─────────────────────────
        await tx.$executeRawUnsafe(`SET LOCAL ROLE procureflow_app`);
        const ctx = { client: tx, currentTenantId: '' };
        const prismaStub = ctx as unknown as PrismaService;
        const daily = new AnalyticsDailyService(prismaStub);
        const home = new HomeService(prismaStub, daily);
        const activity = new HomeActivityService(prismaStub, daily);
        const insights = new AnalyticsInsightsService(prismaStub, daily);
        const asTenant = async (id: string) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${id}, true)`;
          ctx.currentTenantId = id;
        };

        await asTenant(b.id);
        await daily.refresh(b.id); // RLS WITH CHECK: B may write its own rollup rows
        const bSummary = await home.getSummary();
        const bActivity = await activity.getActivity({ limit: 50 });
        check(bSummary.tiles.spendMtd.value === MARKER_AMOUNT, 'sanity: tenant B sees its own marker spend');
        check(bActivity.items.some((i) => i.title.includes('PO-PROBE-B')), 'sanity: tenant B sees its own activity');

        await asTenant(tenantA.id);
        const raw = await tx.$queryRawUnsafe<{ inv: number; daily: number; audit: number }[]>(
          `SELECT (SELECT COUNT(*)::int FROM "Invoice" WHERE tenant_id = $1::uuid) AS inv,
                  (SELECT COUNT(*)::int FROM "AnalyticsDaily" WHERE tenant_id = $1::uuid) AS daily,
                  (SELECT COUNT(*)::int FROM "AuditLog" WHERE tenant_id = $1::uuid) AS audit`,
          b.id,
        );
        check(
          raw[0]!.inv === 0 && raw[0]!.daily === 0 && raw[0]!.audit === 0,
          `RLS hides tenant B rows from tenant A (invoice/daily/audit visible: ${JSON.stringify(raw[0])})`,
        );

        await daily.refresh(tenantA.id);
        const aSummary = await home.getSummary();
        const aOverview = await insights.getOverview({ period: 'LAST_12M' });
        const aActivity = await activity.getActivity({ limit: 50 });
        const aExpected = await tx.$queryRawUnsafe<{ net: string }[]>(
          `SELECT COALESCE(SUM("netAmount"),0)::text AS net FROM "Invoice"
           WHERE status NOT IN ('REJECTED','RECEIVED','OCR_PENDING','OCR_DONE')
             AND "invoiceDate" >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
        );

        const blob = JSON.stringify({ aSummary, aOverview, aActivity });
        check(!blob.includes('PROBE'), 'tenant A summary/overview/activity contain no tenant-B document numbers');
        check(!blob.includes('987654321'), 'tenant A figures contain no tenant-B marker amount');
        check(
          Number(aSummary.tiles.spendMtd.value) === Number(aExpected[0]!.net),
          `tenant A spend MTD (${aSummary.tiles.spendMtd.value}) equals A-only invoice sum (${aExpected[0]!.net})`,
        );
        check(
          aActivity.items.every((i) => !i.href?.includes(poB.id) && !i.href?.includes(invB.id)),
          'tenant A activity links never point at tenant-B documents',
        );
        check(
          Number(aOverview.spendUnderManagement) < Number(MARKER_AMOUNT),
          `tenant A overview spend (${aOverview.spendUnderManagement}) excludes tenant B`,
        );
        console.log(
          `tenant A: spendMtd=${aSummary.tiles.spendMtd.value} openPos=${aSummary.tiles.openPos.value} ` +
            `activity=${aActivity.items.length} overviewSpend=${aOverview.spendUnderManagement}`,
        );
        throw new Rollback();
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
    console.log('(rolled back — no probe data left behind)');
  } finally {
    await prisma.$disconnect();
  }
  if (failures.length) {
    console.error(`\n${failures.length} isolation check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nAll isolation checks passed.');
}


main().catch((e) => {
  console.error(e);
  process.exit(1);
});
