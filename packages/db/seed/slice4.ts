/**
 * Slice 4 seed — item master, budgets, PR/PO approval matrices, and the
 * requisition/PO kanban demo data for Star Cement.
 *
 * Idempotent. Connects on the DIRECT (owner) URL so it bypasses RLS. Verifies at
 * the end that INV-4471 is still MATCH_EXCEPTION (Slice 2 seed-drift guard).
 *
 * Board target (matches the v6 mockup): 4 draft · 6 awaiting · 7 sourcing ·
 * 4 PO issued · 2 received. PR-1124 (from Slice 1) already contributes 1 to the
 * PO-issued column.
 */
import {
  SLICE4_BUDGETS,
  SLICE4_ITEMS,
  SLICE4_MATRICES,
  type SeedItem,
} from './slice4-data';

import Decimal from 'decimal.js';
import { Prisma, PrismaClient } from '@prisma/client';
import { newId } from '../src/ids';

const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL },
  },
});

const DAY = 24 * 60 * 60 * 1000;
const FY_START = new Date('2026-04-01T00:00:00.000Z');
const FY_END = new Date('2027-03-31T23:59:59.000Z');

interface Ctx {
  tenantId: string;
  plantId: string;
  plantState: string;
  users: Map<string, string>; // email → id
  vendors: Map<string, string>; // code → id
  costCenters: Map<string, { id: string; deptId: string | null }>;
  items: Map<string, { id: string; hsn: string; gst: string; uom: string; name: string }>;
}

function lineMath(
  qty: string,
  price: string,
  rate: string,
): { subtotal: Decimal; tax: Decimal; total: Decimal } {
  const subtotal = new Decimal(qty).times(price);
  const tax = subtotal.times(rate);
  return { subtotal, tax, total: subtotal.plus(tax) };
}

async function main(): Promise<void> {
  const tenant = await prisma.tenant.findFirstOrThrow({
    where: { name: 'Star Cement Ltd' },
  });
  await prisma.tenant.update({
    where: { id: tenant.id },
    data: { spotBuyCeiling: new Prisma.Decimal('50000'), enforceItemMaster: false },
  });

  const plant = await prisma.plant.findFirstOrThrow({ where: { tenantId: tenant.id } });
  const users = await prisma.user.findMany({ where: { tenantId: tenant.id } });
  const vendors = await prisma.vendor.findMany({ where: { tenantId: tenant.id } });
  const costCenters = await prisma.costCenter.findMany({
    where: { tenantId: tenant.id },
  });

  const ctx: Ctx = {
    tenantId: tenant.id,
    plantId: plant.id,
    plantState: plant.stateCode,
    users: new Map(users.map((u) => [u.email, u.id])),
    vendors: new Map(vendors.map((v) => [v.code, v.id])),
    costCenters: new Map(
      costCenters.map((c) => [c.code, { id: c.id, deptId: c.deptId }]),
    ),
    items: new Map(),
  };

  await verifyVendorBanks(ctx);
  await seedItems(ctx);
  await seedBudgets(ctx);
  await seedMatrices(ctx);
  await seedRequisitions(ctx);
  await remediateInv4471(ctx);

  const inv4471 = await prisma.invoice.findFirst({
    where: { tenantId: tenant.id, number: 'INV-4471' },
    select: { status: true },
  });
  if (inv4471 && inv4471.status !== 'MATCH_EXCEPTION') {
    throw new Error(
      `SEED DRIFT: INV-4471 is ${inv4471.status}, expected MATCH_EXCEPTION. Blocker.`,
    );
  }

  console.log('Slice 4 seed complete:', {
    items: await prisma.item.count({ where: { tenantId: tenant.id } }),
    budgets: await prisma.budget.count({ where: { tenantId: tenant.id } }),
    matrices: await prisma.approvalMatrix.count({
      where: {
        tenantId: tenant.id,
        documentType: { in: ['REQUISITION', 'PURCHASE_ORDER'] },
      },
    }),
    requisitions: await prisma.requisition.count({ where: { tenantId: tenant.id } }),
    inv4471: inv4471?.status ?? 'missing',
  });
}

/**
 * Slice 2 seed-drift remediation (Slice 4 audit amber). An invoice with an
 * unresolved 3-way match exception must NOT sit in an approval queue: the Slice 2
 * seed erroneously routed INV-4471. Reset it to MATCH_EXCEPTION and drop its
 * stray approvals so the invoice inbox and PR/PO demos start from a clean state.
 */
async function remediateInv4471(ctx: Ctx): Promise<void> {
  const inv = await prisma.invoice.findFirst({
    where: { tenantId: ctx.tenantId, number: 'INV-4471' },
    select: { id: true, status: true },
  });
  if (!inv) return;
  const openExceptions = await prisma.invoiceException.count({
    where: { invoiceId: inv.id, resolvedAt: null },
  });
  if (inv.status === 'MATCH_EXCEPTION' && openExceptions > 0) return;

  await prisma.approval.deleteMany({
    where: { documentType: 'INVOICE', documentId: inv.id },
  });
  // Reopen the exceptions the Slice 2 seed resolved so the invoice is a genuine
  // unresolved match-exception (its true Slice 1 state), not an empty shell.
  await prisma.invoiceException.updateMany({
    where: { invoiceId: inv.id },
    data: {
      resolvedAt: null,
      resolvedBy: null,
      resolutionAction: null,
      resolutionNotes: null,
    },
  });
  await prisma.invoice.update({
    where: { id: inv.id },
    data: { status: 'MATCH_EXCEPTION', approvalMatrixSnapshot: Prisma.DbNull },
  });
  console.log(
    '  remediated INV-4471 → MATCH_EXCEPTION + reopened exceptions (Slice 2 drift fix)',
  );
}

/**
 * Ensure every active vendor's bank is verified so it can be selected on a PO
 * (Slice 4 reuses the Slice 3 vendor-bank pattern). The base seed created Patel
 * Engineering's bank unverified and Slice 3 skipped it; Slice 4 needs Patel — the
 * hero MSME vendor for the split-award demo — eligible. Continental Belt stays
 * unverified on purpose (its penny-drop fails, proving the failure UX).
 */
async function verifyVendorBanks(ctx: Ctx): Promise<void> {
  await prisma.vendorBank.updateMany({
    where: {
      tenantId: ctx.tenantId,
      isVerified: false,
      // NULL pennyDropRef must be included — `<> 'STUB_FAIL'` is unknown for NULL.
      OR: [{ pennyDropRef: null }, { pennyDropRef: { not: 'STUB_FAIL' } }],
    },
    data: { isVerified: true, verifiedAt: new Date(), pennyDropRef: 'PD-SLICE4' },
  });
}

// ── Items ────────────────────────────────────────────────────────────────────

async function seedItems(ctx: Ctx): Promise<void> {
  for (const spec of SLICE4_ITEMS) {
    let item = await prisma.item.findFirst({
      where: { tenantId: ctx.tenantId, skuCode: spec.sku },
    });
    if (!item) {
      item = await prisma.item.create({
        data: {
          id: newId('item'),
          tenantId: ctx.tenantId,
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
              tenantId: ctx.tenantId,
              fromUom: c.from,
              toUom: c.to,
              factor: new Prisma.Decimal(c.factor),
            })),
          },
        },
      });
      await seedPricing(ctx, item.id, spec);
    }
    ctx.items.set(spec.sku, {
      id: item.id,
      hsn: item.hsnCode,
      gst: item.gstRate.toString(),
      uom: item.primaryUom,
      name: item.name,
    });
  }
}

async function seedPricing(ctx: Ctx, itemId: string, spec: SeedItem): Promise<void> {
  for (const v of spec.vendors) {
    const vendorId = ctx.vendors.get(v.code);
    if (!vendorId) continue;
    await prisma.itemVendorPricing.create({
      data: {
        id: newId('itemVendorPricing'),
        tenantId: ctx.tenantId,
        itemId,
        vendorId,
        unitPrice: new Prisma.Decimal(v.price),
        uom: spec.uom,
        currency: 'INR',
        validFrom: FY_START,
        isPreferred: v.preferred ?? false,
      },
    });
  }
}

// ── Budgets ──────────────────────────────────────────────────────────────────

async function seedBudgets(ctx: Ctx): Promise<void> {
  for (const b of SLICE4_BUDGETS) {
    const cc = ctx.costCenters.get(b.ccCode);
    if (!cc) continue;
    const existing = await prisma.budget.findFirst({
      where: { tenantId: ctx.tenantId, costCenterId: cc.id, isActive: true },
    });
    if (existing) continue;
    const budget = await prisma.budget.create({
      data: {
        id: newId('budget'),
        tenantId: ctx.tenantId,
        costCenterId: cc.id,
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
    // Historical commitment (represents prior POs) so "remaining" is believable.
    await prisma.budgetCommitment.create({
      data: {
        id: newId('budgetCommitment'),
        tenantId: ctx.tenantId,
        budgetId: budget.id,
        costCenterId: cc.id,
        sourceType: 'PO',
        sourceId: `historical-${b.ccCode}`,
        amount: new Prisma.Decimal(b.committed),
        status: 'COMMITTED',
        committedBy: ctx.users.get('harpreet@star-cement.example') ?? 'system',
      },
    });
  }
}

// ── Matrices ─────────────────────────────────────────────────────────────────

async function seedMatrices(ctx: Ctx): Promise<void> {
  for (const m of SLICE4_MATRICES) {
    const existing = await prisma.approvalMatrix.findFirst({
      where: { tenantId: ctx.tenantId, name: m.name, documentType: m.documentType },
    });
    if (existing) continue;
    await prisma.approvalMatrix.create({
      data: {
        id: newId('approvalMatrix'),
        tenantId: ctx.tenantId,
        documentType: m.documentType,
        name: m.name,
        priority: m.priority,
        isActive: true,
        conditions: m.conditions as unknown as Prisma.InputJsonValue,
        steps: m.steps as unknown as Prisma.InputJsonValue,
        updatedBy: ctx.users.get('harpreet@star-cement.example') ?? null,
      },
    });
  }
}

// ── Requisitions + POs (kanban demo) ─────────────────────────────────────────

interface PrLineSpec {
  sku: string;
  qty: string;
}
interface PrSpec {
  number: string;
  title: string;
  ccCode: string;
  status:
    | 'DRAFT'
    | 'AWAITING_APPROVAL'
    | 'APPROVED'
    | 'FULLY_ISSUED_ISSUED'
    | 'FULLY_ISSUED_RECEIVED';
  lines: PrLineSpec[];
  po?: { number: string; vendorCode: string };
}

const PR_SPECS: PrSpec[] = [
  // Draft (4) — PR-1141 is the demo hero (3 lines, ~₹18.2L).
  {
    number: 'PR-1141',
    title: 'Grinding media replenishment — Mill #3',
    ccCode: 'CC-0421',
    status: 'DRAFT',
    lines: [
      { sku: 'GM-FSB-25', qty: '8' },
      { sku: 'GM-FSB-40', qty: '4' },
      { sku: 'FT-LINER-BOLT', qty: '2' },
    ],
  },
  {
    number: 'PR-1140',
    title: 'Kiln #1 refractory bricks',
    ccCode: 'CC-0311',
    status: 'DRAFT',
    lines: [{ sku: 'RB-MAG-C', qty: '600' }],
  },
  {
    number: 'PR-1139',
    title: 'Meghalaya steam coal — Q2',
    ccCode: 'CC-0201',
    status: 'DRAFT',
    lines: [{ sku: 'CO-STEAM-A', qty: '3400' }],
  },
  {
    number: 'PR-1138',
    title: 'Conveyor belt lining CB-04',
    ccCode: 'CC-0421',
    status: 'DRAFT',
    lines: [{ sku: 'CB-LINING-10', qty: '100' }],
  },
  // Awaiting approval (6)
  {
    number: 'PR-1137',
    title: 'Kiln burner nozzles',
    ccCode: 'CC-0311',
    status: 'AWAITING_APPROVAL',
    lines: [{ sku: 'KB-NOZZLE-M', qty: '3' }],
  },
  {
    number: 'PR-1136',
    title: 'HDPE cement bags — packing line',
    ccCode: 'CC-0512',
    status: 'AWAITING_APPROVAL',
    lines: [{ sku: 'PK-BAG-50HDPE', qty: '120000' }],
  },
  {
    number: 'PR-1135',
    title: 'Silo bearing replacement',
    ccCode: 'CC-0421',
    status: 'AWAITING_APPROVAL',
    lines: [{ sku: 'BR-SILO-2220', qty: '12' }],
  },
  {
    number: 'PR-1134',
    title: 'Safety PPE quarterly stock',
    ccCode: 'CC-0512',
    status: 'AWAITING_APPROVAL',
    lines: [{ sku: 'PP-HELMET', qty: '300' }],
  },
  {
    number: 'PR-1133',
    title: 'Lab reagents restock',
    ccCode: 'CC-0102',
    status: 'AWAITING_APPROVAL',
    lines: [{ sku: 'LR-EDTA-500', qty: '40' }],
  },
  {
    number: 'PR-1132',
    title: 'Wheel loader tyres',
    ccCode: 'CC-0201',
    status: 'AWAITING_APPROVAL',
    lines: [{ sku: 'TY-LOADER-1750', qty: '6' }],
  },
  // Sourcing (7 approved)
  {
    number: 'PR-1131',
    title: 'Cement mill liners',
    ccCode: 'CC-0421',
    status: 'APPROVED',
    lines: [{ sku: 'ML-LINER-STEP', qty: '40' }],
  },
  {
    number: 'PR-1130',
    title: 'Cross-belt conveyor motors',
    ccCode: 'CC-0421',
    status: 'APPROVED',
    lines: [{ sku: 'MO-CBM-90KW', qty: '2' }],
  },
  {
    number: 'PR-1129',
    title: 'Cement grinding additives',
    ccCode: 'CC-0102',
    status: 'APPROVED',
    lines: [{ sku: 'CH-GRIND-AID', qty: '18' }],
  },
  {
    number: 'PR-1128',
    title: 'Clinker de-dusting oil',
    ccCode: 'CC-0201',
    status: 'APPROVED',
    lines: [{ sku: 'CH-DEDUST-OIL', qty: '8000' }],
  },
  {
    number: 'PR-1121',
    title: 'Hydraulic oil bulk',
    ccCode: 'CC-0421',
    status: 'APPROVED',
    lines: [{ sku: 'MRO-HYD-OIL', qty: '20' }],
  },
  {
    number: 'PR-1120',
    title: 'Natural gypsum Q2',
    ccCode: 'CC-0102',
    status: 'APPROVED',
    lines: [{ sku: 'RM-GYPSUM-NAT', qty: '1200' }],
  },
  {
    number: 'PR-1119',
    title: 'Kiln thermocouples',
    ccCode: 'CC-0311',
    status: 'APPROVED',
    lines: [{ sku: 'KB-TC-K-1200', qty: '10' }],
  },
  // PO issued (3 new + PR-1124 from Slice 1 = 4)
  {
    number: 'PR-1127',
    title: 'Honeywell kiln thermocouples',
    ccCode: 'CC-0311',
    status: 'FULLY_ISSUED_ISSUED',
    lines: [{ sku: 'KB-TC-K-1200', qty: '8' }],
    po: { number: 'PO-0492', vendorCode: 'V-HONEY' },
  },
  {
    number: 'PR-1126',
    title: 'JK Paper kraft reels',
    ccCode: 'CC-0512',
    status: 'FULLY_ISSUED_ISSUED',
    lines: [{ sku: 'PK-KRAFT-REEL', qty: '5' }],
    po: { number: 'PO-0491', vendorCode: 'V-JKPAP' },
  },
  {
    number: 'PR-1125',
    title: 'Rajasthan gypsum',
    ccCode: 'CC-0102',
    status: 'FULLY_ISSUED_ISSUED',
    lines: [{ sku: 'RM-GYPSUM-NAT', qty: '900' }],
    po: { number: 'PO-0483', vendorCode: 'V-RAJGY' },
  },
  // Received (2) — ready for Slice 5 to build GRNs against.
  {
    number: 'PR-1123',
    title: 'EP2 grease drums',
    ccCode: 'CC-0421',
    status: 'FULLY_ISSUED_RECEIVED',
    lines: [{ sku: 'MRO-GREASE-15', qty: '24' }],
    po: { number: 'PO-0478', vendorCode: 'V-BPCL' },
  },
  {
    number: 'PR-1122',
    title: 'Welding electrodes',
    ccCode: 'CC-0421',
    status: 'FULLY_ISSUED_RECEIVED',
    lines: [{ sku: 'FT-WELD-ROD', qty: '400' }],
    po: { number: 'PO-0475', vendorCode: 'V-PATEL' },
  },
];

async function seedRequisitions(ctx: Ctx): Promise<void> {
  const harpreet = ctx.users.get('harpreet@star-cement.example')!;
  const banerjee = ctx.users.get('m.banerjee@star-cement.example')!;
  const prMatrix = await prisma.approvalMatrix.findFirst({
    where: {
      tenantId: ctx.tenantId,
      documentType: 'REQUISITION',
      name: 'PR — ₹5L to ₹25L',
    },
  });

  for (const spec of PR_SPECS) {
    if (
      await prisma.requisition.findFirst({
        where: { tenantId: ctx.tenantId, number: spec.number },
      })
    ) {
      continue;
    }
    const cc = ctx.costCenters.get(spec.ccCode);
    if (!cc) continue;

    // Build lines from the item master (snapshot sku/hsn/gst).
    let prSubtotal = new Decimal(0);
    let prTax = new Decimal(0);
    const lineData = spec.lines.map((l, idx) => {
      const item = ctx.items.get(l.sku)!;
      const priceRow = SLICE4_ITEMS.find((s) => s.sku === l.sku)!.vendors[0]!;
      const { subtotal, tax, total } = lineMath(l.qty, priceRow.price, item.gst);
      prSubtotal = prSubtotal.plus(subtotal);
      prTax = prTax.plus(tax);
      return {
        id: newId('requisitionLine'),
        tenantId: ctx.tenantId,
        lineNo: idx + 1,
        itemId: item.id,
        skuCode: l.sku,
        itemDesc: item.name,
        hsnCode: item.hsn,
        uom: item.uom,
        qty: new Prisma.Decimal(l.qty),
        unitPrice: new Prisma.Decimal(priceRow.price),
        taxRate: new Prisma.Decimal(item.gst),
        lineTotal: new Prisma.Decimal(total.toFixed(4)),
        taxAmount: new Prisma.Decimal(tax.toFixed(4)),
        category: SLICE4_ITEMS.find((s) => s.sku === l.sku)!.category,
      };
    });
    const prTotal = prSubtotal.plus(prTax);

    const isIssued = spec.status.startsWith('FULLY_ISSUED');
    const prStatus = isIssued ? 'FULLY_ISSUED' : spec.status;
    const isAwaiting = spec.status === 'AWAITING_APPROVAL';

    const prId = newId('requisition');
    await prisma.requisition.create({
      data: {
        id: prId,
        tenantId: ctx.tenantId,
        number: spec.number,
        title: spec.title,
        businessJustification: `${spec.title} — scheduled replenishment for continuous operations.`,
        requesterId: harpreet,
        deptId: cc.deptId ?? ctx.plantId,
        costCenterId: cc.id,
        plantId: ctx.plantId,
        deliveryLocation: 'Lumshnong plant, Meghalaya',
        priority: 'STANDARD',
        status: prStatus as Prisma.RequisitionCreateInput['status'],
        totalAmount: new Prisma.Decimal(prTotal.toFixed(4)),
        taxAmount: new Prisma.Decimal(prTax.toFixed(4)),
        currency: 'INR',
        neededBy: new Date(Date.now() + 30 * DAY),
        lines: {
          createMany: {
            data: lineData.map((l) => (isIssued ? { ...l, qtyIssued: l.qty } : l)),
          },
        },
      },
    });

    // Note: the seeded APPROVED/ISSUED PRs are board illustration only; their
    // spend is already represented by each cost center's baseline historical
    // commitment (SLICE4_BUDGETS.committed), so they do NOT commit again here —
    // that would double-count and skew the live "remaining" figures the demo
    // relies on. The live demo PR commits budget for real on approval.

    // Awaiting PRs get a pending Plant-Head approval so they show in the inbox.
    if (isAwaiting && prMatrix) {
      await prisma.requisition.update({
        where: { id: prId },
        data: {
          approvalMatrixSnapshot: {
            matrixId: prMatrix.id,
            name: prMatrix.name,
            version: prMatrix.version,
            steps: prMatrix.steps,
          } as unknown as Prisma.InputJsonValue,
        },
      });
      await prisma.approval.create({
        data: {
          id: newId('approval'),
          tenantId: ctx.tenantId,
          documentType: 'REQUISITION',
          documentId: prId,
          stepNo: 1,
          stepName: 'Plant Head',
          scope: 'tenant',
          approverId: banerjee,
          decision: 'PENDING',
          slaHours: 24,
          slaDueAt: new Date(Date.now() + DAY),
          matrixSnapshotId: prMatrix.id,
        },
      });
    }

    // Issued / received PRs get a PO.
    if (spec.po) {
      await seedPo(ctx, prId, spec, lineData, prTotal, prTax, harpreet);
    }
  }
}

async function seedPo(
  ctx: Ctx,
  prId: string,
  spec: PrSpec,
  lineData: {
    id: string;
    lineNo: number;
    itemId: string;
    itemDesc: string;
    hsnCode: string;
    uom: string;
    qty: Prisma.Decimal;
    unitPrice: Prisma.Decimal;
    taxRate: Prisma.Decimal;
    lineTotal: Prisma.Decimal;
  }[],
  prTotal: Decimal,
  prTax: Decimal,
  actorId: string,
): Promise<void> {
  const po = spec.po!;
  if (
    await prisma.purchaseOrder.findFirst({
      where: { tenantId: ctx.tenantId, number: po.number },
    })
  ) {
    return;
  }
  const vendorId = ctx.vendors.get(po.vendorCode);
  if (!vendorId) return;
  const received = spec.status === 'FULLY_ISSUED_RECEIVED';
  const poStatus = received ? 'RECEIVED' : 'ISSUED';

  const poId = newId('purchaseOrder');
  await prisma.purchaseOrder.create({
    data: {
      id: poId,
      tenantId: ctx.tenantId,
      number: po.number,
      vendorId,
      requisitionId: prId,
      status: poStatus,
      poType: 'STANDARD',
      totalAmount: new Prisma.Decimal(prTotal.toFixed(4)),
      taxAmount: new Prisma.Decimal(prTax.toFixed(4)),
      currency: 'INR',
      deliveryTerms: 'DDP',
      paymentTermsSnapshot: {
        kind: 'NET_45',
        days: 45,
        label: 'Net 45',
      } as Prisma.InputJsonValue,
      expectedDeliveryDate: new Date(Date.now() + 20 * DAY),
      expectedAt: new Date(Date.now() + 20 * DAY),
      issuedAt: new Date(Date.now() - 5 * DAY),
      issuedBy: actorId,
      createdBy: actorId,
      lines: {
        createMany: {
          data: lineData.map((l) => ({
            id: newId('purchaseOrderLine'),
            tenantId: ctx.tenantId,
            lineNo: l.lineNo,
            prLineId: l.id,
            itemId: l.itemId,
            itemDesc: l.itemDesc,
            hsnCode: l.hsnCode,
            uom: l.uom,
            qtyOrdered: l.qty,
            qtyReceived: received ? l.qty : new Prisma.Decimal('0'),
            unitPrice: l.unitPrice,
            taxRate: l.taxRate,
            lineTotal: l.lineTotal,
          })),
        },
      },
    },
  });
}

main()
  .catch((err: unknown) => {
    console.error('Slice 4 seed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
