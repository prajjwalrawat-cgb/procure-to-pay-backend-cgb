/**
 * Slice 13 seed — fixtures for the mobile scanner.
 *
 * Creates the things a scanner needs that no other seed provides: barcoded
 * products, a labelled location tree, opening stock split across batches with
 * different expiries (so FEFO has something to order), and an open pick list.
 *
 * Idempotent. Connects on the DIRECT (owner) URL so it bypasses RLS, like every
 * other seed here.
 *
 * Run:  pnpm --filter @procureflow/db seed:slice13
 */
import { PrismaClient } from '@prisma/client';

import { newId } from '../src/ids';

const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL },
  },
});

const DAY = 24 * 60 * 60 * 1000;

/**
 * Barcodes chosen to exercise each resolve strategy:
 *   - VASE     scans exactly as stored                     → exact_barcode
 *   - CLAMP    stored 13-digit, scan the 12-digit UPC-A     → fuzzy_gtin
 *   - SEALANT  batch-tracked, so receive demands an expiry  → the 422 path
 */
const PRODUCTS = [
  {
    key: 'VASE',
    name: 'Ceramic Vase — Cobalt',
    category: 'Home Decor',
    colour: 'Blue',
    barcode: '5901234123457',
    requiresBatchTracking: false,
    reorderPoint: 20,
  },
  {
    key: 'CLAMP',
    name: 'Steel Pipe Clamp 50mm',
    category: 'Hardware',
    colour: null,
    // Stored padded to 13. Scanning the bare UPC-A "036000291452" must still
    // find it — that is the fuzzy_gtin path.
    barcode: '0036000291452',
    requiresBatchTracking: false,
    reorderPoint: 100,
  },
  {
    key: 'SEALANT',
    name: 'Epoxy Sealant 1L',
    category: 'Chemicals',
    colour: null,
    barcode: '8901030865278',
    requiresBatchTracking: true,
    reorderPoint: 40,
  },
] as const;

/**
 * A three-level tree, which the existing `Location.parentId` already supports:
 *   Main Warehouse → Rack A → Section A1 / A2, plus a receiving dock.
 * Only the leaves carry barcodes — those are what a putaway or transfer scans.
 */
const LOCATIONS = [
  { key: 'WH', name: 'Main Warehouse', rackNo: null, parent: null, barcode: null },
  { key: 'RACK_A', name: 'Rack A', rackNo: 'A', parent: 'WH', barcode: null },
  { key: 'A1', name: 'Section A1', rackNo: 'A', parent: 'RACK_A', barcode: 'BIN-A1' },
  { key: 'A2', name: 'Section A2', rackNo: 'A', parent: 'RACK_A', barcode: 'BIN-A2' },
  { key: 'DOCK', name: 'Receiving Dock', rackNo: null, parent: 'WH', barcode: 'DOCK-1' },
] as const;

async function main(): Promise<void> {
  const tenant = await prisma.tenant.findFirstOrThrow({
    where: { name: 'Star Cement Ltd' },
  });
  const tenantId = tenant.id;

  // The stores officer owns the warehouse floor; the opening-stock rows are
  // attributed to them rather than to a fictional system user.
  const storesOfficer = await prisma.user.findFirstOrThrow({
    where: { tenantId, email: 'r.kumar@star-cement.example' },
  });

  // ── locations ────────────────────────────────────────────────────────────
  const locationIds = new Map<string, string>();
  for (const loc of LOCATIONS) {
    const existing = await prisma.location.findFirst({
      where: { tenantId, name: loc.name },
    });
    const parentId = loc.parent ? (locationIds.get(loc.parent) ?? null) : null;

    if (existing) {
      // Barcodes are the new bit — backfill them onto a tree seeded earlier.
      await prisma.location.update({
        where: { id: existing.id },
        data: { barcode: loc.barcode, parentId },
      });
      locationIds.set(loc.key, existing.id);
      continue;
    }

    const created = await prisma.location.create({
      data: {
        id: newId('location'),
        tenantId,
        name: loc.name,
        rackNo: loc.rackNo,
        parentId,
        barcode: loc.barcode,
      },
    });
    locationIds.set(loc.key, created.id);
  }

  // ── products ─────────────────────────────────────────────────────────────
  const productIds = new Map<string, string>();
  let sequence = await prisma.product.count({ where: { tenantId } });

  for (const p of PRODUCTS) {
    const existing = await prisma.product.findFirst({
      where: { tenantId, name: p.name },
    });

    if (existing) {
      await prisma.product.update({
        where: { id: existing.id },
        data: { barcode: p.barcode, requiresBatchTracking: p.requiresBatchTracking },
      });
      productIds.set(p.key, existing.id);
      continue;
    }

    sequence += 1;
    const created = await prisma.product.create({
      data: {
        id: newId('product'),
        tenantId,
        code: `SC-${String(sequence).padStart(6, '0')}`,
        name: p.name,
        category: p.category,
        colour: p.colour,
        barcode: p.barcode,
        requiresBatchTracking: p.requiresBatchTracking,
        reorderPoint: p.reorderPoint,
        unit: 'pcs',
      },
    });
    productIds.set(p.key, created.id);
  }

  // ── opening stock ────────────────────────────────────────────────────────
  // ADJUSTMENT rows remarked 'opening-stock', which is exactly what the
  // product_stock_summary view counts as opening stock.
  //
  // SEALANT deliberately arrives as two batches with different expiries in the
  // same section: picking it must draw the near-expiry batch down first, and
  // that is only visible if there is more than one batch to choose between.
  const now = Date.now();
  const OPENING = [
    { product: 'VASE', location: 'A1', qty: 60, batch: null, expiry: null },
    { product: 'CLAMP', location: 'A2', qty: 250, batch: null, expiry: null },
    {
      product: 'SEALANT',
      location: 'A1',
      qty: 24,
      batch: 'SEAL-2601',
      expiry: new Date(now + 45 * DAY), // near expiry — FEFO takes this first
    },
    {
      product: 'SEALANT',
      location: 'A1',
      qty: 36,
      batch: 'SEAL-2704',
      expiry: new Date(now + 400 * DAY),
    },
  ] as const;

  let openingRows = 0;
  for (const row of OPENING) {
    const productId = productIds.get(row.product) as string;
    const locationId = locationIds.get(row.location) as string;

    // Idempotency: one opening row per product+location+batch.
    const already = await prisma.stockLedgerEntry.findFirst({
      where: { productId, locationId, batchNumber: row.batch, remark: 'opening-stock' },
    });
    if (already) continue;

    await prisma.stockLedgerEntry.create({
      data: {
        id: newId('stockLedgerEntry'),
        tenantId,
        productId,
        locationId,
        txnType: 'ADJUSTMENT',
        qty: row.qty,
        direction: 1,
        batchNumber: row.batch,
        expiryDate: row.expiry,
        performedById: storesOfficer.id,
        remark: 'opening-stock',
      },
    });
    openingRows += 1;
  }

  // ── pick list ────────────────────────────────────────────────────────────
  // Two lines so the checklist has something to show partially complete.
  const ORDER_REF = 'AMZ-1001';
  let pickList = await prisma.pickList.findFirst({ where: { tenantId, orderRef: ORDER_REF } });
  if (!pickList) {
    pickList = await prisma.pickList.create({
      data: {
        id: newId('pickList'),
        tenantId,
        orderRef: ORDER_REF,
        platform: 'Amazon',
        customerName: 'A. Buyer',
        createdById: storesOfficer.id,
        lines: {
          create: [
            {
              id: newId('pickListLine'),
              tenantId,
              productId: productIds.get('VASE') as string,
              qtyRequired: 5,
            },
            {
              id: newId('pickListLine'),
              tenantId,
              productId: productIds.get('SEALANT') as string,
              qtyRequired: 30,
            },
          ],
        },
      },
    });
  }

  // A receivable PO, if one exists, so scan-receive can be tested without the
  // non-PO override. Business rule 1 still applies to scanned receipts.
  const receivablePo = await prisma.purchaseOrder.findFirst({
    where: {
      tenantId,
      status: { in: ['APPROVED', 'ISSUED', 'ACKNOWLEDGED', 'PARTIALLY_RECEIVED'] },
    },
    select: { id: true, number: true },
  });

  console.log('Slice 13 scanner fixtures seeded:');
  console.log(`  locations   ${locationIds.size} (dock + rack + 2 sections)`);
  console.log(`  products    ${productIds.size}`);
  console.log(`  openingRows ${openingRows}`);
  console.log(`  pickList    ${ORDER_REF} (${pickList.id})`);
  console.log('');
  console.log('  Scan these:');
  for (const p of PRODUCTS) {
    console.log(
      `    ${p.barcode.padEnd(15)} ${p.name}${p.requiresBatchTracking ? '  [batch-tracked]' : ''}`,
    );
  }
  console.log(`    036000291452    → same clamp, unpadded: exercises the fuzzy GTIN match`);
  console.log('  Bin labels: DOCK-1, BIN-A1, BIN-A2');
  console.log(
    receivablePo
      ? `  Receivable PO: ${receivablePo.number} (${receivablePo.id})`
      : '  No receivable PO found — use the non-PO override with a reason.',
  );
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
