/**
 * Slice 11b — RLS coverage gate (permanent CI gate).
 *
 * Enforces the Master Context §3 rule #1 invariant: every table carrying a
 * `tenant_id` column MUST have row-level security enabled AND a policy. Queries
 * the live catalog (pg_class / pg_policies / information_schema) so a newly-added
 * tenanted table that forgot RLS fails CI — this can never silently regress.
 *
 * Exit 0 = all tenanted tables protected. Exit 1 = one or more gaps (CI fails).
 *
 * Run: node scripts/with-env.mjs pnpm --filter @procureflow/db rls:check
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL ?? '' },
  },
});

interface Row {
  table: string;
  rls_enabled: boolean;
  has_tenant_id: boolean;
  policy_count: number;
}

async function main(): Promise<void> {
  const rows = await prisma.$queryRawUnsafe<Row[]>(`
    SELECT
      c.relname AS "table",
      c.relrowsecurity AS "rls_enabled",
      EXISTS (
        SELECT 1 FROM information_schema.columns col
        WHERE col.table_schema = 'public' AND col.table_name = c.relname
          AND col.column_name = 'tenant_id'
      ) AS "has_tenant_id",
      (SELECT count(*)::int FROM pg_policies p
         WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS "policy_count"
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND c.relname <> '_prisma_migrations'
    ORDER BY c.relname
  `);

  const tenanted = rows.filter((r) => r.has_tenant_id);
  const gaps = tenanted.filter((r) => !r.rls_enabled || r.policy_count === 0);

  console.log(
    `RLS coverage: ${tenanted.length} tenanted tables · ${
      tenanted.length - gaps.length
    } protected · ${gaps.length} gap(s)\n`,
  );

  if (gaps.length > 0) {
    console.error('❌ FAIL — tenanted tables missing RLS / policy:');
    for (const g of gaps) {
      console.error(
        `   ${g.table}  (rls_enabled=${g.rls_enabled}, policies=${g.policy_count})`,
      );
    }
    console.error(
      '\nAdd the table to packages/db/prisma/security/01-rls.sql and re-run security:apply.',
    );
    await prisma.$disconnect();
    process.exit(1);
  }

  console.log('✅ PASS — every tenanted table has RLS enabled + a policy.');
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
