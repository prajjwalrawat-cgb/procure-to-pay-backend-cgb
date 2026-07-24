/**
 * One-shot reset — wipe ALL tenant data and provision a single buyer-portal
 * super-admin (TENANT_ADMIN) for Artbox Solutions.
 *
 * - Connects on the DIRECT (owner) URL so it can TRUNCATE across the tenant
 *   boundary and past the append-only AuditLog revoke (owner bypasses both).
 * - Truncates every table in `public` EXCEPT the system `Role` table and
 *   Prisma's migration ledger — schema, RLS, and audit setup are left intact.
 * - Re-ensures the system roles, then creates one tenant + one admin user.
 *
 * Run: node scripts/with-env.mjs pnpm --filter @procureflow/db exec tsx seed/artbox-admin.ts
 */
import { hash } from 'argon2';
import { randomBytes } from 'node:crypto';

import { ALL_ROLES, ROLES } from '@procureflow/shared';

import { PrismaClient } from '@prisma/client';

import { newId } from '../src/ids';

const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL },
  },
});

const TENANT_NAME = 'Artbox Solutions';
const ADMIN_EMAIL = 'info@artboxsolutions.com';
const ADMIN_NAME = 'Admin';

/** Strong random password with guaranteed upper/lower/digit/symbol classes. */
function generatePassword(): string {
  const body = randomBytes(18).toString('base64').replace(/[+/=]/g, '').slice(0, 18);
  return `Aa1!${body}`;
}

async function main(): Promise<void> {
  // 1. Wipe every data table (keep the system Role table + migration ledger).
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT IN ('_prisma_migrations', 'Role')
  `;
  if (tables.length > 0) {
    const list = tables.map((t) => `"${t.tablename}"`).join(', ');
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  }
  console.log(`Wiped ${tables.length} tables.`);

  // 2. Ensure the canonical system roles exist.
  for (const name of ALL_ROLES) {
    await prisma.role.upsert({ where: { name }, update: {}, create: { name } });
  }

  // 3. The buyer organisation (tenant).
  const tenant = await prisma.tenant.create({ data: { name: TENANT_NAME } });

  // 4. The super-admin user (buyer portal head).
  const password = generatePassword();
  const argonHash = await hash(password, { type: 2 /* argon2id */ });
  const user = await prisma.user.create({
    data: {
      id: newId('user'),
      tenantId: tenant.id,
      email: ADMIN_EMAIL,
      name: ADMIN_NAME,
      argonHash,
      isActive: true,
    },
  });

  // 5. Grant TENANT_ADMIN (customer super-admin).
  const adminRole = await prisma.role.findUniqueOrThrow({
    where: { name: ROLES.TENANT_ADMIN },
  });
  await prisma.userRole.create({
    data: { id: newId('userRole'), tenantId: tenant.id, userId: user.id, roleId: adminRole.id },
  });

  console.log('\n============ Buyer portal admin provisioned ============');
  console.log(` Tenant   : ${tenant.name} (${tenant.id})`);
  console.log(` Email    : ${ADMIN_EMAIL}`);
  console.log(` Name     : ${ADMIN_NAME}`);
  console.log(` Role     : ${ROLES.TENANT_ADMIN}`);
  console.log(` Password : ${password}`);
  console.log('========================================================\n');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
