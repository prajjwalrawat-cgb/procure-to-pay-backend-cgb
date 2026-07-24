/**
 * Slice 2 seed — approval engine demo data for Star Cement.
 *
 * Idempotent. Connects on the DIRECT (owner) URL. Adds:
 *   • AUDITOR user Priya Rao (for the /audit walkthrough)
 *   • a standing Delegation record (for the inbox delegation filters)
 *   • Notification rows for R. Das
 *   • routes INV-4471 and the existing AWAITING_APPROVAL invoices through the
 *     real matrix DSL so they land in the resolved approver's inbox.
 *
 * Routing here mirrors ApprovalRoutingService but stays standalone (no Nest) so
 * the seed can run from the db package. It is idempotent: an invoice that already
 * has Approval rows is skipped, so re-running never double-routes or double-audits.
 */
import { hash } from 'argon2';
import {
  ROLES,
  evaluateConditions,
  type ApprovalContext,
  type ApprovalStep,
  type Condition,
  type RoleName,
} from '@procureflow/shared';

import { Prisma, PrismaClient } from '@prisma/client';
import { newId } from '../src/ids';

const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL },
  },
});

const DAY = 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
  const tenant = await prisma.tenant.findFirstOrThrow({
    where: { name: 'Star Cement Ltd' },
  });
  const tenantId = tenant.id;
  const harpreet = await userByEmail(tenantId, 'harpreet@star-cement.example');
  const das = await userByEmail(tenantId, 'r.das@star-cement.example');
  const kumar = await userByEmail(tenantId, 'r.kumar@star-cement.example');
  const banerjee = await userByEmail(tenantId, 'm.banerjee@star-cement.example');

  // 1. AUDITOR user Priya Rao.
  await upsertAuditor(tenantId, harpreet.id);

  // 2. Standing delegation (Stores Officer → Plant Head). Kumar is never routed
  //    under the seed rules, so this is inert for routing — it only populates the
  //    inbox "Delegated by / to me" views.
  const existingDelegation = await prisma.delegation.findFirst({
    where: { tenantId, userId: kumar.id, delegateUserId: banerjee.id },
  });
  if (!existingDelegation) {
    await prisma.delegation.create({
      data: {
        id: newId('delegation'),
        tenantId,
        userId: kumar.id,
        delegateUserId: banerjee.id,
        scope: 'ALL',
        documentTypes: [],
        reason: 'On-site inspection cover',
        fromDate: new Date(Date.now() - DAY),
        toDate: new Date(Date.now() + 7 * DAY),
        isActive: true,
        createdBy: harpreet.id,
      },
    });
  }

  // 3. Route the demo invoices (INV-4471 + any already-AWAITING invoices).
  await routeInvoice(tenantId, 'inv_4471', harpreet.id);
  const awaiting = await prisma.invoice.findMany({
    where: { tenantId, status: 'AWAITING_APPROVAL' },
    select: { id: true },
  });
  for (const inv of awaiting) {
    await routeInvoice(tenantId, inv.id, harpreet.id);
  }

  // 4. A notification for R. Das (inbox badge / tray demo).
  await ensureNotification(
    tenantId,
    das.id,
    'INV-4471 awaiting your approval',
    'inv_4471',
  );

  const counts = {
    auditors: await prisma.user.count({
      where: { tenantId, userRoles: { some: { role: { name: ROLES.AUDITOR } } } },
    }),
    delegations: await prisma.delegation.count({ where: { tenantId } }),
    approvals: await prisma.approval.count({ where: { tenantId } }),
    notifications: await prisma.notification.count({ where: { tenantId } }),
  };
  console.log('Slice 2 seed complete:', counts);
}

// ── routing (standalone mirror of ApprovalRoutingService) ────────────────────

async function routeInvoice(
  tenantId: string,
  invoiceId: string,
  submitterId: string,
): Promise<void> {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) return;

  // Idempotent: never re-route a document that already has approvals.
  const existing = await prisma.approval.count({
    where: { tenantId, documentType: 'INVOICE', documentId: invoiceId },
  });
  if (existing > 0) return;

  // Resolve any open exceptions so routing is legal (Slice 1 gate).
  await prisma.invoiceException.updateMany({
    where: { invoiceId, resolvedAt: null },
    data: {
      resolvedAt: new Date(),
      resolvedBy: submitterId,
      resolutionAction: 'ACCEPT_VARIANCE',
      resolutionNotes: 'Auto-resolved for Slice 2 routing demo.',
    },
  });

  const vendor = await prisma.vendor.findUniqueOrThrow({
    where: { id: invoice.vendorId },
  });
  const ctx: ApprovalContext = {
    documentType: 'INVOICE',
    total_amount: invoice.grossAmount.toString(),
    tax_amount: invoice.taxAmount.toString(),
    net_amount: invoice.netAmount.toString(),
    currency: invoice.currency,
    vendor: { is_msme: vendor.isMsme, gstin: vendor.gstin },
  };

  const matrices = await prisma.approvalMatrix.findMany({
    where: { tenantId, documentType: 'INVOICE', isActive: true },
    orderBy: { priority: 'asc' },
  });
  const matched = matrices.find(
    (m) => evaluateConditions(m.conditions as unknown as Condition, ctx).matched,
  );
  if (!matched) return;

  const steps = matched.steps as unknown as ApprovalStep[];
  const firstStepNo = Math.min(...steps.map((s) => s.step_no));
  const firstSteps = steps.filter((s) => s.step_no === firstStepNo);

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      status: 'AWAITING_APPROVAL',
      approvalMatrixSnapshot: {
        matrixId: matched.id,
        name: matched.name,
        version: matched.version,
        steps: steps as unknown as Prisma.InputJsonValue,
      } as Prisma.InputJsonValue,
    },
  });

  for (const step of firstSteps) {
    const approver = await resolveApprover(tenantId, step.role, submitterId);
    if (!approver) continue;
    await prisma.approval.create({
      data: {
        id: newId('approval'),
        tenantId,
        documentType: 'INVOICE',
        documentId: invoiceId,
        stepNo: step.step_no,
        stepName: step.name,
        scope: step.scope,
        parallelGroup: step.parallel_group ?? null,
        approverId: approver,
        slaHours: step.sla_hours,
        slaDueAt: new Date(Date.now() + step.sla_hours * 60 * 60 * 1000),
        matrixSnapshotId: matched.id,
      },
    });
  }

  await audit(tenantId, submitterId, 'DOCUMENT_ROUTED', invoiceId, {
    matrixId: matched.id,
    matrix: matched.name,
    firstStep: firstStepNo,
  });
}

/** Resolve the sole tenant-scoped user holding a role. Skips the submitter. */
async function resolveApprover(
  tenantId: string,
  role: RoleName,
  submitterId: string,
): Promise<string | null> {
  const roleRow = await prisma.role.findUnique({ where: { name: role } });
  if (!roleRow) return null;
  const userRoles = await prisma.userRole.findMany({
    where: { tenantId, roleId: roleRow.id },
  });
  const candidates = userRoles.map((ur) => ur.userId).filter((id) => id !== submitterId);
  return candidates.length === 1 ? (candidates[0] ?? null) : (candidates[0] ?? null);
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function upsertAuditor(tenantId: string, actorId: string): Promise<void> {
  const email = 'priya.rao@star-cement.example';
  const argon = await hash('Slice0!Demo', { type: 2 });
  const existing = await prisma.user.findUnique({
    where: { tenantId_email: { tenantId, email } },
  });
  const user =
    existing ??
    (await prisma.user.create({
      data: { id: newId('user'), tenantId, email, name: 'Priya Rao', argonHash: argon },
    }));
  const role = await prisma.role.findUniqueOrThrow({ where: { name: ROLES.AUDITOR } });
  const hasRole = await prisma.userRole.findFirst({
    where: { userId: user.id, roleId: role.id },
  });
  if (!hasRole) {
    await prisma.userRole.create({
      data: { id: newId('userRole'), tenantId, userId: user.id, roleId: role.id },
    });
  }
  const audited = await prisma.auditLog.findFirst({
    where: { tenantId, entityType: 'User', entityId: user.id, action: 'user.created' },
  });
  if (!audited) {
    await prisma.auditLog.create({
      data: {
        id: newId('auditLog'),
        tenantId,
        actorId,
        actorType: 'USER',
        action: 'user.created',
        entityType: 'User',
        entityId: user.id,
        after: { email, name: 'Priya Rao', roles: [ROLES.AUDITOR] },
        hashCurrent: '',
      },
    });
  }
}

async function ensureNotification(
  tenantId: string,
  userId: string,
  title: string,
  entityId: string,
): Promise<void> {
  const existing = await prisma.notification.findFirst({
    where: { tenantId, userId, entityId, title },
  });
  if (existing) return;
  await prisma.notification.create({
    data: {
      id: newId('notification'),
      tenantId,
      userId,
      type: 'APPROVAL_REQUESTED',
      title,
      entityType: 'Invoice',
      entityId,
      href: `/invoices/${entityId}`,
    },
  });
}

async function audit(
  tenantId: string,
  actorId: string | null,
  action: string,
  entityId: string,
  after: Record<string, unknown>,
): Promise<void> {
  const exists = await prisma.auditLog.findFirst({
    where: { tenantId, entityId, action },
  });
  if (exists) return;
  await prisma.auditLog.create({
    data: {
      id: newId('auditLog'),
      tenantId,
      actorId,
      actorType: actorId ? 'USER' : 'SYSTEM',
      action,
      entityType: 'Invoice',
      entityId,
      after: after as Prisma.InputJsonValue,
      hashCurrent: '',
    },
  });
}

async function userByEmail(tenantId: string, email: string) {
  return prisma.user.findUniqueOrThrow({
    where: { tenantId_email: { tenantId, email } },
  });
}

main()
  .catch((err: unknown) => {
    console.error('Slice 2 seed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
