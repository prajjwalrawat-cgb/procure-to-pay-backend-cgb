/**
 * Seed script — Star Cement Ltd demo tenant (Master Context §11).
 * Creates tenant, roles, users, plant, departments, cost centers, 11 vendors,
 * and 3 approval matrix rules. NO sample POs/invoices in Slice 0.
 *
 * Connects on the DIRECT (owner) URL so it can write across the tenant boundary
 * — the owner bypasses RLS; the runtime app role does not.
 * Idempotent: re-running upserts rather than duplicating.
 */
import { hash } from 'argon2';
import { ALL_ROLES } from '@procureflow/shared';

import { Prisma, PrismaClient } from '@prisma/client';
import { newId } from '../src/ids';
import {
  APPROVAL_RULES,
  BUYER_USERS,
  COST_CENTERS,
  VENDORS,
  VENDOR_USER,
  type SeedUser,
} from './data';

const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL },
  },
});

const TENANT_NAME = 'Star Cement Ltd';
const TENANT_GSTIN = '17AAACS1234M1Z9';

/** Append an audit row for a user creation, once (idempotent). */
async function auditUserCreated(
  tenantId: string,
  actorId: string | null,
  userId: string,
  after: Record<string, unknown>,
): Promise<void> {
  const existing = await prisma.auditLog.findFirst({
    where: { tenantId, entityType: 'User', entityId: userId, action: 'user.created' },
  });
  if (existing) return;

  await prisma.auditLog.create({
    data: {
      id: newId('auditLog'),
      tenantId,
      actorId,
      actorType: actorId ? 'USER' : 'SYSTEM',
      action: 'user.created',
      entityType: 'User',
      entityId: userId,
      before: undefined,
      after: after as Prisma.InputJsonValue,
      // Placeholder — the BEFORE INSERT trigger overwrites with the chained hash.
      hashCurrent: '',
    },
  });
}

async function upsertUser(
  tenantId: string,
  seed: SeedUser,
  actorId: string | null,
): Promise<string> {
  const argonHash = await hash(seed.password, { type: 2 /* argon2id */ });
  const existing = await prisma.user.findUnique({
    where: { tenantId_email: { tenantId, email: seed.email } },
  });

  const user = existing
    ? await prisma.user.update({
        where: { id: existing.id },
        data: { name: seed.name, argonHash, isActive: true },
      })
    : await prisma.user.create({
        data: {
          id: newId('user'),
          tenantId,
          email: seed.email,
          name: seed.name,
          argonHash,
          isActive: true,
        },
      });

  // Re-map roles idempotently.
  await prisma.userRole.deleteMany({ where: { userId: user.id } });
  for (const roleName of seed.roles) {
    const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
    await prisma.userRole.create({
      data: { id: newId('userRole'), tenantId, userId: user.id, roleId: role.id },
    });
  }

  await auditUserCreated(tenantId, actorId, user.id, {
    email: seed.email,
    name: seed.name,
    roles: seed.roles,
  });
  return user.id;
}

async function main(): Promise<void> {
  console.log('Seeding Star Cement Ltd …');

  // 1. Roles (global table).
  for (const name of ALL_ROLES) {
    await prisma.role.upsert({ where: { name }, update: {}, create: { name } });
  }

  // 2. Tenant.
  const existingTenant = await prisma.tenant.findFirst({ where: { name: TENANT_NAME } });
  const tenant =
    existingTenant ??
    (await prisma.tenant.create({
      data: {
        name: TENANT_NAME,
        gstin: TENANT_GSTIN,
        msmePaymentCapDays: 45,
        tdsRate: '0.001',
        currency: 'INR',
      },
    }));
  console.log(`  tenant ${tenant.name} (${tenant.id})`);

  // 3. Plant — Lumshnong, Meghalaya (state code 17).
  const existingPlant = await prisma.plant.findFirst({
    where: { tenantId: tenant.id, name: 'Lumshnong' },
  });
  const plant =
    existingPlant ??
    (await prisma.plant.create({
      data: {
        id: newId('plant'),
        tenantId: tenant.id,
        name: 'Lumshnong',
        gstin: TENANT_GSTIN,
        address: 'Lumshnong, East Jaintia Hills, Meghalaya',
        stateCode: '17',
      },
    }));

  // 4. Departments (derived from the cost-center list) + cost centers.
  const deptNames = [...new Set(COST_CENTERS.map((c) => c.dept))];
  const deptByName = new Map<string, string>();
  for (const name of deptNames) {
    const existing = await prisma.department.findFirst({
      where: { tenantId: tenant.id, name },
    });
    const dept =
      existing ??
      (await prisma.department.create({
        data: { id: newId('department'), tenantId: tenant.id, name, plantId: plant.id },
      }));
    deptByName.set(name, dept.id);
  }

  for (const cc of COST_CENTERS) {
    await prisma.costCenter.upsert({
      where: { tenantId_code: { tenantId: tenant.id, code: cc.code } },
      update: { name: cc.name, budgetAmount: cc.budget },
      create: {
        id: newId('costCenter'),
        tenantId: tenant.id,
        code: cc.code,
        name: cc.name,
        deptId: deptByName.get(cc.dept),
        plantId: plant.id,
        budgetAmount: cc.budget,
        budgetPeriod: 'ANNUAL',
      },
    });
  }

  // 5. Users (Harpreet first, then acts as actor for the rest).
  const [firstUser, ...restUsers] = BUYER_USERS;
  if (!firstUser) throw new Error('BUYER_USERS must not be empty.');
  const harpreetId = await upsertUser(tenant.id, firstUser, null);
  for (const seed of restUsers) {
    await upsertUser(tenant.id, seed, harpreetId);
  }
  // Vendor-portal demo user.
  const vendorUserId = await upsertUser(tenant.id, VENDOR_USER, harpreetId);

  // 6. Vendors (+ primary bank + contact where given).
  for (const v of VENDORS) {
    const vendor = await prisma.vendor.upsert({
      where: { tenantId_code: { tenantId: tenant.id, code: v.code } },
      update: { name: v.name, status: 'ACTIVE', isMsme: v.isMsme },
      create: {
        id: newId('vendor'),
        tenantId: tenant.id,
        code: v.code,
        name: v.name,
        gstin: v.gstin,
        pan: v.pan,
        isMsme: v.isMsme,
        udyamNumber: v.udyamNumber,
        msmeCategory: v.msmeCategory,
        categoryTags: v.categoryTags,
        status: 'ACTIVE',
      },
    });

    if (v.bank) {
      const existingBank = await prisma.vendorBank.findFirst({
        where: { vendorId: vendor.id, ifsc: v.bank.ifsc },
      });
      if (!existingBank) {
        await prisma.vendorBank.create({
          data: {
            id: newId('vendorBank'),
            tenantId: tenant.id,
            vendorId: vendor.id,
            bankName: v.bank.bankName,
            // Slice 0 stub: real field-level encryption arrives with vendor onboarding (Slice 7).
            accountNoEncrypted: `enc:xxxx${v.bank.accountLast4}`,
            ifsc: v.bank.ifsc,
            holderName: v.bank.holderName,
            isVerified: false,
          },
        });
      }
    }
  }

  // Link the vendor-portal user to Patel Engineering via a primary contact.
  const patel = await prisma.vendor.findFirst({
    where: { tenantId: tenant.id, code: 'V-PATEL' },
  });
  if (patel) {
    const existingContact = await prisma.vendorContact.findFirst({
      where: { vendorId: patel.id, email: VENDOR_USER.email },
    });
    if (!existingContact) {
      await prisma.vendorContact.create({
        data: {
          id: newId('vendorContact'),
          tenantId: tenant.id,
          vendorId: patel.id,
          name: VENDOR_USER.name,
          role: 'Accounts',
          email: VENDOR_USER.email,
          isPrimary: true,
        },
      });
    }
  }
  void vendorUserId;

  // 7. Approval matrix rules — real DSL, consumed by the Slice 2 engine.
  for (const rule of APPROVAL_RULES) {
    const existing = await prisma.approvalMatrix.findFirst({
      where: { tenantId: tenant.id, name: rule.name, documentType: rule.documentType },
    });
    if (existing) {
      await prisma.approvalMatrix.update({
        where: { id: existing.id },
        data: {
          conditions: rule.conditions as unknown as Prisma.InputJsonValue,
          steps: rule.steps as unknown as Prisma.InputJsonValue,
          priority: rule.priority,
          isActive: true,
        },
      });
    } else {
      await prisma.approvalMatrix.create({
        data: {
          id: newId('approvalMatrix'),
          tenantId: tenant.id,
          documentType: rule.documentType,
          name: rule.name,
          priority: rule.priority,
          isActive: true,
          version: 1,
          conditions: rule.conditions as unknown as Prisma.InputJsonValue,
          steps: rule.steps as unknown as Prisma.InputJsonValue,
          updatedBy: harpreetId,
        },
      });
    }
  }

  const counts = {
    users: await prisma.user.count({ where: { tenantId: tenant.id } }),
    vendors: await prisma.vendor.count({ where: { tenantId: tenant.id } }),
    costCenters: await prisma.costCenter.count({ where: { tenantId: tenant.id } }),
    matrixRules: await prisma.approvalMatrix.count({ where: { tenantId: tenant.id } }),
    auditRows: await prisma.auditLog.count({ where: { tenantId: tenant.id } }),
  };
  console.log('  seeded:', counts);
  console.log('Done.');
}

main()
  .catch((err: unknown) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
