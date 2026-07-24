/**
 * Applies the RLS + audit-chain security SQL after `prisma migrate`.
 * Run against the DIRECT (owner) connection so it can ALTER tables and REVOKE.
 * Idempotent: safe to run on every migrate.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SECURITY_DIR = join(__dirname, '..', 'prisma', 'security');

const FILES = [
  '00-extensions.sql',
  '01-rls.sql',
  '02-audit-chain.sql',
  '03-auth-functions.sql',
];

async function main(): Promise<void> {
  const connectionString = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DIRECT_DATABASE_URL (or DATABASE_URL) must be set.');
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    for (const file of FILES) {
      const sql = readFileSync(join(SECURITY_DIR, file), 'utf8');
      process.stdout.write(`  applying ${file} ... `);
      await client.query(sql);
      process.stdout.write('ok\n');
    }
    console.log('Security SQL applied (RLS + audit chain).');
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error('Failed to apply security SQL:', err);
  process.exit(1);
});
