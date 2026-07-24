/**
 * Slice 6 seed — sourcing / RFQ. Extends the mill-liner category vendors with
 * capability tags + verified banks + portal users, adds three new vendors
 * (Precision Castings verified, Guwahati Alloys MSME preliminary, Meghalaya
 * Machining preliminary), backfills historical scorecards, marks Continental
 * Belt preferred for the mill-liner item, and loads the RFQ_AWARD approval
 * matrix (≤₹5L auto · ₹5L–₹25L CFO · >₹25L CFO+MD).
 *
 * Freight matrix, import-duty lookup and RBI reference rates are shipped as
 * versioned pure data in `@procureflow/shared` (ADR-019) — no DB rows needed.
 *
 * Idempotent. Connects on the DIRECT (owner) URL so it bypasses RLS.
 */
import { hash } from 'argon2';
import { Prisma, PrismaClient } from '@prisma/client';

import { newId } from '../src/ids';

const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL },
  },
});

const VENDOR_PASSWORD = 'Slice0!Vendor';

interface NewVendorSpec {
  code: string;
  name: string;
  gstin: string;
  stateCode: string;
  isMsme: boolean;
  udyamNumber?: string;
  preliminary: boolean;
  bankVerified: boolean;
  categoryTags: string[];
  capabilityTags: string[];
  historicalOtif: string | null;
  historicalQuality: string | null;
  contactEmail: string;
  contactName: string;
}

/** The 5 mill-liner category vendors (3 existing extended + 3 new; Continental
 *  also invited). Prices/scorecards chosen so the demo award (16 Bhilai + 8
 *  Precision) lands in the ₹5L–₹25L CFO band while the RFQ estimate (₹33.6L)
 *  clears the ₹25L multi-party-open threshold. */
const NEW_VENDORS: NewVendorSpec[] = [
  {
    code: 'V-PRECIS',
    name: 'Precision Castings Ltd',
    gstin: '33AAACP2020P1Z5',
    stateCode: '33',
    isMsme: false,
    preliminary: false,
    bankVerified: true,
    categoryTags: ['spares', 'castings'],
    capabilityTags: ['casting', 'machining', 'heat_treatment'],
    historicalOtif: '96.00',
    historicalQuality: '100.00',
    contactEmail: 'sales@precision-castings.example',
    contactName: 'S. Rao',
  },
  {
    code: 'V-GUWAL',
    name: 'Guwahati Alloys',
    gstin: '18AAACG3030G1Z3',
    stateCode: '18',
    isMsme: true,
    udyamNumber: 'UDYAM-AS-01-0045678',
    preliminary: true,
    bankVerified: false,
    categoryTags: ['spares', 'castings'],
    capabilityTags: ['casting', 'heat_treatment'],
    historicalOtif: null,
    historicalQuality: null,
    contactEmail: 'bids@guwahati-alloys.example',
    contactName: 'P. Deka',
  },
  {
    code: 'V-MEGMC',
    name: 'Meghalaya Machining',
    gstin: '17AAACM4040M1Z1',
    stateCode: '17',
    isMsme: false,
    preliminary: true,
    bankVerified: false,
    categoryTags: ['spares', 'machining'],
    capabilityTags: ['machining'],
    historicalOtif: null,
    historicalQuality: null,
    contactEmail: 'info@megh-machining.example',
    contactName: 'B. Lyngdoh',
  },
];

async function main(): Promise<void> {
  const tenant = await prisma.tenant.findFirstOrThrow({
    where: { name: 'Star Cement Ltd' },
  });

  // Tenant sourcing policy knobs (defaults, made explicit for the demo).
  await prisma.tenant.update({
    where: { id: tenant.id },
    data: {
      rfqMinNoticeDays: 3,
      rfqMultiPartyOpenThreshold: new Prisma.Decimal('2500000'),
      msmePreferencePct: new Prisma.Decimal('15'),
      newVendorDefaultScore: new Prisma.Decimal('70'),
    },
  });

  const vendorRole = await prisma.role.findUniqueOrThrow({
    where: { name: 'VENDOR_USER' },
  });

  // 1. Extend existing mill-liner vendors (Bhilai, Continental) + scorecards.
  await extendExistingVendor(tenant.id, 'V-BHILAI', {
    capabilityTags: ['casting', 'heat_treatment'],
    historicalOtif: '92.00',
    historicalQuality: '94.00',
    bankVerified: true,
    contactEmail: 'sales@bhilai-spares.example',
    contactName: 'R. Verma',
    roleId: vendorRole.id,
  });
  await extendExistingVendor(tenant.id, 'V-CONTI', {
    capabilityTags: ['casting', 'conveyor'],
    historicalOtif: '88.00',
    historicalQuality: '90.00',
    bankVerified: true,
    contactEmail: 'tenders@continental-belt.example',
    contactName: 'A. Nair',
    roleId: vendorRole.id,
  });

  // 2. Three new vendors + portal users + primary contacts + banks.
  for (const spec of NEW_VENDORS) {
    await upsertNewVendor(tenant.id, spec, vendorRole.id);
  }

  // 3. Continental preferred for the mill-liner item (Bhilai already preferred).
  await ensurePreferredPricing(tenant.id, 'ML-LINER-STEP', 'V-CONTI', '23600');
  await ensurePreferredPricing(tenant.id, 'ML-LINER-STEP', 'V-PRECIS', '24500', false);

  // 4. RFQ_AWARD approval matrix (reuses the Slice 2 engine).
  await seedAwardMatrix(tenant.id);

  const millItem = await prisma.item.findFirst({
    where: { tenantId: tenant.id, skuCode: 'ML-LINER-STEP' },
  });
  const pr1131 = await prisma.requisition.findFirst({
    where: { tenantId: tenant.id, number: 'PR-1131' },
  });
  if (!millItem) throw new Error('Seed drift: ML-LINER-STEP item missing.');
  if (!pr1131) throw new Error('Seed drift: PR-1131 missing (run slice4 seed first).');

  console.log('Slice 6 seed complete:');
  console.log(`  • ${NEW_VENDORS.length} new sourcing vendors + portal users`);
  console.log('  • Bhilai + Continental extended (capability tags, banks, scorecards)');
  console.log('  • RFQ_AWARD approval matrix loaded (≤₹5L / ₹5-25L CFO / >₹25L CFO+MD)');
  console.log(
    `  • PR-1131 present (${pr1131.status}); freight/duty/RBI data in @procureflow/shared`,
  );
}

async function extendExistingVendor(
  tenantId: string,
  code: string,
  opts: {
    capabilityTags: string[];
    historicalOtif: string;
    historicalQuality: string;
    bankVerified: boolean;
    contactEmail: string;
    contactName: string;
    roleId: string;
  },
): Promise<void> {
  const vendor = await prisma.vendor.findFirst({ where: { tenantId, code } });
  if (!vendor) return;
  await prisma.vendor.update({
    where: { id: vendor.id },
    data: {
      capabilityTags: opts.capabilityTags,
      historicalOtif: new Prisma.Decimal(opts.historicalOtif),
      historicalQuality: new Prisma.Decimal(opts.historicalQuality),
      onTimePct: new Prisma.Decimal(opts.historicalOtif),
      qualityPct: new Prisma.Decimal(opts.historicalQuality),
      status: 'ACTIVE',
    },
  });
  if (opts.bankVerified) await verifyAnyBank(tenantId, vendor.id);
  await upsertVendorUserAndContact(
    tenantId,
    vendor.id,
    opts.contactEmail,
    opts.contactName,
    opts.roleId,
  );
}

async function upsertNewVendor(
  tenantId: string,
  spec: NewVendorSpec,
  roleId: string,
): Promise<void> {
  const vendor = await prisma.vendor.upsert({
    where: { tenantId_code: { tenantId, code: spec.code } },
    update: {
      name: spec.name,
      capabilityTags: spec.capabilityTags,
      categoryTags: spec.categoryTags,
      preliminaryStatus: spec.preliminary,
      isMsme: spec.isMsme,
      status: spec.preliminary ? 'PENDING_VERIFICATION' : 'ACTIVE',
      historicalOtif: spec.historicalOtif
        ? new Prisma.Decimal(spec.historicalOtif)
        : null,
      historicalQuality: spec.historicalQuality
        ? new Prisma.Decimal(spec.historicalQuality)
        : null,
    },
    create: {
      id: newId('vendor'),
      tenantId,
      code: spec.code,
      name: spec.name,
      gstin: spec.gstin,
      isMsme: spec.isMsme,
      udyamNumber: spec.udyamNumber,
      msmeCategory: spec.isMsme ? 'SMALL' : null,
      categoryTags: spec.categoryTags,
      capabilityTags: spec.capabilityTags,
      preliminaryStatus: spec.preliminary,
      status: spec.preliminary ? 'PENDING_VERIFICATION' : 'ACTIVE',
      historicalOtif: spec.historicalOtif
        ? new Prisma.Decimal(spec.historicalOtif)
        : null,
      historicalQuality: spec.historicalQuality
        ? new Prisma.Decimal(spec.historicalQuality)
        : null,
    },
  });

  const existingBank = await prisma.vendorBank.findFirst({
    where: { vendorId: vendor.id },
  });
  if (!existingBank) {
    await prisma.vendorBank.create({
      data: {
        id: newId('vendorBank'),
        tenantId,
        vendorId: vendor.id,
        bankName: 'HDFC Bank',
        accountNoEncrypted: `enc:xxxx${spec.code.slice(-4)}`,
        ifsc: 'HDFC0001234',
        holderName: spec.name,
        isVerified: spec.bankVerified,
        verifiedAt: spec.bankVerified ? new Date() : null,
      },
    });
  }

  await upsertVendorUserAndContact(
    tenantId,
    vendor.id,
    spec.contactEmail,
    spec.contactName,
    roleId,
  );
}

async function verifyAnyBank(tenantId: string, vendorId: string): Promise<void> {
  const bank = await prisma.vendorBank.findFirst({ where: { vendorId } });
  if (bank) {
    await prisma.vendorBank.update({
      where: { id: bank.id },
      data: { isVerified: true, verifiedAt: new Date() },
    });
  } else {
    await prisma.vendorBank.create({
      data: {
        id: newId('vendorBank'),
        tenantId,
        vendorId,
        bankName: 'HDFC Bank',
        accountNoEncrypted: 'enc:xxxx0000',
        ifsc: 'HDFC0001234',
        holderName: 'Vendor',
        isVerified: true,
        verifiedAt: new Date(),
      },
    });
  }
}

async function upsertVendorUserAndContact(
  tenantId: string,
  vendorId: string,
  email: string,
  name: string,
  roleId: string,
): Promise<void> {
  const argonHash = await hash(VENDOR_PASSWORD, { type: 2 });
  const user = await prisma.user.upsert({
    where: { tenantId_email: { tenantId, email } },
    update: { name, isActive: true },
    create: { id: newId('user'), tenantId, email, name, argonHash, isActive: true },
  });
  const hasRole = await prisma.userRole.findFirst({ where: { userId: user.id, roleId } });
  if (!hasRole) {
    await prisma.userRole.create({
      data: { id: newId('userRole'), tenantId, userId: user.id, roleId },
    });
  }
  const contact = await prisma.vendorContact.findFirst({
    where: { vendorId, email },
  });
  if (!contact) {
    await prisma.vendorContact.create({
      data: {
        id: newId('vendorContact'),
        tenantId,
        vendorId,
        name,
        role: 'Sales',
        email,
        isPrimary: true,
      },
    });
  }
}

async function ensurePreferredPricing(
  tenantId: string,
  sku: string,
  vendorCode: string,
  price: string,
  preferred = true,
): Promise<void> {
  const item = await prisma.item.findFirst({ where: { tenantId, skuCode: sku } });
  const vendor = await prisma.vendor.findFirst({ where: { tenantId, code: vendorCode } });
  if (!item || !vendor) return;
  const existing = await prisma.itemVendorPricing.findFirst({
    where: { itemId: item.id, vendorId: vendor.id },
  });
  if (existing) {
    await prisma.itemVendorPricing.update({
      where: { id: existing.id },
      data: { isPreferred: preferred },
    });
    return;
  }
  await prisma.itemVendorPricing.create({
    data: {
      id: newId('itemVendorPricing'),
      tenantId,
      itemId: item.id,
      vendorId: vendor.id,
      unitPrice: new Prisma.Decimal(price),
      uom: item.primaryUom,
      currency: 'INR',
      validFrom: new Date('2026-04-01T00:00:00.000Z'),
      isPreferred: preferred,
    },
  });
}

async function seedAwardMatrix(tenantId: string): Promise<void> {
  const step = (stepNo: number, name: string, role: string, sla = 48): unknown => ({
    step_no: stepNo,
    name,
    role,
    scope: 'tenant',
    sla_hours: sla,
  });
  const matrices = [
    {
      name: 'Award — up to ₹5L (auto)',
      priority: 1,
      conditions: { all: [{ field: 'total_amount', op: 'lte', value: '500000' }] },
      steps: [] as unknown[],
    },
    {
      name: 'Award — ₹5L to ₹25L',
      priority: 2,
      conditions: {
        all: [
          { field: 'total_amount', op: 'gt', value: '500000' },
          { field: 'total_amount', op: 'lte', value: '2500000' },
        ],
      },
      steps: [step(1, 'Finance Head', 'FINANCE_HEAD')],
    },
    {
      name: 'Award — above ₹25L',
      priority: 3,
      conditions: { all: [{ field: 'total_amount', op: 'gt', value: '2500000' }] },
      steps: [
        step(1, 'Finance Head', 'FINANCE_HEAD'),
        step(2, 'Managing Director', 'MD', 72),
      ],
    },
  ];
  for (const m of matrices) {
    const existing = await prisma.approvalMatrix.findFirst({
      where: { tenantId, name: m.name, documentType: 'RFQ_AWARD' },
    });
    if (existing) continue;
    await prisma.approvalMatrix.create({
      data: {
        id: newId('approvalMatrix'),
        tenantId,
        documentType: 'RFQ_AWARD',
        name: m.name,
        priority: m.priority,
        isActive: true,
        conditions: m.conditions as unknown as Prisma.InputJsonValue,
        steps: m.steps as unknown as Prisma.InputJsonValue,
      },
    });
  }
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
