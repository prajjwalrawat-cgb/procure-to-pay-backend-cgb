/**
 * Slice 14 seed — physical box fixtures.
 *
 * Labels the location tree (Warehouse → Rack → Section) and puts two boxes on
 * shelves, one of them packed, so the "scan a box" and "where is this product"
 * screens have something real to show.
 *
 * Idempotent. Connects on the DIRECT (owner) URL so it bypasses RLS.
 *
 * Run:  pnpm --filter @procureflow/db seed:slice14   (after seed:slice13)
 */
import { PrismaClient } from '@prisma/client';

import { newId } from '../src/ids';

const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL },
  },
});

/** The tree the scanner seed created, now given its levels. */
const KINDS: Record<string, 'WAREHOUSE' | 'RACK' | 'SECTION' | 'DOCK'> = {
  'Main Warehouse': 'WAREHOUSE',
  'Rack A': 'RACK',
  'Section A1': 'SECTION',
  'Section A2': 'SECTION',
  'Receiving Dock': 'DOCK',
};

async function main(): Promise<void> {
  const tenant = await prisma.tenant.findFirstOrThrow({
    where: { name: 'Star Cement Ltd' },
  });
  const tenantId = tenant.id;

  const storesOfficer = await prisma.user.findFirstOrThrow({
    where: { tenantId, email: 'r.kumar@star-cement.example' },
  });

  // ── label the hierarchy ──────────────────────────────────────────────────
  let labelled = 0;
  for (const [name, kind] of Object.entries(KINDS)) {
    const loc = await prisma.location.findFirst({ where: { tenantId, name } });
    if (!loc) continue;
    await prisma.location.update({ where: { id: loc.id }, data: { kind } });
    labelled += 1;
  }

  const sectionA1 = await prisma.location.findFirstOrThrow({
    where: { tenantId, name: 'Section A1' },
  });
  const sectionA2 = await prisma.location.findFirstOrThrow({
    where: { tenantId, name: 'Section A2' },
  });

  // ── boxes ────────────────────────────────────────────────────────────────
  const BOXES = [
    { code: 'BOX-000001', barcode: 'BOX-000001', locationId: sectionA1.id },
    { code: 'BOX-000002', barcode: 'BOX-000002', locationId: sectionA2.id },
  ];

  const boxIds = new Map<string, string>();
  for (const b of BOXES) {
    const existing = await prisma.box.findFirst({ where: { tenantId, code: b.code } });
    if (existing) {
      boxIds.set(b.code, existing.id);
      continue;
    }
    const id = newId('box');
    await prisma.box.create({
      data: {
        id,
        tenantId,
        code: b.code,
        barcode: b.barcode,
        locationId: b.locationId,
        createdById: storesOfficer.id,
      },
    });
    await prisma.boxMove.create({
      data: {
        id: newId('boxMove'),
        tenantId,
        boxId: id,
        fromLocationId: null,
        toLocationId: b.locationId,
        entriesPosted: 0,
        movedById: storesOfficer.id,
      },
    });
    boxIds.set(b.code, id);
  }

  // ── pack a box ───────────────────────────────────────────────────────────
  // A pack is a transfer pair at one location: out of "loose", into the box.
  // Written as ledger rows here for the same reason the service does it — box
  // contents are derived from the ledger, so seeding a contents table directly
  // is not an option (there isn't one).
  const boxOne = boxIds.get('BOX-000001') as string;
  const vase = await prisma.product.findFirst({
    where: { tenantId, name: 'Ceramic Vase — Cobalt' },
  });

  let packedRows = 0;
  if (vase) {
    const alreadyPacked = await prisma.stockLedgerEntry.findFirst({
      where: { boxId: boxOne, productId: vase.id },
    });
    if (!alreadyPacked) {
      const QTY = 20;
      const common = {
        tenantId,
        productId: vase.id,
        locationId: sectionA1.id,
        qty: QTY,
        performedById: storesOfficer.id,
        remark: 'Packed into BOX-000001',
      };
      await prisma.stockLedgerEntry.create({
        data: {
          ...common,
          id: newId('stockLedgerEntry'),
          txnType: 'TRANSFER_OUT',
          direction: -1,
          boxId: null,
        },
      });
      await prisma.stockLedgerEntry.create({
        data: {
          ...common,
          id: newId('stockLedgerEntry'),
          txnType: 'TRANSFER_IN',
          direction: 1,
          boxId: boxOne,
        },
      });
      packedRows = 2;
    }
  }

  console.log('Slice 14 box fixtures seeded:');
  console.log(`  locations labelled  ${labelled}`);
  console.log(`  boxes               ${boxIds.size}`);
  console.log(`  packing rows        ${packedRows}`);
  console.log('');
  console.log(
    '  Scan these box labels: BOX-000001 (Section A1), BOX-000002 (Section A2)',
  );
  console.log('  BOX-000001 holds 20 × Ceramic Vase — Cobalt');
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
