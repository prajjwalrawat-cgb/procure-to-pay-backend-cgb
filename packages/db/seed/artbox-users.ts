/**
 * Artbox role users — a named demo cast (one clean role each) seeded active into
 * the live Artbox Solutions tenant so every step of the procure→pay lifecycle
 * has a real actor/approver. Idempotent: upserts by email, (re)sets password +
 * role. All share one demo password. Connects on the DIRECT (owner) URL.
 *
 * Run: node scripts/with-env.mjs pnpm --filter @procureflow/db exec tsx seed/artbox-users.ts
 */
import { hash } from 'argon2';

import { PrismaClient } from '@prisma/client';

import { newId } from '../src/ids';

const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL },
  },
});

const TENANT_NAME = 'Artbox Solutions';
const PASSWORD = 'Demo@2026';

const USERS: { email: string; name: string; role: string }[] = [
  { email: 'harpreet@artboxsolutions.com', name: 'Harpreet Singh', role: 'PROCUREMENT_HEAD' },
  { email: 'sunil@artboxsolutions.com', name: 'Sunil Nair', role: 'PROCUREMENT_OFFICER' },
  { email: 'banerjee@artboxsolutions.com', name: 'M. Banerjee', role: 'PLANT_HEAD' },
  { email: 'iyer@artboxsolutions.com', name: 'M. Iyer', role: 'FINANCE_OFFICER' },
  { email: 'das@artboxsolutions.com', name: 'R. Das', role: 'FINANCE_HEAD' },
  { email: 'menon@artboxsolutions.com', name: 'A. Menon', role: 'MD' },
  { email: 'kumar@artboxsolutions.com', name: 'R. Kumar', role: 'STORES_OFFICER' },
  { email: 'priya@artboxsolutions.com', name: 'Priya Rao', role: 'QC_OFFICER' },
  { email: 'legal@artboxsolutions.com', name: 'N. Verma', role: 'LEGAL_OFFICER' },
  { email: 'auditor@artboxsolutions.com', name: 'S. Gupta', role: 'AUDITOR' },
  { email: 'requester@artboxsolutions.com', name: 'K. Sharma', role: 'REQUESTER' },
];

async function main(): Promise<void> {
  const tenant = await prisma.tenant.findFirstOrThrow({ where: { name: TENANT_NAME } });
  const argonHash = await hash(PASSWORD, { type: 2 /* argon2id */ });

  for (const u of USERS) {
    const email = u.email.toLowerCase();
    const existing = await prisma.user.findUnique({
      where: { tenantId_email: { tenantId: tenant.id, email } },
    });
    const user = existing
      ? await prisma.user.update({
          where: { id: existing.id },
          data: { name: u.name, argonHash, isActive: true, invitedAt: null },
        })
      : await prisma.user.create({
          data: {
            id: newId('user'),
            tenantId: tenant.id,
            email,
            name: u.name,
            argonHash,
            isActive: true,
          },
        });

    const role = await prisma.role.findUniqueOrThrow({ where: { name: u.role } });
    await prisma.userRole.deleteMany({ where: { userId: user.id } });
    await prisma.userRole.create({
      data: { id: newId('userRole'), tenantId: tenant.id, userId: user.id, roleId: role.id },
    });
  }

  console.log(`\n=== Artbox role users seeded (password: ${PASSWORD}) ===`);
  for (const u of USERS) console.log(` ${u.role.padEnd(20)} ${u.email}  (${u.name})`);
  console.log('========================================================\n');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error('FAILED:', e);
    await prisma.$disconnect();
    process.exit(1);
  });
