/**
 * Data-correction drill (Slice 11c · ADR-037).
 *
 * Proves the compensating-transaction pattern: a mis-keyed value on a POSTED
 * financial record is corrected by appending a NEW, audited correction event —
 * never by a raw UPDATE to the immutable record (Master Context §3 rule #10 +
 * rule #3). After the correction the append-only audit hash chain must still
 * verify end-to-end.
 *
 * The drill:
 *   1. Verifies the tenant's audit chain (baseline).
 *   2. Appends a compensating `INVOICE_AMOUNT_CORRECTED` audit event through the
 *      same path the app uses (insert with empty hash → BEFORE INSERT trigger
 *      chains it). The original Invoice row is left untouched.
 *   3. Re-verifies the chain — it must still be OK, now one row longer.
 *
 * Runs are additive (a correction is a permanent forward record — that is the
 * point). Target a scratch DB via DIRECT_DATABASE_URL to avoid growing dev data.
 *
 * Usage: pnpm --filter @procureflow/db data-correction:drill
 */
import { Client } from 'pg';

import { newId } from '../src/ids';

interface ChainRow {
  id: string;
  hash_current: string;
  hash_previous: string | null;
  prev_link: string | null;
  recomputed: string;
}

async function verifyTenant(client: Client, tenantId: string): Promise<number> {
  const { rows } = await client.query<ChainRow>(
    `SELECT a.id, a.hash_current, a.hash_previous,
            lag(a.hash_current) OVER w AS prev_link,
            encode(sha256((coalesce(a.hash_previous,'') ||
              (to_jsonb(a) - 'hash_current' - 'hash_previous')::text)::bytea),'hex') AS recomputed
     FROM "AuditLog" a WHERE a.tenant_id = $1
     WINDOW w AS (ORDER BY a.timestamp, a.id) ORDER BY a.timestamp, a.id`,
    [tenantId],
  );
  let failures = 0;
  rows.forEach((row, idx) => {
    if (row.recomputed !== row.hash_current) failures += 1;
    const expectedPrev = idx === 0 ? null : row.prev_link;
    if ((row.hash_previous ?? null) !== (expectedPrev ?? null)) failures += 1;
  });
  if (failures > 0) throw new Error(`audit chain FAILED: ${failures} problem(s)`);
  return rows.length;
}

async function main(): Promise<void> {
  const connectionString = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL must be set.');
  const client = new Client({ connectionString });
  await client.connect();

  try {
    const tenant = await client.query<{ id: string; name: string }>(
      `SELECT id, name FROM "Tenant" WHERE name = 'Star Cement Ltd' LIMIT 1`,
    );
    const tenantRow = tenant.rows[0];
    if (!tenantRow) throw new Error('Star Cement tenant not found — seed first.');
    const { id: tenantId, name } = tenantRow;

    const inv = await client.query<{ id: string; number: string; gross_amount: string }>(
      `SELECT id, number, "grossAmount"::text AS gross_amount
       FROM "Invoice" WHERE tenant_id = $1 ORDER BY "receivedAt" LIMIT 1`,
      [tenantId],
    );
    const invoice = inv.rows[0];
    if (!invoice) throw new Error('No invoices for tenant — seed first.');

    console.log(`Tenant: ${name}`);
    console.log(`Target invoice: ${invoice.number} (gross ₹${invoice.gross_amount})`);

    const before = await verifyTenant(client, tenantId);
    console.log(`\n1. Baseline audit chain: OK (${before} rows)`);

    console.log(
      '\n2. WRONG way (NOT executed): UPDATE "Invoice" SET "grossAmount"=… WHERE id=…',
    );
    console.log(
      '   → mutates a posted, immutable record AND leaves no audit trail. Forbidden.',
    );

    // RIGHT way — append a compensating correction event through the app's path.
    const wrongAmount = invoice.gross_amount;
    const correctedAmount = (Number(wrongAmount) + 1).toFixed(4); // illustrative delta
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    await client.query(
      `INSERT INTO "AuditLog"
         (id, tenant_id, timestamp, actor_id, "actorType", action, "entityType", "entityId", before, after, hash_current)
       VALUES ($1,$2, now(), NULL, 'SYSTEM', 'INVOICE_AMOUNT_CORRECTED', 'Invoice', $3, $4, $5, '')`,
      [
        newId('auditLog'),
        tenantId,
        invoice.id,
        JSON.stringify({ grossAmount: wrongAmount }),
        JSON.stringify({
          grossAmount: correctedAmount,
          correctionOf: invoice.id,
          method: 'compensating-entry',
          reason: 'DR/ops drill — mis-keyed amount correction (ADR-037)',
        }),
      ],
    );
    await client.query('COMMIT');
    console.log(
      '\n3. RIGHT way: appended compensating INVOICE_AMOUNT_CORRECTED audit event.',
    );
    console.log('   Original invoice row untouched; correction is a new forward record.');

    const after = await verifyTenant(client, tenantId);
    console.log(
      `\n4. Post-correction audit chain: OK (${after} rows, +${after - before}).`,
    );
    console.log('\n✅ Compensating correction preserved the append-only hash chain.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error('data-correction:drill failed:', err);
  process.exit(1);
});
