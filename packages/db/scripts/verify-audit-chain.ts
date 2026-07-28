/**
 * Verifies the audit log hash chain (Master Context §3 rule #3).
 *
 * For every tenant, walks its AuditLog rows in insert order and checks two
 * invariants using Postgres's OWN digest (so serialization matches the trigger
 * byte-for-byte):
 *   1. Linkage:   row[i].hash_previous == row[i-1].hash_current
 *   2. Integrity: recomputed sha256 == stored hash_current
 *
 * Exit 0 + "OK" if every chain verifies; exit 1 + details otherwise.
 *
 * Usage: pnpm audit:verify [--from=<ISO>] [--to=<ISO>]
 *
 * The recompute always uses the FULL chain (linkage needs prior rows), but the
 * pass/fail report can be scoped to a [from, to] window so a nightly cron only
 * flags tampering inside the day it audits.
 */
import { Client } from 'pg';

interface Row {
  id: string;
  timestamp: Date;
  hash_current: string;
  hash_previous: string | null;
  prev_link: string | null;
  recomputed: string;
}

function parseArg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main(): Promise<void> {
  const connectionString = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL must be set.');

  const fromArg = parseArg('from');
  const toArg = parseArg('to');
  const from = fromArg ? new Date(fromArg) : null;
  const to = toArg ? new Date(toArg) : null;
  if (from && Number.isNaN(from.getTime())) throw new Error(`Invalid --from: ${fromArg}`);
  if (to && Number.isNaN(to.getTime())) throw new Error(`Invalid --to: ${toArg}`);

  const client = new Client({ connectionString });
  await client.connect();
  let failures = 0;
  let totalRows = 0;
  let checkedRows = 0;

  try {
    const tenants = await client.query<{ id: string; name: string }>(
      'SELECT id, name FROM "Tenant" ORDER BY name',
    );

    for (const tenant of tenants.rows) {
      const { rows } = await client.query<Row>(
        `SELECT a.id,
                a.timestamp,
                a.hash_current,
                a.hash_previous,
                lag(a.hash_current) OVER w AS prev_link,
                encode(
                  sha256(
                    convert_to(
                      coalesce(a.hash_previous, '') ||
                      (to_jsonb(a) - 'hash_current' - 'hash_previous')::text,
                      'UTF8'
                    )
                  ), 'hex'
                ) AS recomputed
         FROM "AuditLog" a
         WHERE a.tenant_id = $1
         WINDOW w AS (ORDER BY a.timestamp, a.id)
         ORDER BY a.timestamp, a.id`,
        [tenant.id],
      );

      rows.forEach((row, idx) => {
        totalRows += 1;
        const inWindow = (!from || row.timestamp >= from) && (!to || row.timestamp <= to);
        if (!inWindow) return;
        checkedRows += 1;
        if (row.recomputed !== row.hash_current) {
          failures += 1;
          console.error(
            `  [${tenant.name}] row ${row.id}: INTEGRITY FAIL (hash mismatch)`,
          );
        }
        const expectedPrev = idx === 0 ? null : row.prev_link;
        if ((row.hash_previous ?? null) !== (expectedPrev ?? null)) {
          failures += 1;
          console.error(`  [${tenant.name}] row ${row.id}: LINKAGE FAIL (broken chain)`);
        }
      });

      console.log(`  ${tenant.name}: ${rows.length} audit rows walked.`);
    }
  } finally {
    await client.end();
  }

  const scope = from || to ? ` in window [${fromArg ?? '−∞'}, ${toArg ?? '+∞'}]` : '';
  if (failures === 0) {
    console.log(
      `OK — audit chain verified across ${checkedRows}/${totalRows} rows${scope}.`,
    );
    process.exit(0);
  } else {
    console.error(`FAILED — ${failures} problem(s) found${scope}.`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('audit:verify crashed:', err);
  process.exit(1);
});
