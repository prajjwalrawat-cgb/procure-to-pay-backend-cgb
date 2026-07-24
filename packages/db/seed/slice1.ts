/**
 * Slice 1 seed — invoice demo data for Star Cement (Master Context §11, Slice 1).
 * Idempotent: uses fixed ids and upserts. Connects on the DIRECT (owner) URL so
 * it can write across the tenant boundary; RLS still governs the runtime app.
 *
 * Adds: PR-1124, PO-0481 + GRN-0312, INV-4471 (rate variance + unauthorised
 * freight, exceptions computed by the real match engine), four more inbox
 * invoices, Patel paid history (FYTD ≈ ₹1.52 Cr), an open Patel PO for the vendor
 * submit demo, and a Tata Steel vendor user for the isolation test.
 */
import { hash } from 'argon2';
import { ROLES, runMatch, type MatchInput } from '@procureflow/shared';

import { Prisma, PrismaClient } from '@prisma/client';
import { newId } from '../src/ids';

const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL },
  },
});

const DAY = 24 * 60 * 60 * 1000;
const now = new Date();
const daysAgo = (n: number): Date => new Date(now.getTime() - n * DAY);

const IGST = '0.18';

async function main(): Promise<void> {
  const tenant = await prisma.tenant.findFirstOrThrow({
    where: { name: 'Star Cement Ltd' },
  });
  const tenantId = tenant.id;
  const harpreet = await userByEmail(tenantId, 'harpreet@star-cement.example');
  const iyer = await userByEmail(tenantId, 'm.iyer@star-cement.example');
  const banerjee = await userByEmail(tenantId, 'm.banerjee@star-cement.example');
  const kumar = await userByEmail(tenantId, 'r.kumar@star-cement.example');

  const patel = await vendorByCode(tenantId, 'V-PATEL');
  const tata = await vendorByCode(tenantId, 'V-TATA');
  const bpcl = await vendorByCode(tenantId, 'V-BPCL');
  const saura = await vendorByCode(tenantId, 'V-SAURA');
  const bhilai = await vendorByCode(tenantId, 'V-BHILAI');

  // Vendor 360 inputs for the hover card (risk A·87, 94% OTIF).
  await prisma.vendor.update({
    where: { id: patel.id },
    data: { riskScore: '87', onTimePct: '94', qualityPct: '98' },
  });

  const plant = await prisma.plant.findFirstOrThrow({ where: { tenantId } });
  const dept = await prisma.department.findFirstOrThrow({ where: { tenantId } });
  const costCenter = await prisma.costCenter.findFirstOrThrow({
    where: { tenantId, code: 'CC-0421' },
  });

  // ── PR-1124 ────────────────────────────────────────────────────────────
  await upsertById('requisition', 'pr_1124', () =>
    prisma.requisition.create({
      data: {
        id: 'pr_1124',
        tenantId,
        number: 'PR-1124',
        requesterId: harpreet.id,
        deptId: dept.id,
        costCenterId: costCenter.id,
        plantId: plant.id,
        status: 'CONVERTED',
        totalAmount: '181200',
        neededBy: daysAgo(30),
        createdAt: daysAgo(60),
      },
    }),
  );

  // ── PO-0481 (Patel, ISSUED, 3 lines) + GRN-0312 ─────────────────────────
  const poLines = [
    {
      id: 'pol_0481_1',
      lineNo: 1,
      itemDesc: 'SRB 22318',
      uom: 'EA',
      qty: '8',
      price: '18900',
    },
    {
      id: 'pol_0481_2',
      lineNo: 2,
      itemDesc: 'SNL 518',
      uom: 'EA',
      qty: '2',
      price: '10800',
    },
    {
      id: 'pol_0481_3',
      lineNo: 3,
      itemDesc: 'Grease 15kg',
      uom: 'EA',
      qty: '1',
      price: '8400',
    },
  ];
  await upsertById('purchaseOrder', 'po_0481', () =>
    prisma.purchaseOrder.create({
      data: {
        id: 'po_0481',
        tenantId,
        number: 'PO-0481',
        vendorId: patel.id,
        requisitionId: 'pr_1124',
        status: 'ISSUED',
        totalAmount: '181200',
        taxAmount: '32616',
        deliveryAddr: 'Lumshnong plant, Meghalaya',
        termsSnapshot: { allow_freight_lines: false, approved_by: banerjee.id },
        issuedAt: daysAgo(50),
        expectedAt: daysAgo(20),
        createdAt: daysAgo(55),
        lines: {
          create: poLines.map((l) => ({
            id: l.id,
            tenantId,
            lineNo: l.lineNo,
            itemDesc: l.itemDesc,
            uom: l.uom,
            qtyOrdered: l.qty,
            qtyReceived: l.qty,
            unitPrice: l.price,
            taxRate: IGST,
          })),
        },
      },
    }),
  );

  await upsertById('grn', 'grn_0312', () =>
    prisma.goodsReceiptNote.create({
      data: {
        id: 'grn_0312',
        tenantId,
        number: 'GRN-0312',
        poId: 'po_0481',
        receivedBy: kumar.id,
        receivedAt: daysAgo(42),
        qcStatus: 'PASSED',
        qcBy: kumar.id,
        qcAt: daysAgo(42),
        deliveryNoteRef: 'PES-DN-8841',
        lines: {
          create: poLines.map((l) => ({
            id: `grnl_${l.id}`,
            tenantId,
            poLineId: l.id,
            qtyAccepted: l.qty,
            qtyRejected: '0',
          })),
        },
      },
    }),
  );

  // ── INV-4471 (rate variance + unauthorised freight) ─────────────────────
  const invLines = [
    {
      id: 'invl_4471_1',
      lineNo: 1,
      poLineId: 'pol_0481_1',
      itemDesc: 'SRB 22318',
      uom: 'EA',
      qty: '8',
      price: '18900',
    },
    {
      id: 'invl_4471_2',
      lineNo: 2,
      poLineId: 'pol_0481_2',
      itemDesc: 'SNL 518',
      uom: 'EA',
      qty: '2',
      price: '11200',
    },
    {
      id: 'invl_4471_3',
      lineNo: 3,
      poLineId: 'pol_0481_3',
      itemDesc: 'Grease 15kg',
      uom: 'EA',
      qty: '1',
      price: '8400',
    },
    {
      id: 'invl_4471_4',
      lineNo: 4,
      poLineId: null,
      itemDesc: 'Freight',
      uom: 'LOT',
      qty: '1',
      price: '1800',
    },
  ];
  const invoiceDate4471 = daysAgo(41); // day 41 of a 45-day MSME clock → 4 remaining
  await upsertById('invoice', 'inv_4471', async () => {
    await prisma.invoice.create({
      data: {
        id: 'inv_4471',
        tenantId,
        number: 'INV-4471',
        vendorId: patel.id,
        poId: 'po_0481',
        vendorInvoiceRef: 'PES/2026/4471',
        invoiceDate: invoiceDate4471,
        receivedAt: daysAgo(3),
        status: 'MATCH_EXCEPTION',
        source: 'EMAIL',
        grossAmount: '216884',
        taxAmount: '33084',
        tdsAmount: '183.80',
        netAmount: '216700.20',
        gstr2bStatus: 'MATCHED',
        gstr2bMatchedAt: daysAgo(2),
        ocrConfidence: '0.97',
        irn: '2026PES4471IRN0000000001',
        ewaybillNo: '381000554471',
        msmeDueDate: new Date(invoiceDate4471.getTime() + 45 * DAY),
        assignedToId: iyer.id,
        lines: {
          create: invLines.map((l) => ({
            id: l.id,
            tenantId,
            lineNo: l.lineNo,
            poLineId: l.poLineId,
            itemDesc: l.itemDesc,
            uom: l.uom,
            qty: l.qty,
            unitPrice: l.price,
            taxRate: IGST,
            lineTotal: (Number(l.qty) * Number(l.price)).toFixed(4),
          })),
        },
      },
    });

    // Compute exceptions with the real engine, then persist them.
    const input: MatchInput = {
      tolerances: {
        priceVariancePct: '0.005',
        qtyVariancePct: '0.02',
        qtyVarianceAbs: '1',
        taxExact: true,
      },
      po: {
        allowFreightLines: false,
        lines: poLines.map((l) => ({
          id: l.id,
          lineNo: l.lineNo,
          itemDesc: l.itemDesc,
          uom: l.uom,
          qtyOrdered: l.qty,
          unitPrice: l.price,
          taxRate: IGST,
        })),
      },
      grn: {
        lines: poLines.map((l) => ({
          poLineId: l.id,
          qtyAccepted: l.qty,
          qtyRejected: '0',
        })),
      },
      invoice: {
        lines: invLines.map((l) => ({
          id: l.id,
          lineNo: l.lineNo,
          itemDesc: l.itemDesc,
          uom: l.uom,
          qty: l.qty,
          unitPrice: l.price,
          taxRate: IGST,
          poLineId: l.poLineId,
        })),
      },
    };
    const result = runMatch(input);
    for (const ex of result.exceptions) {
      await prisma.invoiceException.create({
        data: {
          id: newId('invoiceException'),
          tenantId,
          invoiceId: 'inv_4471',
          exceptionType: ex.type,
          severity: ex.severity,
          poLineId: ex.poLineId ?? null,
          invoiceLineId: ex.invoiceLineId ?? null,
          details: {
            expected: ex.expected ?? null,
            actual: ex.actual ?? null,
            variancePct: ex.variancePct ?? null,
            impactWithTax: ex.impactWithTax,
            message: ex.details,
          } as Prisma.InputJsonValue,
          raisedBy: 'system',
        },
      });
    }

    await audit(tenantId, iyer.id, 'invoice.created', 'inv_4471', {
      source: 'EMAIL',
      ref: 'PES/2026/4471',
    });
    await audit(tenantId, null, 'invoice.match_run', 'inv_4471', {
      exceptions: result.exceptions.length,
      varianceTotal: result.varianceTotal,
    });
  });

  // ── Additional inbox invoices ───────────────────────────────────────────
  await simpleInvoice(
    tenantId,
    'inv_4488',
    'INV-4488',
    tata.id,
    'TSLP/26/4488',
    daysAgo(38),
    'MATCH_EXCEPTION',
    '412000',
    iyer.id,
    {
      exceptionType: 'QTY_VARIANCE',
      message: 'Invoiced 220 MT vs received 200 MT.',
    },
  );
  await simpleInvoice(
    tenantId,
    'inv_4421',
    'INV-4421',
    tata.id,
    'TSLP/26/4421',
    daysAgo(20),
    'AWAITING_APPROVAL',
    '2680000',
    iyer.id,
  );
  await simpleInvoice(
    tenantId,
    'inv_4419',
    'INV-4419',
    bpcl.id,
    'BPCL/26/4419',
    daysAgo(18),
    'OCR_DONE',
    '540000',
    iyer.id,
  );
  await simpleInvoice(
    tenantId,
    'inv_4408',
    'INV-4408',
    saura.id,
    'SR/26/4408',
    daysAgo(40),
    'MATCH_EXCEPTION',
    '96000',
    iyer.id,
    {
      exceptionType: 'RATE_VARIANCE',
      message: 'Refractory cement rate +1.2% over PO.',
    },
  );
  await simpleInvoice(
    tenantId,
    'inv_8821',
    'INV-8821',
    bhilai.id,
    'BSS/26/8821',
    daysAgo(12),
    'APPROVED',
    '318000',
    iyer.id,
  );

  // ── Patel paid history (FYTD ≈ ₹1.52 Cr) ────────────────────────────────
  const paid: Array<[string, string, string, number]> = [
    ['inv_4302', 'INV-4302', '4200000', 90],
    ['inv_4188', 'INV-4188', '3800000', 75],
    ['inv_4021', 'INV-4021', '3600000', 60],
    ['inv_3892', 'INV-3892', '3600000', 45],
  ];
  for (const [id, number, base, ago] of paid) {
    const tax = (Number(base) * 0.18).toFixed(4);
    await simpleInvoice(
      tenantId,
      id,
      number,
      patel.id,
      `PES/HIST/${number}`,
      daysAgo(ago),
      'PAID',
      (Number(base) + Number(tax)).toFixed(4),
      null,
    );
  }

  // ── Patel open PO for the vendor-portal submit demo ─────────────────────
  await upsertById('purchaseOrder', 'po_0495', () =>
    prisma.purchaseOrder.create({
      data: {
        id: 'po_0495',
        tenantId,
        number: 'PO-0495',
        vendorId: patel.id,
        status: 'ISSUED',
        totalAmount: '96000',
        taxAmount: '17280',
        termsSnapshot: { allow_freight_lines: false },
        issuedAt: daysAgo(10),
        expectedAt: daysAgo(1),
        createdAt: daysAgo(12),
        lines: {
          create: [
            {
              id: 'pol_0495_1',
              tenantId,
              lineNo: 1,
              itemDesc: 'Coupling GT-90',
              uom: 'EA',
              qtyOrdered: '4',
              unitPrice: '18000',
              taxRate: IGST,
            },
            {
              id: 'pol_0495_2',
              tenantId,
              lineNo: 2,
              itemDesc: 'Gasket set',
              uom: 'SET',
              qtyOrdered: '6',
              unitPrice: '4000',
              taxRate: IGST,
            },
          ],
        },
      },
    }),
  );

  // ── Tata Steel vendor user (for the isolation test) ─────────────────────
  await ensureVendorUser(tenantId, tata.id, 'tata.ap@tata.example', 'Tata AP Desk');

  const invCount = await prisma.invoice.count({ where: { tenantId } });
  console.log(`Slice 1 seed complete. Invoices for Star Cement: ${invCount}`);
}

// ── helpers ────────────────────────────────────────────────────────────────

async function simpleInvoice(
  tenantId: string,
  id: string,
  number: string,
  vendorId: string,
  ref: string,
  invoiceDate: Date,
  status: string,
  gross: string,
  assignedToId: string | null,
  exception?: { exceptionType: string; message: string },
): Promise<void> {
  const vendor = await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } });
  const base = (Number(gross) / 1.18).toFixed(4);
  const tax = (Number(gross) - Number(base)).toFixed(4);
  await upsertById('invoice', id, async () => {
    await prisma.invoice.create({
      data: {
        id,
        tenantId,
        number,
        vendorId,
        vendorInvoiceRef: ref,
        invoiceDate,
        receivedAt: invoiceDate,
        status: status as Prisma.InvoiceCreateInput['status'],
        source: 'PORTAL',
        grossAmount: gross,
        taxAmount: tax,
        tdsAmount: '0',
        netAmount: gross,
        gstr2bStatus: 'MATCHED',
        assignedToId,
        msmeDueDate: vendor.isMsme ? new Date(invoiceDate.getTime() + 45 * DAY) : null,
        lines: {
          create: [
            {
              id: newId('invoiceLine'),
              tenantId,
              lineNo: 1,
              itemDesc: `${vendor.name} supply`,
              uom: 'LOT',
              qty: '1',
              unitPrice: base,
              taxRate: '0.18',
              lineTotal: base,
            },
          ],
        },
      },
    });
    if (exception) {
      await prisma.invoiceException.create({
        data: {
          id: newId('invoiceException'),
          tenantId,
          invoiceId: id,
          exceptionType:
            exception.exceptionType as Prisma.InvoiceExceptionCreateInput['exceptionType'],
          severity: 'MEDIUM',
          details: { message: exception.message } as Prisma.InputJsonValue,
          raisedBy: 'system',
        },
      });
    }
  });
}

async function ensureVendorUser(
  tenantId: string,
  vendorId: string,
  email: string,
  name: string,
): Promise<void> {
  const existing = await prisma.user.findUnique({
    where: { tenantId_email: { tenantId, email } },
  });
  const argon = await hash('Slice0!Vendor', { type: 2 });
  const user =
    existing ??
    (await prisma.user.create({
      data: { id: newId('user'), tenantId, email, name, argonHash: argon },
    }));
  const role = await prisma.role.findUniqueOrThrow({
    where: { name: ROLES.VENDOR_USER },
  });
  await prisma.userRole.deleteMany({ where: { userId: user.id } });
  await prisma.userRole.create({
    data: { id: newId('userRole'), tenantId, userId: user.id, roleId: role.id },
  });
  const contact = await prisma.vendorContact.findFirst({ where: { vendorId, email } });
  if (!contact) {
    await prisma.vendorContact.create({
      data: {
        id: newId('vendorContact'),
        tenantId,
        vendorId,
        name,
        email,
        role: 'Accounts',
        isPrimary: true,
      },
    });
  }
}

async function upsertById(
  model: 'requisition' | 'purchaseOrder' | 'grn' | 'invoice',
  id: string,
  create: () => Promise<unknown>,
): Promise<void> {
  const table = {
    requisition: prisma.requisition,
    purchaseOrder: prisma.purchaseOrder,
    grn: prisma.goodsReceiptNote,
    invoice: prisma.invoice,
  }[model];
  const found = await (
    table as { findUnique: (a: unknown) => Promise<unknown> }
  ).findUnique({
    where: { id },
  });
  if (!found) await create();
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
async function vendorByCode(tenantId: string, code: string) {
  return prisma.vendor.findUniqueOrThrow({
    where: { tenantId_code: { tenantId, code } },
  });
}

main()
  .catch((err: unknown) => {
    console.error('Slice 1 seed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
