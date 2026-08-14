/**
 * Artbox — collapse every approval chain to a single approver: the workspace
 * owner (TENANT_ADMIN). Also moves Shivam Dubey from PROCUREMENT_HEAD to
 * PROCUREMENT_OFFICER.
 *
 * Why: the seeded ladders (plant head → procurement head → finance head → MD)
 * name roles this tenant does not staff — there is no MD or legal officer, and
 * the only finance head is deactivated — so anything above ₹5L had nowhere to
 * route. Every routed document type now gets ONE active rule that matches all
 * documents and assigns a single step to the admin.
 *
 * Existing rules are DEACTIVATED, never deleted: re-activate any of them from
 * the approval matrix page (History) to roll back. Idempotent — safe to re-run.
 *
 * Run: node scripts/with-env.mjs pnpm --filter @procureflow/db exec tsx seed/artbox-single-approver.ts
 */
import { Prisma, PrismaClient, type DocumentType } from '@prisma/client';

import { newId } from '../src/ids';

const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL },
  },
});

const TENANT_NAME = 'Artbox Solutions';
const ADMIN_EMAIL = 'info@artboxsolutions.com';
/** Procurement head who becomes an officer; skipped if the user is absent. */
const DEMOTE_EMAIL = 'shivam.dubey@artboxsolutions.com';
/** What they become — the same pair every other officer in this tenant holds. */
const DEMOTE_TO_ROLES = ['PROCUREMENT_OFFICER', 'REQUESTER'];

/** Every document type the approval engine routes (GRN has no context builder). */
const DOC_TYPES: { documentType: DocumentType; label: string }[] = [
  { documentType: 'REQUISITION', label: 'requisitions' },
  { documentType: 'PURCHASE_ORDER', label: 'purchase orders' },
  { documentType: 'INVOICE', label: 'invoices' },
  { documentType: 'PAYMENT_RUN', label: 'payment runs' },
  { documentType: 'RFQ_AWARD', label: 'sourcing awards' },
  { documentType: 'VENDOR_ONBOARDING', label: 'vendor onboarding' },
  { documentType: 'VENDOR_CHANGE', label: 'vendor changes' },
  { documentType: 'CONTRACT', label: 'contracts' },
  { documentType: 'CONTRACT_AMENDMENT', label: 'contract amendments' },
];

const ADMIN_STEP = [
  { step_no: 1, name: 'Admin', role: 'TENANT_ADMIN', scope: 'tenant', sla_hours: 24 },
];
/** Empty `all` matches every document — one rule covers the whole type. */
const MATCH_ALL = { all: [] };

async function main(): Promise<void> {
  const tenant = await prisma.tenant.findFirstOrThrow({ where: { name: TENANT_NAME } });
  const admin = await prisma.user.findFirstOrThrow({
    where: { tenantId: tenant.id, email: ADMIN_EMAIL },
  });
  const adminRole = await prisma.role.findUniqueOrThrow({
    where: { name: 'TENANT_ADMIN' },
  });
  const holdsAdmin = await prisma.userRole.findFirst({
    where: { userId: admin.id, roleId: adminRole.id },
  });
  if (!holdsAdmin) {
    throw new Error(
      `${ADMIN_EMAIL} does not hold TENANT_ADMIN — refusing to route to them.`,
    );
  }
  // A second admin would make every step ambiguous (the resolver needs exactly one).
  const adminCount = await prisma.userRole.count({
    where: { tenantId: tenant.id, roleId: adminRole.id },
  });
  if (adminCount > 1) {
    throw new Error(
      `${adminCount} users hold TENANT_ADMIN; routing to that role needs exactly one.`,
    );
  }

  console.log(`Tenant ${tenant.name} (${tenant.id}) — sole approver: ${admin.name}`);

  // 1. Park every current rule. Kept on the record so History can restore them.
  const parked = await prisma.approvalMatrix.updateMany({
    where: { tenantId: tenant.id, isActive: true },
    data: { isActive: false },
  });
  console.log(`Deactivated ${parked.count} existing rule(s).`);

  // 2. One active admin-approval rule per document type.
  for (const dt of DOC_TYPES) {
    const name = `Admin approval — all ${dt.label}`;
    const existing = await prisma.approvalMatrix.findFirst({
      where: { tenantId: tenant.id, documentType: dt.documentType, name },
    });
    const data = {
      priority: 1,
      isActive: true,
      conditions: MATCH_ALL as unknown as Prisma.InputJsonValue,
      steps: ADMIN_STEP as unknown as Prisma.InputJsonValue,
      updatedBy: admin.id,
    };
    if (existing) {
      await prisma.approvalMatrix.update({ where: { id: existing.id }, data });
      console.log(`  updated  ${name}`);
    } else {
      await prisma.approvalMatrix.create({
        data: {
          id: newId('approvalMatrix'),
          tenantId: tenant.id,
          documentType: dt.documentType,
          name,
          version: 1,
          ...data,
        },
      });
      console.log(`  created  ${name}`);
    }
  }

  // 3. Procurement head → procurement officer, with the same pair of roles the
  //    tenant's other officers hold (they raise their own requisitions too).
  const demote = await prisma.user.findFirst({
    where: { tenantId: tenant.id, email: DEMOTE_EMAIL },
  });
  if (!demote) {
    console.log(`No user ${DEMOTE_EMAIL} — role change skipped.`);
  } else {
    const roles = await prisma.role.findMany({
      where: { name: { in: DEMOTE_TO_ROLES } },
    });
    await prisma.userRole.deleteMany({ where: { userId: demote.id } });
    for (const role of roles) {
      await prisma.userRole.create({
        data: {
          id: newId('userRole'),
          tenantId: tenant.id,
          userId: demote.id,
          roleId: role.id,
        },
      });
    }
    console.log(`${demote.name} is now ${roles.map((r) => r.name).join(' + ')}.`);
  }

  // 4. In-flight documents kept the chain they snapshotted at submit time, so
  //    they still sit with the old approver. Hand those to the admin too —
  //    otherwise they stall on someone who no longer holds the role.
  const stranded = await prisma.approval.findMany({
    where: {
      tenantId: tenant.id,
      decision: 'PENDING',
      approverId: { not: admin.id },
    },
    select: { id: true, documentType: true, documentId: true },
  });
  if (stranded.length > 0) {
    await prisma.approval.updateMany({
      where: { id: { in: stranded.map((a) => a.id) } },
      data: { approverId: admin.id, stepName: 'Admin', delegatedFromId: null },
    });
    for (const a of stranded) {
      console.log(
        `Reassigned pending ${a.documentType} ${a.documentId} to ${admin.name}.`,
      );
    }
  } else {
    console.log('No pending approvals needed reassigning.');
  }

  const active = await prisma.approvalMatrix.count({
    where: { tenantId: tenant.id, isActive: true },
  });
  console.log(`\nDone — ${active} active rule(s), all routing to ${admin.name}.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error('FAILED:', e);
    await prisma.$disconnect();
    process.exit(1);
  });
