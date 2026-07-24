/**
 * Artbox baseline seed — master data so the full procure→pay lifecycle works in
 * the live Artbox Solutions tenant WITHOUT any fake vendors/POs/invoices (those
 * are created live during the demo). Reuses the tested Star Cement seed
 * constants (cost centers, items, budgets, approval matrices) but targets the
 * existing Artbox tenant + its real admin user.
 *
 * Idempotent. Connects on the DIRECT (owner) URL (bypasses RLS).
 * Run: node scripts/with-env.mjs pnpm --filter @procureflow/db exec tsx seed/artbox-baseline.ts
 */
import Decimal from 'decimal.js';

import { Prisma, PrismaClient } from '@prisma/client';

import { newId } from '../src/ids';
import { APPROVAL_RULES, BANK_ACCOUNTS, COST_CENTERS } from './data';
import { SLICE4_BUDGETS, SLICE4_ITEMS, SLICE4_MATRICES } from './slice4-data';

const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL },
  },
});

const TENANT_NAME = 'Artbox Solutions';
const ADMIN_EMAIL = 'info@artboxsolutions.com';
const FY_START = new Date('2026-04-01T00:00:00.000Z');
const FY_END = new Date('2027-03-31T23:59:59.000Z');

async function main(): Promise<void> {
  const tenant = await prisma.tenant.findFirstOrThrow({ where: { name: TENANT_NAME } });
  const admin = await prisma.user.findFirstOrThrow({
    where: { tenantId: tenant.id, email: ADMIN_EMAIL },
  });
  const actorId = admin.id;
  console.log(`Seeding baseline into ${tenant.name} (${tenant.id})`);

  // 1. Plant.
  let plant = await prisma.plant.findFirst({ where: { tenantId: tenant.id } });
  plant ??= await prisma.plant.create({
    data: {
      id: newId('plant'),
      tenantId: tenant.id,
      name: 'Head Office',
      address: 'Artbox Solutions HQ',
      stateCode: '27',
    },
  });

  // 2. Departments (derived from the cost-center list).
  const deptByName = new Map<string, string>();
  for (const name of [...new Set(COST_CENTERS.map((c) => c.dept))]) {
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

  // 3. Cost centers.
  const ccByCode = new Map<string, string>();
  for (const cc of COST_CENTERS) {
    const row = await prisma.costCenter.upsert({
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
    ccByCode.set(cc.code, row.id);
  }

  // 4. Item master (vendor pricing skipped — no seeded vendors here).
  for (const spec of SLICE4_ITEMS) {
    const existing = await prisma.item.findFirst({
      where: { tenantId: tenant.id, skuCode: spec.sku },
    });
    if (existing) continue;
    await prisma.item.create({
      data: {
        id: newId('item'),
        tenantId: tenant.id,
        skuCode: spec.sku,
        name: spec.name,
        description: `${spec.name} — ${spec.category}`,
        category: spec.category,
        subcategory: spec.subcategory ?? null,
        hsnCode: spec.hsn,
        gstRate: new Prisma.Decimal(spec.gst),
        primaryUom: spec.uom,
        isCapex: spec.isCapex ?? false,
        uomConversions: {
          create: (spec.conversions ?? []).map((c) => ({
            id: newId('itemUomConversion'),
            tenantId: tenant.id,
            fromUom: c.from,
            toUom: c.to,
            factor: new Prisma.Decimal(c.factor),
          })),
        },
      },
    });
  }

  // 5. Budgets (+ a historical commitment so "remaining" is believable).
  for (const b of SLICE4_BUDGETS) {
    const ccId = ccByCode.get(b.ccCode);
    if (!ccId) continue;
    const existing = await prisma.budget.findFirst({
      where: { tenantId: tenant.id, costCenterId: ccId, isActive: true },
    });
    if (existing) continue;
    const budget = await prisma.budget.create({
      data: {
        id: newId('budget'),
        tenantId: tenant.id,
        costCenterId: ccId,
        periodType: 'ANNUAL',
        periodStart: FY_START,
        periodEnd: FY_END,
        currency: 'INR',
        allocatedAmount: new Prisma.Decimal(b.allocated),
        openingBalance: new Prisma.Decimal(b.allocated),
        committedAmount: new Prisma.Decimal(b.committed),
        rolloverPolicy: 'NONE',
      },
    });
    await prisma.budgetCommitment.create({
      data: {
        id: newId('budgetCommitment'),
        tenantId: tenant.id,
        budgetId: budget.id,
        costCenterId: ccId,
        sourceType: 'PO',
        sourceId: `historical-${b.ccCode}`,
        amount: new Prisma.Decimal(b.committed),
        status: 'COMMITTED',
        committedBy: actorId,
      },
    });
  }

  // 6. Approval matrices — PR/PO (slice4) + INVOICE/PAYMENT_RUN (data.ts).
  const matrices = [...SLICE4_MATRICES, ...APPROVAL_RULES];
  for (const m of matrices) {
    const existing = await prisma.approvalMatrix.findFirst({
      where: { tenantId: tenant.id, name: m.name, documentType: m.documentType },
    });
    if (existing) continue;
    await prisma.approvalMatrix.create({
      data: {
        id: newId('approvalMatrix'),
        tenantId: tenant.id,
        documentType: m.documentType,
        name: m.name,
        priority: m.priority,
        isActive: true,
        version: 1,
        conditions: m.conditions as unknown as Prisma.InputJsonValue,
        steps: m.steps as unknown as Prisma.InputJsonValue,
        updatedBy: actorId,
      },
    });
  }

  // 6b. Catch-all matrices for the other routed document types (onboarding,
  //     vendor change, sourcing award, contracts) so those submissions route to
  //     a single approver instead of failing "no approval matrix matched".
  const EXTRA_MATRICES = [
    { documentType: 'VENDOR_ONBOARDING', name: 'Vendor onboarding — standard', role: 'PROCUREMENT_HEAD' },
    { documentType: 'VENDOR_CHANGE', name: 'Vendor change — material', role: 'PROCUREMENT_HEAD' },
    { documentType: 'RFQ_AWARD', name: 'Award — standard', role: 'FINANCE_HEAD' },
    { documentType: 'CONTRACT', name: 'Contract — standard', role: 'PROCUREMENT_HEAD' },
    { documentType: 'CONTRACT_AMENDMENT', name: 'Contract amendment — standard', role: 'PROCUREMENT_HEAD' },
  ] as const;
  for (const m of EXTRA_MATRICES) {
    const existing = await prisma.approvalMatrix.findFirst({
      where: { tenantId: tenant.id, documentType: m.documentType },
    });
    if (existing) continue;
    await prisma.approvalMatrix.create({
      data: {
        id: newId('approvalMatrix'),
        tenantId: tenant.id,
        documentType: m.documentType,
        name: m.name,
        priority: 1,
        isActive: true,
        version: 1,
        conditions: { all: [] } as unknown as Prisma.InputJsonValue,
        steps: [
          {
            step_no: 1,
            name: m.role.replace(/_/g, ' '),
            role: m.role,
            scope: 'tenant',
            sla_hours: 24,
          },
        ] as unknown as Prisma.InputJsonValue,
        updatedBy: actorId,
      },
    });
  }

  // 7. Invoice 3-way match tolerances (schema defaults).
  const existingMatch = await prisma.tenantMatchConfig.findFirst({
    where: { tenantId: tenant.id },
  });
  if (!existingMatch) {
    await prisma.tenantMatchConfig.create({
      data: { id: `tmc_${tenant.id}`, tenantId: tenant.id },
    });
  }

  // 8. A disbursement bank account (payment-run source).
  const existingBank = await prisma.bankAccount.findFirst({
    where: { tenantId: tenant.id },
  });
  if (!existingBank && BANK_ACCOUNTS[0]) {
    const acc = BANK_ACCOUNTS[0];
    await prisma.bankAccount.create({
      data: {
        id: newId('bankAccount'),
        tenantId: tenant.id,
        bankName: acc.bankName,
        accountNoLast4: acc.accountNoLast4,
        ifsc: acc.ifsc,
        holderName: TENANT_NAME,
        formatKey: acc.formatKey,
        dailyLimit: new Prisma.Decimal(acc.dailyLimit),
        uploadConfig: { tenantCode: 'ARTBOX01' } as Prisma.InputJsonValue,
      },
    });
  }

  const counts = {
    plants: await prisma.plant.count({ where: { tenantId: tenant.id } }),
    departments: await prisma.department.count({ where: { tenantId: tenant.id } }),
    costCenters: await prisma.costCenter.count({ where: { tenantId: tenant.id } }),
    items: await prisma.item.count({ where: { tenantId: tenant.id } }),
    budgets: await prisma.budget.count({ where: { tenantId: tenant.id } }),
    approvalMatrices: await prisma.approvalMatrix.count({ where: { tenantId: tenant.id } }),
    matchConfig: await prisma.tenantMatchConfig.count({ where: { tenantId: tenant.id } }),
    bankAccounts: await prisma.bankAccount.count({ where: { tenantId: tenant.id } }),
  };
  console.log('Artbox baseline seeded:', JSON.stringify(counts, null, 2));
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error('FAILED:', e);
    await prisma.$disconnect();
    process.exit(1);
  });
