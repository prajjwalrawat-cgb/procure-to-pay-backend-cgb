/**
 * Slice 5 seed — goods receipt + stores. Extends the item master with QC
 * parameters & sampling plans, adds QC-officer and auditor users, splits PR-1141
 * into two receivable POs (Patel 8T · Bhilai 4T), and advances the two "Received"
 * kanban PRs (PR-1123, PR-1122) into fully-posted GRN state with stock movements.
 *
 * Idempotent. Connects on the DIRECT (owner) URL so it bypasses RLS. Verifies at
 * the end that INV-4471 is still MATCH_EXCEPTION (seed-drift guard).
 */
import { hash } from 'argon2';
import Decimal from 'decimal.js';
import { Prisma, PrismaClient } from '@prisma/client';

import { newId } from '../src/ids';
import { SLICE5_ITEM_QC } from './slice5-data';

const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL },
  },
});

const DAY = 24 * 60 * 60 * 1000;
const DEMO_PASSWORD = 'Slice0!Demo';

interface Ctx {
  tenantId: string;
  plantId: string;
  users: Map<string, string>;
  vendors: Map<string, string>;
}

async function main(): Promise<void> {
  const tenant = await prisma.tenant.findFirstOrThrow({
    where: { name: 'Star Cement Ltd' },
  });
  await prisma.tenant.update({
    where: { id: tenant.id },
    data: {
      overReceiptTolerancePct: new Prisma.Decimal('0.02'),
      inventoryValuationMethod: 'WEIGHTED_AVERAGE',
    },
  });
  const plant = await prisma.plant.findFirstOrThrow({ where: { tenantId: tenant.id } });
  const users = await prisma.user.findMany({ where: { tenantId: tenant.id } });
  const vendors = await prisma.vendor.findMany({ where: { tenantId: tenant.id } });

  const ctx: Ctx = {
    tenantId: tenant.id,
    plantId: plant.id,
    users: new Map(users.map((u) => [u.email, u.id])),
    vendors: new Map(vendors.map((v) => [v.code, v.id])),
  };

  await seedUsers(ctx);
  await seedItemQc(ctx);
  await seedSplitAwardPos(ctx);
  await seedHistoricalGrns(ctx);

  const inv4471 = await prisma.invoice.findFirst({
    where: { tenantId: tenant.id, number: 'INV-4471' },
    select: { status: true },
  });
  if (inv4471 && inv4471.status !== 'MATCH_EXCEPTION') {
    throw new Error(
      `SEED DRIFT: INV-4471 is ${inv4471.status}, expected MATCH_EXCEPTION. Blocker.`,
    );
  }

  console.log('Slice 5 seed complete:', {
    qcItems: await prisma.item.count({
      where: { tenantId: tenant.id, requiresQc: true },
    }),
    grns: await prisma.goodsReceiptNote.count({ where: { tenantId: tenant.id } }),
    stockMovements: await prisma.stockLedger.count({ where: { tenantId: tenant.id } }),
    splitAwardPos: await prisma.purchaseOrder.count({
      where: { tenantId: tenant.id, number: { in: ['PO-0493', 'PO-0494'] } },
    }),
    inv4471: inv4471?.status ?? 'missing',
  });
}

// ── Users (QC officer + auditor) ─────────────────────────────────────────────

async function seedUsers(ctx: Ctx): Promise<void> {
  const seeds = [
    { email: 'p.nair@star-cement.example', name: 'Priya Nair', role: 'QC_OFFICER' },
    { email: 'p.rao@star-cement.example', name: 'Priya Rao', role: 'AUDITOR' },
  ];
  for (const s of seeds) {
    const argonHash = await hash(DEMO_PASSWORD, { type: 2 });
    const existing = await prisma.user.findUnique({
      where: { tenantId_email: { tenantId: ctx.tenantId, email: s.email } },
    });
    const user = existing
      ? await prisma.user.update({
          where: { id: existing.id },
          data: { name: s.name, argonHash, isActive: true },
        })
      : await prisma.user.create({
          data: {
            id: newId('user'),
            tenantId: ctx.tenantId,
            email: s.email,
            name: s.name,
            argonHash,
            isActive: true,
          },
        });
    await prisma.userRole.deleteMany({ where: { userId: user.id } });
    const role = await prisma.role.findUniqueOrThrow({ where: { name: s.role } });
    await prisma.userRole.create({
      data: {
        id: newId('userRole'),
        tenantId: ctx.tenantId,
        userId: user.id,
        roleId: role.id,
      },
    });
    ctx.users.set(s.email, user.id);
  }
}

// ── Item master QC parameters ────────────────────────────────────────────────

async function seedItemQc(ctx: Ctx): Promise<void> {
  for (const spec of SLICE5_ITEM_QC) {
    const item = await prisma.item.findFirst({
      where: { tenantId: ctx.tenantId, skuCode: spec.sku },
    });
    if (!item) continue;
    await prisma.item.update({
      where: { id: item.id },
      data: {
        requiresQc: spec.requiresQc,
        requiresCoa: spec.requiresCoa ?? false,
        requiresBatch: spec.requiresBatch ?? false,
        requiresSerial: spec.requiresSerial ?? false,
        aqlLevel: spec.aqlLevel,
        samplingPlanRef: spec.samplingPlanRef,
        qcParameters: (spec.qcParameters ??
          Prisma.JsonNull) as unknown as Prisma.InputJsonValue,
        stockGlAccount: spec.stockGlAccount ?? '1400-INVENTORY',
      },
    });
  }
}

// ── Split-award POs from PR-1141 (Patel 8T · Bhilai 4T) ───────────────────────

async function seedSplitAwardPos(ctx: Ctx): Promise<void> {
  const pr = await prisma.requisition.findFirst({
    where: { tenantId: ctx.tenantId, number: 'PR-1141' },
    include: { lines: true },
  });
  if (!pr) return;
  const harpreet = ctx.users.get('harpreet@star-cement.example')!;

  const awards: {
    poNumber: string;
    vendorCode: string;
    sku: string;
    unitPrice: string;
  }[] = [
    { poNumber: 'PO-0493', vendorCode: 'V-PATEL', sku: 'GM-FSB-25', unitPrice: '128500' },
    {
      poNumber: 'PO-0494',
      vendorCode: 'V-BHILAI',
      sku: 'GM-FSB-40',
      unitPrice: '123500',
    },
  ];

  for (const award of awards) {
    if (
      await prisma.purchaseOrder.findFirst({
        where: { tenantId: ctx.tenantId, number: award.poNumber },
      })
    ) {
      continue;
    }
    const prLine = pr.lines.find((l) => l.skuCode === award.sku);
    const vendorId = ctx.vendors.get(award.vendorCode);
    if (!prLine || !vendorId) continue;

    const qty = new Decimal(prLine.qty.toString());
    const price = new Decimal(award.unitPrice);
    const subtotal = qty.times(price);
    const tax = subtotal.times('0.18');
    const total = subtotal.plus(tax);

    const poId = newId('purchaseOrder');
    await prisma.purchaseOrder.create({
      data: {
        id: poId,
        tenantId: ctx.tenantId,
        number: award.poNumber,
        vendorId,
        requisitionId: pr.id,
        status: 'ISSUED',
        poType: 'STANDARD',
        totalAmount: new Prisma.Decimal(total.toFixed(4)),
        taxAmount: new Prisma.Decimal(tax.toFixed(4)),
        currency: 'INR',
        deliveryTerms: 'DDP',
        paymentTermsSnapshot: {
          kind: 'NET_45',
          days: 45,
          label: 'Net 45',
        } as Prisma.InputJsonValue,
        expectedDeliveryDate: new Date(Date.now() + 7 * DAY),
        expectedAt: new Date(Date.now() + 7 * DAY),
        issuedAt: new Date(Date.now() - 2 * DAY),
        issuedBy: harpreet,
        createdBy: harpreet,
        acknowledgedAt: new Date(Date.now() - 1 * DAY),
        acknowledgedBy: harpreet,
        lines: {
          create: {
            id: newId('purchaseOrderLine'),
            tenantId: ctx.tenantId,
            lineNo: 1,
            prLineId: prLine.id,
            itemId: prLine.itemId,
            itemDesc: prLine.itemDesc,
            hsnCode: prLine.hsnCode,
            uom: prLine.uom,
            qtyOrdered: new Prisma.Decimal(qty.toFixed(4)),
            qtyReceived: new Prisma.Decimal('0'),
            unitPrice: new Prisma.Decimal(price.toFixed(4)),
            taxRate: new Prisma.Decimal('0.18'),
            lineTotal: new Prisma.Decimal(total.toFixed(4)),
          },
        },
      },
    });
    // Mark the PR line as issued (ACKNOWLEDGED POs beyond DRAFT).
    await prisma.requisitionLine.update({
      where: { id: prLine.id },
      data: { qtyIssued: new Prisma.Decimal(qty.toFixed(4)) },
    });
  }

  // PR-1141 now has 2 of 3 lines issued → PARTIALLY_ISSUED.
  await prisma.requisition.update({
    where: { id: pr.id },
    data: { status: 'PARTIALLY_ISSUED' },
  });
}

// ── Historical posted GRNs (advance the "Received" kanban cards) ──────────────

async function seedHistoricalGrns(ctx: Ctx): Promise<void> {
  const kumar = ctx.users.get('r.kumar@star-cement.example')!;
  const targets = [
    {
      poNumber: 'PO-0478',
      grnNumber: 'GRN-0310',
      gate: 'GP-2231',
      vehicle: 'ML-05-C-8841',
    },
    {
      poNumber: 'PO-0475',
      grnNumber: 'GRN-0311',
      gate: 'GP-2218',
      vehicle: 'GJ-05-AB-1180',
    },
  ];

  for (const t of targets) {
    const po = await prisma.purchaseOrder.findFirst({
      where: { tenantId: ctx.tenantId, number: t.poNumber },
      include: { lines: { include: { item: true } } },
    });
    if (!po) continue;
    if (
      await prisma.goodsReceiptNote.findFirst({
        where: { tenantId: ctx.tenantId, poId: po.id },
      })
    ) {
      continue;
    }

    const grnId = newId('grn');
    const receivedAt = new Date(Date.now() - 6 * DAY);
    await prisma.goodsReceiptNote.create({
      data: {
        id: grnId,
        tenantId: ctx.tenantId,
        number: t.grnNumber,
        poId: po.id,
        receiptType: 'FULL',
        gateEntryRef: t.gate,
        vehicleNo: t.vehicle,
        driverName: 'Contract driver',
        transporter: 'Vendor logistics',
        receivedBy: kumar,
        receivedAt,
        unloadingLocation: 'Dock-1',
        packingCondition: 'OK',
        status: 'POSTED',
        qcStatus: 'PASSED',
        qcBy: kumar,
        qcAt: receivedAt,
        postedAt: receivedAt,
        postedBy: kumar,
        createdBy: kumar,
        lines: {
          create: po.lines.map((l) => ({
            id: newId('grnLine'),
            tenantId: ctx.tenantId,
            poLineId: l.id,
            qtyReceived: l.qtyOrdered,
            qtyAccepted: l.qtyOrdered,
            qtyRejected: new Prisma.Decimal('0'),
            uomReceived: l.uom,
            uomConversionFactor: new Prisma.Decimal('1'),
            unitLandedCost: l.unitPrice,
            glStockAccount: l.item?.stockGlAccount ?? '1400-INVENTORY',
          })),
        },
      },
    });

    // Stock ledger movement per accepted line (first movement → balance = qty).
    for (const l of po.lines) {
      const qty = new Decimal(l.qtyOrdered.toString());
      const cost = new Decimal(l.unitPrice.toString());
      await prisma.stockLedger.create({
        data: {
          id: newId('stockLedger'),
          tenantId: ctx.tenantId,
          itemId: l.itemId,
          itemDesc: l.itemDesc,
          plantId: ctx.plantId,
          movementType: 'GRN_RECEIPT',
          sourceType: 'GRN',
          sourceId: grnId,
          qtyDelta: new Prisma.Decimal(qty.toFixed(4)),
          unitLandedCost: new Prisma.Decimal(cost.toFixed(4)),
          balanceQtyAfter: new Prisma.Decimal(qty.toFixed(4)),
          balanceValueAfter: new Prisma.Decimal(qty.times(cost).toFixed(4)),
          recordedBy: kumar,
          recordedAt: receivedAt,
        },
      });
    }
  }
}

main()
  .catch((err: unknown) => {
    console.error('Slice 5 seed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
