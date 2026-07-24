/**
 * One-time migration (Slice 2): retroactively route invoices left at
 * AWAITING_APPROVAL by the Slice 1 stub through the real approval engine.
 *
 * Idempotent — `ApprovalRoutingService.rerouteAwaiting` skips any invoice that
 * already has Approval rows, so it never duplicates audit entries or notifies
 * twice. Instantiates the minimal service graph directly (no Redis workers).
 *
 * Run: pnpm --filter @procureflow/api tsx scripts/reroute-slice1-invoices.ts
 */
import { ApprovalContextService } from '../src/approvals/approval-context.service';
import { ApprovalRoutingService } from '../src/approvals/approval-routing.service';
import { ApproverResolver } from '../src/approvals/approver-resolver.service';
import { NotificationService } from '../src/approvals/notification.service';
import { AuditLogService } from '../src/audit/audit.service';
import { DomainEventService } from '../src/common/events/domain-event.service';
import { PrismaService } from '../src/prisma/prisma.service';

async function main(): Promise<void> {
  const prisma = new PrismaService();
  await prisma.onModuleInit();

  const audit = new AuditLogService(prisma);
  const events = new DomainEventService(prisma);
  const notifications = new NotificationService(prisma);
  const context = new ApprovalContextService(prisma);
  const resolver = new ApproverResolver(prisma);
  const routing = new ApprovalRoutingService(
    prisma,
    audit,
    events,
    context,
    resolver,
    notifications,
  );

  try {
    const tenants = await prisma.tenant.findMany({ select: { id: true, name: true } });
    let total = 0;
    for (const tenant of tenants) {
      const routed = await prisma.runInTenantContext(tenant.id, async () => {
        const admin = await prisma.client.userRole.findFirst({
          where: { role: { name: 'TENANT_ADMIN' } },
        });
        const actorId = admin?.userId ?? 'system';
        return routing.rerouteAwaiting('INVOICE', actorId);
      });
      total += routed;
      console.log(`  ${tenant.name}: routed ${routed} invoice(s).`);
    }
    console.log(`Done — retroactively routed ${total} invoice(s).`);
  } finally {
    await prisma.onModuleDestroy();
  }
}

main().catch((err: unknown) => {
  console.error('reroute-slice1-invoices failed:', err);
  process.exit(1);
});
