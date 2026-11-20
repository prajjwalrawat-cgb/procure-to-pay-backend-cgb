/**
 * One-time backfill: bring every issued purchase order's status in line with
 * its invoices and payments (PoStatusService).
 *
 * Until now nothing set PARTIALLY_INVOICED / INVOICED / CLOSED, so orders that
 * were invoiced — even paid in full — still read ISSUED or ACKNOWLEDGED.
 * Draft, approval, ON_HOLD and CANCELLED orders are never touched.
 *
 * Dry run by default: prints what would change. Pass --apply to write; each
 * change is recorded in the audit log as PO_STATUS_CHANGED (system actor).
 * Idempotent — a second run finds nothing to change.
 *
 * Run: pnpm --filter @procureflow/api tsx scripts/recompute-po-statuses.ts [--apply]
 */
import { AuditLogService } from '../src/audit/audit.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { PoStatusService } from '../src/purchase-orders/po-status.service';

const DERIVED = [
  'ISSUED',
  'ACKNOWLEDGED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'PARTIALLY_INVOICED',
  'INVOICED',
  'CLOSED',
] as const;

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaService();
  await prisma.onModuleInit();
  const poStatus = new PoStatusService(prisma, new AuditLogService(prisma));

  try {
    const tenants = await prisma.tenant.findMany({ select: { id: true, name: true } });
    let changed = 0;
    for (const tenant of tenants) {
      const pos = await prisma.runInTenantContext(tenant.id, () =>
        prisma.client.purchaseOrder.findMany({
          where: { status: { in: [...DERIVED] } },
          select: {
            id: true,
            number: true,
            status: true,
            acknowledgedAt: true,
            totalAmount: true,
            lines: { select: { id: true, qtyOrdered: true, qtyReceived: true } },
            invoices: {
              where: { status: { not: 'REJECTED' } },
              select: {
                status: true,
                grossAmount: true,
                lines: { select: { poLineId: true, qty: true } },
              },
            },
          },
          orderBy: { number: 'asc' },
        }),
      );
      for (const po of pos) {
        const next = PoStatusService.derive(po, po.invoices);
        if (next === po.status) continue;
        changed += 1;
        console.log(`  ${tenant.name}  ${po.number}: ${po.status} -> ${next}`);
        if (apply) {
          // One short transaction per order, so a failure stops at a clean boundary.
          await prisma.runInTenantContext(tenant.id, () => poStatus.recompute(po.id));
        }
      }
    }
    console.log(
      apply
        ? `Done — updated ${changed} purchase order(s).`
        : `Dry run — ${changed} purchase order(s) would change. Re-run with --apply to write.`,
    );
  } finally {
    await prisma.onModuleDestroy();
  }
}

main().catch((err: unknown) => {
  console.error('recompute-po-statuses failed:', err);
  process.exit(1);
});
