/**
 * Repairs vendors stranded by an onboarding re-submission.
 *
 * The vendor portal used to keep offering "Submit for review" after a vendor was
 * approved. Re-submitting set lifecycle_status back to UNDER_REVIEW while the
 * legacy `status` stayed ACTIVE, so the vendor:
 *   - vanished from the Active list but sat in the onboarding queue as Approved,
 *   - still appeared in the PO vendor picker (which read `status`) yet failed at
 *     submit with "Vendor is not active" (which reads lifecycle_status),
 *   - had NO approval to decide: ApprovalRoutingService.submit is idempotent and
 *     the original decided rows already existed, so nothing was ever routed.
 * There is therefore no in-app way back to ACTIVE; hence this script.
 *
 * It only touches vendors that were genuinely activated before and whose latest
 * onboarding is APPROVED. SUSPENDED and BLOCKED are deliberate states and are
 * never resurrected. Idempotent, and reports what it changed.
 *
 * Run: node scripts/with-env.mjs pnpm --filter @procureflow/db exec tsx scripts/repair-resubmitted-vendors.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL },
  },
});

async function main(): Promise<void> {
  const stranded = await prisma.vendor.findMany({
    where: {
      lifecycleStatus: 'UNDER_REVIEW',
      activatedAt: { not: null },
      onboardings: { some: { reviewDecision: 'APPROVED' } },
    },
    select: { id: true, code: true, name: true, status: true, activatedAt: true },
  });

  if (stranded.length === 0) {
    console.log('No stranded vendors — nothing to repair.');
    return;
  }

  console.log(`Found ${stranded.length} vendor(s) approved but not active:`);
  for (const v of stranded) {
    await prisma.vendor.update({
      where: { id: v.id },
      data: { lifecycleStatus: 'ACTIVE', status: 'ACTIVE' },
    });
    console.log(
      `  restored ${v.name} (${v.code}) → ACTIVE (originally activated ${v.activatedAt?.toISOString() ?? 'unknown'})`,
    );
  }
  console.log('\nDone. These vendors can receive purchase orders again.');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error('FAILED:', e);
    await prisma.$disconnect();
    process.exit(1);
  });
