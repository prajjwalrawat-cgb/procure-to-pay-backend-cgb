/**
 * Slice 3 seed — payment-run demo data for Star Cement.
 *
 * Idempotent. Connects on the DIRECT (owner) URL. Adds:
 *   • two configured bank accounts (HDFC NEFT bulk, ICICI CINB)
 *   • a verified VendorBank for every paying vendor, plus ONE unverified bank
 *     (Continental Belt, pennyDropRef = 'STUB_FAIL') to prove the failure UX
 *   • ≥25 APPROVED invoices ready for composition, including MSME invoices at
 *     day 40+ so the suggest drawer auto-includes them and the MSME audit fires
 *   • one APPROVED invoice for the unverified-bank vendor (cannot be added)
 */
import { BANK_ACCOUNTS, VENDORS, type SeedBankAccount } from './data';

import { Prisma, PrismaClient } from '@prisma/client';
import { newId } from '../src/ids';

const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL },
  },
});

const DAY = 24 * 60 * 60 * 1000;
const UNVERIFIED_VENDOR = 'V-CONTI'; // Continental Belt — penny-drop fails.

interface InvoiceSpec {
  vendorCode: string;
  ref: string;
  gross: string;
  ageDays: number; // days since invoice date
}

/** 26 payable invoices; MSME ones aged 41 days sit at day 40+ (approaching). */
const INVOICE_SPECS: InvoiceSpec[] = [
  { vendorCode: 'V-SAURA', ref: 'INV-4408', gross: '472000', ageDays: 41 }, // MSME
  { vendorCode: 'V-PATEL', ref: 'INV-4412', gross: '531000', ageDays: 41 }, // MSME
  { vendorCode: 'V-VISHK', ref: 'INV-4415', gross: '389000', ageDays: 42 }, // MSME
  { vendorCode: 'V-SAURA', ref: 'INV-4418', gross: '655000', ageDays: 40 }, // MSME
  { vendorCode: 'V-TATA', ref: 'INV-4501', gross: '4100000', ageDays: 20 },
  { vendorCode: 'V-TATA', ref: 'INV-4502', gross: '3200000', ageDays: 12 },
  { vendorCode: 'V-BPCL', ref: 'INV-4503', gross: '2450000', ageDays: 18 },
  { vendorCode: 'V-BHILAI', ref: 'INV-4504', gross: '780000', ageDays: 22 },
  { vendorCode: 'V-HONEY', ref: 'INV-4505', gross: '640000', ageDays: 9 },
  { vendorCode: 'V-JKPAP', ref: 'INV-4506', gross: '312000', ageDays: 14 },
  { vendorCode: 'V-RAJGY', ref: 'INV-4507', gross: 'absent', ageDays: 11 },
  { vendorCode: 'V-SURAK', ref: 'INV-4508', gross: '505000', ageDays: 16 },
  { vendorCode: 'V-PATEL', ref: 'INV-4509', gross: '288000', ageDays: 7 },
  { vendorCode: 'V-VISHK', ref: 'INV-4510', gross: '410000', ageDays: 6 },
  { vendorCode: 'V-SAURA', ref: 'INV-4511', gross: '365000', ageDays: 5 },
  { vendorCode: 'V-TATA', ref: 'INV-4512', gross: '1900000', ageDays: 8 },
  { vendorCode: 'V-BPCL', ref: 'INV-4513', gross: '1350000', ageDays: 10 },
  { vendorCode: 'V-BHILAI', ref: 'INV-4514', gross: '512000', ageDays: 13 },
  { vendorCode: 'V-HONEY', ref: 'INV-4515', gross: '298000', ageDays: 15 },
  { vendorCode: 'V-JKPAP', ref: 'INV-4516', gross: '224000', ageDays: 17 },
  { vendorCode: 'V-RAJGY', ref: 'INV-4517', gross: '176000', ageDays: 19 },
  { vendorCode: 'V-SURAK', ref: 'INV-4518', gross: '448000', ageDays: 21 },
  { vendorCode: 'V-PATEL', ref: 'INV-4519', gross: '392000', ageDays: 4 },
  { vendorCode: 'V-BHILAI', ref: 'INV-4520', gross: '333000', ageDays: 3 },
  { vendorCode: 'V-BPCL', ref: 'INV-4521', gross: '820000', ageDays: 2 },
  { vendorCode: 'V-CONTI', ref: 'INV-4499', gross: '410000', ageDays: 10 }, // unverified bank
];

async function main(): Promise<void> {
  const tenant = await prisma.tenant.findFirstOrThrow({
    where: { name: 'Star Cement Ltd' },
  });
  const tenantId = tenant.id;

  await seedBankAccounts(tenantId);
  await seedVendorBanks(tenantId);
  const created = await seedInvoices(tenantId);

  const counts = {
    bankAccounts: await prisma.bankAccount.count({ where: { tenantId } }),
    verifiedVendorBanks: await prisma.vendorBank.count({
      where: { tenantId, isVerified: true },
    }),
    approvedInvoices: await prisma.invoice.count({
      where: { tenantId, status: 'APPROVED' },
    }),
    newInvoices: created,
  };
  console.log('Slice 3 seed complete:', counts);
}

async function seedBankAccounts(tenantId: string): Promise<void> {
  for (const acc of BANK_ACCOUNTS) {
    const existing = await prisma.bankAccount.findFirst({
      where: { tenantId, accountNoLast4: acc.accountNoLast4, bankName: acc.bankName },
    });
    if (existing) continue;
    await prisma.bankAccount.create({ data: bankAccountData(tenantId, acc) });
  }
}

function bankAccountData(tenantId: string, acc: SeedBankAccount) {
  return {
    id: newId('bankAccount'),
    tenantId,
    bankName: acc.bankName,
    accountNoLast4: acc.accountNoLast4,
    ifsc: acc.ifsc,
    holderName: acc.holderName,
    formatKey: acc.formatKey,
    dailyLimit: new Prisma.Decimal(acc.dailyLimit),
    uploadConfig: { tenantCode: 'STAR01' } as Prisma.InputJsonValue,
  };
}

async function seedVendorBanks(tenantId: string): Promise<void> {
  for (const v of VENDORS) {
    const vendor = await prisma.vendor.findFirst({
      where: { tenantId, code: v.code },
    });
    if (!vendor) continue;
    const existing = await prisma.vendorBank.findFirst({
      where: { tenantId, vendorId: vendor.id },
    });
    if (existing) continue;
    const isUnverified = v.code === UNVERIFIED_VENDOR;
    await prisma.vendorBank.create({
      data: {
        id: newId('vendorBank'),
        tenantId,
        vendorId: vendor.id,
        bankName: v.bank?.bankName ?? 'HDFC Bank',
        accountNoEncrypted: `5010${v.code.replace(/\W/g, '')}0000`.slice(0, 16),
        ifsc: v.bank?.ifsc ?? 'HDFC0000123',
        holderName: v.name,
        isVerified: !isUnverified,
        verifiedAt: isUnverified ? null : new Date(),
        pennyDropRef: isUnverified ? 'STUB_FAIL' : 'PD-SEED',
      },
    });
  }
}

async function seedInvoices(tenantId: string): Promise<number> {
  let created = 0;
  for (const spec of INVOICE_SPECS) {
    const vendor = await prisma.vendor.findFirst({
      where: { tenantId, code: spec.vendorCode },
    });
    if (!vendor) continue;
    const exists = await prisma.invoice.findFirst({
      where: { tenantId, number: spec.ref },
    });
    if (exists) continue;

    const gross = new Prisma.Decimal(spec.gross === 'absent' ? '260000' : spec.gross);
    const tax = new Prisma.Decimal(
      gross.mul(new Prisma.Decimal('0.152542')).toFixed(4), // 18% tax embedded in gross
    );
    const invoiceDate = new Date(Date.now() - spec.ageDays * DAY);
    const msmeDueDate = vendor.isMsme ? new Date(invoiceDate.getTime() + 45 * DAY) : null;

    await prisma.invoice.create({
      data: {
        id: newId('invoice'),
        tenantId,
        number: spec.ref,
        vendorId: vendor.id,
        vendorInvoiceRef: spec.ref,
        invoiceDate,
        status: 'APPROVED',
        source: 'MANUAL',
        grossAmount: gross,
        taxAmount: tax,
        tdsAmount: new Prisma.Decimal('0'),
        netAmount: gross,
        currency: 'INR',
        msmeDueDate,
        lines: {
          create: {
            id: newId('invoiceLine'),
            tenantId,
            lineNo: 1,
            itemDesc: `Supply against ${spec.ref}`,
            uom: 'LOT',
            qty: new Prisma.Decimal('1'),
            unitPrice: gross.sub(tax),
            taxRate: new Prisma.Decimal('0.18'),
            lineTotal: gross.sub(tax),
          },
        },
      },
    });
    created += 1;
  }
  return created;
}

main()
  .catch((err: unknown) => {
    console.error('Slice 3 seed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
