/**
 * Slice 4 static seed data — item master, budgets, and approval matrices.
 * Kept separate from the imperative seed so the catalogue is easy to audit.
 * GST rates: 18% for most industrial goods, 5% for coal/gypsum, 28% for tyres
 * and certain chemicals (Master Context §9 — these are audited, get them right).
 */
import type { ApprovalStep, Condition } from '@procureflow/shared';
import { ROLES } from '@procureflow/shared';

export interface SeedItem {
  sku: string;
  name: string;
  category: string;
  subcategory?: string;
  hsn: string;
  gst: string; // fraction, e.g. "0.18"
  uom: string;
  isCapex?: boolean;
  /** tonne/bag → kg conversions where the item is bought that way. */
  conversions?: { from: string; to: string; factor: string }[];
  /** Vendor codes that quote this item, cheapest listed first. */
  vendors: { code: string; price: string; preferred?: boolean }[];
}

const T_KG = { from: 'tonne', to: 'kg', factor: '1000' };
const BAG_KG = { from: 'bag', to: 'kg', factor: '50' };

export const SLICE4_ITEMS: SeedItem[] = [
  // ── Grinding media ──
  {
    sku: 'GM-FSB-25',
    name: 'Forged steel grinding balls 25mm',
    category: 'Grinding media',
    hsn: '7325',
    gst: '0.18',
    uom: 'tonne',
    conversions: [T_KG],
    vendors: [
      { code: 'V-PATEL', price: '128500', preferred: true },
      { code: 'V-BHILAI', price: '131000' },
      { code: 'V-TATA', price: '129900' },
    ],
  },
  {
    sku: 'GM-FSB-40',
    name: 'Forged steel grinding balls 40mm',
    category: 'Grinding media',
    hsn: '7325',
    gst: '0.18',
    uom: 'tonne',
    conversions: [T_KG],
    vendors: [
      { code: 'V-PATEL', price: '121000', preferred: true },
      { code: 'V-BHILAI', price: '123500' },
    ],
  },
  {
    sku: 'GM-CYL-22',
    name: 'Cylpebs grinding media 22mm',
    category: 'Grinding media',
    hsn: '7325',
    gst: '0.18',
    uom: 'tonne',
    conversions: [T_KG],
    vendors: [
      { code: 'V-BHILAI', price: '118000', preferred: true },
      { code: 'V-PATEL', price: '119500' },
    ],
  },
  // ── Refractory ──
  {
    sku: 'RB-HAL-70',
    name: 'High-alumina refractory brick 70%',
    category: 'Refractory',
    subcategory: 'Brick',
    hsn: '6902',
    gst: '0.18',
    uom: 'nos',
    vendors: [
      { code: 'V-SAURA', price: '480', preferred: true },
      { code: 'V-BHILAI', price: '510' },
    ],
  },
  {
    sku: 'RB-MAG-C',
    name: 'Magnesia-carbon refractory brick',
    category: 'Refractory',
    subcategory: 'Brick',
    hsn: '6902',
    gst: '0.18',
    uom: 'nos',
    vendors: [{ code: 'V-SAURA', price: '720', preferred: true }],
  },
  {
    sku: 'RC-CAST-40',
    name: 'Refractory castable LC 40kg',
    category: 'Refractory',
    subcategory: 'Castable',
    hsn: '3816',
    gst: '0.18',
    uom: 'bag',
    conversions: [BAG_KG],
    vendors: [{ code: 'V-SAURA', price: '1650', preferred: true }],
  },
  // ── Fuel / coal ──
  {
    sku: 'CO-STEAM-A',
    name: 'Steam coal grade A (Meghalaya)',
    category: 'Fuel',
    subcategory: 'Coal',
    hsn: '2701',
    gst: '0.05',
    uom: 'tonne',
    conversions: [T_KG],
    vendors: [{ code: 'V-BPCL', price: '8900', preferred: true }],
  },
  {
    sku: 'CO-PET-COKE',
    name: 'Petroleum coke fuel grade',
    category: 'Fuel',
    hsn: '2713',
    gst: '0.18',
    uom: 'tonne',
    conversions: [T_KG],
    vendors: [{ code: 'V-BPCL', price: '14200', preferred: true }],
  },
  {
    sku: 'FU-HSD-BULK',
    name: 'High-speed diesel bulk',
    category: 'Fuel',
    hsn: '2710',
    gst: '0.18',
    uom: 'litre',
    vendors: [{ code: 'V-BPCL', price: '92', preferred: true }],
  },
  // ── Conveyor ──
  {
    sku: 'CB-LINING-10',
    name: 'Conveyor belt ceramic lining 10mm',
    category: 'Conveyor',
    subcategory: 'Lining',
    hsn: '4010',
    gst: '0.18',
    uom: 'sqm',
    vendors: [
      { code: 'V-CONTI', price: '4200', preferred: true },
      { code: 'V-BHILAI', price: '4450' },
    ],
  },
  {
    sku: 'CB-BELT-1200',
    name: 'Conveyor belt EP1200 1200mm',
    category: 'Conveyor',
    subcategory: 'Belt',
    hsn: '4010',
    gst: '0.18',
    uom: 'metre',
    vendors: [{ code: 'V-CONTI', price: '3850', preferred: true }],
  },
  {
    sku: 'CB-IDLER-127',
    name: 'Carrying idler roller 127mm',
    category: 'Conveyor',
    subcategory: 'Idler',
    hsn: '8431',
    gst: '0.18',
    uom: 'nos',
    vendors: [
      { code: 'V-CONTI', price: '1250', preferred: true },
      { code: 'V-BHILAI', price: '1320' },
    ],
  },
  // ── Kiln ──
  {
    sku: 'KB-NOZZLE-M',
    name: 'Kiln burner nozzle multi-channel',
    category: 'Kiln',
    subcategory: 'Burner',
    hsn: '8416',
    gst: '0.18',
    uom: 'nos',
    isCapex: true,
    vendors: [{ code: 'V-HONEY', price: '285000', preferred: true }],
  },
  {
    sku: 'KB-TC-K-1200',
    name: 'Kiln thermocouple type-K 1200C',
    category: 'Kiln',
    subcategory: 'Instrument',
    hsn: '9025',
    gst: '0.18',
    uom: 'nos',
    vendors: [{ code: 'V-HONEY', price: '18500', preferred: true }],
  },
  {
    sku: 'KB-SEAL-GRAPH',
    name: 'Kiln inlet graphite seal segment',
    category: 'Kiln',
    hsn: '6815',
    gst: '0.18',
    uom: 'nos',
    vendors: [{ code: 'V-SAURA', price: '9600', preferred: true }],
  },
  // ── Cement mill ──
  {
    sku: 'ML-LINER-STEP',
    name: 'Cement mill step liner plate',
    category: 'Mill',
    subcategory: 'Liner',
    hsn: '8474',
    gst: '0.18',
    uom: 'nos',
    isCapex: true,
    vendors: [
      { code: 'V-BHILAI', price: '22400', preferred: true },
      { code: 'V-PATEL', price: '23100' },
    ],
  },
  {
    sku: 'ML-DIAPHRAGM',
    name: 'Mill intermediate diaphragm segment',
    category: 'Mill',
    hsn: '8474',
    gst: '0.18',
    uom: 'nos',
    vendors: [{ code: 'V-BHILAI', price: '16800', preferred: true }],
  },
  // ── Bearings / motors ──
  {
    sku: 'BR-SILO-2220',
    name: 'Silo spherical roller bearing 22220',
    category: 'Bearings',
    hsn: '8482',
    gst: '0.18',
    uom: 'nos',
    vendors: [
      { code: 'V-BHILAI', price: '14200', preferred: true },
      { code: 'V-PATEL', price: '14800' },
    ],
  },
  {
    sku: 'MO-CBM-90KW',
    name: 'Cross-belt magnet motor 90kW',
    category: 'Motors',
    hsn: '8501',
    gst: '0.18',
    uom: 'nos',
    isCapex: true,
    vendors: [{ code: 'V-HONEY', price: '365000', preferred: true }],
  },
  {
    sku: 'MO-VIB-3KW',
    name: 'Vibrating feeder motor 3kW',
    category: 'Motors',
    hsn: '8501',
    gst: '0.18',
    uom: 'nos',
    vendors: [{ code: 'V-BHILAI', price: '28500', preferred: true }],
  },
  // ── Packaging ──
  {
    sku: 'PK-BAG-50HDPE',
    name: 'HDPE cement bag 50kg printed',
    category: 'Packaging',
    subcategory: 'Bag',
    hsn: '3923',
    gst: '0.18',
    uom: 'nos',
    vendors: [
      { code: 'V-VISHK', price: '14', preferred: true },
      { code: 'V-JKPAP', price: '15' },
    ],
  },
  {
    sku: 'PK-KRAFT-REEL',
    name: 'Kraft paper reel 80gsm',
    category: 'Packaging',
    subcategory: 'Paper',
    hsn: '4804',
    gst: '0.18',
    uom: 'tonne',
    conversions: [T_KG],
    vendors: [{ code: 'V-JKPAP', price: '68000', preferred: true }],
  },
  {
    sku: 'PK-STRETCH-WRAP',
    name: 'Pallet stretch wrap film',
    category: 'Packaging',
    hsn: '3920',
    gst: '0.18',
    uom: 'roll',
    vendors: [{ code: 'V-VISHK', price: '520', preferred: true }],
  },
  // ── Safety PPE ──
  {
    sku: 'PP-HELMET',
    name: 'Safety helmet with chin strap',
    category: 'Safety',
    subcategory: 'PPE',
    hsn: '6506',
    gst: '0.18',
    uom: 'nos',
    vendors: [{ code: 'V-SURAK', price: '340', preferred: true }],
  },
  {
    sku: 'PP-DUST-MASK',
    name: 'Dust respirator mask N95',
    category: 'Safety',
    subcategory: 'PPE',
    hsn: '6307',
    gst: '0.05',
    uom: 'nos',
    vendors: [{ code: 'V-SURAK', price: '85', preferred: true }],
  },
  {
    sku: 'PP-GLOVE-HEAT',
    name: 'Heat-resistant gloves kevlar',
    category: 'Safety',
    subcategory: 'PPE',
    hsn: '6116',
    gst: '0.18',
    uom: 'pair',
    vendors: [{ code: 'V-SURAK', price: '420', preferred: true }],
  },
  {
    sku: 'PP-BOOT-STEEL',
    name: 'Steel-toe safety boots',
    category: 'Safety',
    subcategory: 'PPE',
    hsn: '6403',
    gst: '0.18',
    uom: 'pair',
    vendors: [{ code: 'V-SURAK', price: '1450', preferred: true }],
  },
  // ── Lab reagents / chemicals ──
  {
    sku: 'LR-EDTA-500',
    name: 'EDTA disodium AR 500g',
    category: 'Lab',
    subcategory: 'Reagent',
    hsn: '2922',
    gst: '0.18',
    uom: 'nos',
    vendors: [{ code: 'V-SURAK', price: '1250', preferred: true }],
  },
  {
    sku: 'LR-HCL-35',
    name: 'Hydrochloric acid 35% LR',
    category: 'Lab',
    subcategory: 'Reagent',
    hsn: '2806',
    gst: '0.18',
    uom: 'litre',
    vendors: [{ code: 'V-SURAK', price: '95', preferred: true }],
  },
  {
    sku: 'CH-GRIND-AID',
    name: 'Cement grinding aid TEA-based',
    category: 'Chemicals',
    subcategory: 'Additive',
    hsn: '3824',
    gst: '0.18',
    uom: 'tonne',
    conversions: [T_KG],
    vendors: [{ code: 'V-SURAK', price: '86000', preferred: true }],
  },
  {
    sku: 'CH-WATER-PROOF',
    name: 'Cement waterproofing compound',
    category: 'Chemicals',
    subcategory: 'Additive',
    hsn: '3824',
    gst: '0.28',
    uom: 'litre',
    vendors: [{ code: 'V-SURAK', price: '145', preferred: true }],
  },
  {
    sku: 'CH-DEDUST-OIL',
    name: 'De-dusting oil for clinker',
    category: 'Chemicals',
    hsn: '3403',
    gst: '0.18',
    uom: 'litre',
    vendors: [{ code: 'V-BPCL', price: '118', preferred: true }],
  },
  // ── Tyres ──
  {
    sku: 'TY-TRUCK-1000',
    name: 'Truck tyre 1000-20 radial',
    category: 'Vehicle',
    subcategory: 'Tyre',
    hsn: '4011',
    gst: '0.28',
    uom: 'nos',
    vendors: [{ code: 'V-BHILAI', price: '24500', preferred: true }],
  },
  {
    sku: 'TY-LOADER-1750',
    name: 'Wheel loader tyre 17.5-25',
    category: 'Vehicle',
    subcategory: 'Tyre',
    hsn: '4011',
    gst: '0.28',
    uom: 'nos',
    vendors: [{ code: 'V-BHILAI', price: '68000', preferred: true }],
  },
  // ── Gypsum / raw material ──
  {
    sku: 'RM-GYPSUM-NAT',
    name: 'Natural gypsum lumps',
    category: 'Raw material',
    subcategory: 'Gypsum',
    hsn: '2520',
    gst: '0.05',
    uom: 'tonne',
    conversions: [T_KG],
    vendors: [{ code: 'V-RAJGY', price: '3200', preferred: true }],
  },
  {
    sku: 'RM-GYPSUM-CHEM',
    name: 'Chemical gypsum (phospho)',
    category: 'Raw material',
    subcategory: 'Gypsum',
    hsn: '2520',
    gst: '0.05',
    uom: 'tonne',
    conversions: [T_KG],
    vendors: [{ code: 'V-RAJGY', price: '2650', preferred: true }],
  },
  {
    sku: 'RM-IRON-ORE',
    name: 'Iron ore fines (corrective)',
    category: 'Raw material',
    hsn: '2601',
    gst: '0.05',
    uom: 'tonne',
    conversions: [T_KG],
    vendors: [{ code: 'V-TATA', price: '5400', preferred: true }],
  },
  {
    sku: 'RM-LATERITE',
    name: 'Laterite corrective material',
    category: 'Raw material',
    hsn: '2530',
    gst: '0.05',
    uom: 'tonne',
    conversions: [T_KG],
    vendors: [{ code: 'V-RAJGY', price: '1450', preferred: true }],
  },
  // ── Fasteners / MRO ──
  {
    sku: 'FT-LINER-BOLT',
    name: 'Mill liner bolt set M36',
    category: 'Fasteners',
    hsn: '7318',
    gst: '0.18',
    uom: 'set',
    vendors: [
      { code: 'V-PATEL', price: '15000', preferred: true },
      { code: 'V-BHILAI', price: '15600' },
    ],
  },
  {
    sku: 'FT-WELD-ROD',
    name: 'Hardfacing welding electrode 4mm',
    category: 'Fasteners',
    subcategory: 'Welding',
    hsn: '8311',
    gst: '0.18',
    uom: 'kg',
    vendors: [{ code: 'V-PATEL', price: '380', preferred: true }],
  },
  {
    sku: 'MRO-GREASE-15',
    name: 'EP2 lithium grease 15kg',
    category: 'MRO',
    hsn: '2710',
    gst: '0.18',
    uom: 'nos',
    vendors: [
      { code: 'V-BPCL', price: '8400', preferred: true },
      { code: 'V-PATEL', price: '8700' },
    ],
  },
  {
    sku: 'MRO-HYD-OIL',
    name: 'Hydraulic oil ISO VG 68 210L',
    category: 'MRO',
    hsn: '2710',
    gst: '0.18',
    uom: 'nos',
    vendors: [{ code: 'V-BPCL', price: '19800', preferred: true }],
  },
];

// ── Approval matrices (Slice 4) ─────────────────────────────────────────────

export interface SeedSlice4Matrix {
  documentType: 'REQUISITION' | 'PURCHASE_ORDER';
  name: string;
  priority: number;
  conditions: Condition;
  steps: ApprovalStep[];
}

const step = (
  stepNo: number,
  name: string,
  role: ApprovalStep['role'],
  slaHours = 24,
): ApprovalStep => ({
  step_no: stepNo,
  name,
  role,
  scope: 'tenant',
  sla_hours: slaHours,
});

export const SLICE4_MATRICES: SeedSlice4Matrix[] = [
  // Requisitions
  {
    documentType: 'REQUISITION',
    name: 'PR — up to ₹5L',
    priority: 1,
    conditions: { all: [{ field: 'total_amount', op: 'lte', value: '500000' }] },
    steps: [step(1, 'Plant Head', ROLES.PLANT_HEAD)],
  },
  {
    documentType: 'REQUISITION',
    name: 'PR — ₹5L to ₹25L',
    priority: 2,
    conditions: {
      all: [
        { field: 'total_amount', op: 'gt', value: '500000' },
        { field: 'total_amount', op: 'lte', value: '2500000' },
      ],
    },
    steps: [
      step(1, 'Plant Head', ROLES.PLANT_HEAD),
      step(2, 'Procurement Head', ROLES.PROCUREMENT_HEAD, 48),
      step(3, 'Finance Head', ROLES.FINANCE_HEAD, 48),
    ],
  },
  {
    documentType: 'REQUISITION',
    name: 'PR — above ₹25L',
    priority: 3,
    conditions: { all: [{ field: 'total_amount', op: 'gt', value: '2500000' }] },
    steps: [
      step(1, 'Plant Head', ROLES.PLANT_HEAD),
      step(2, 'Procurement Head', ROLES.PROCUREMENT_HEAD, 48),
      step(3, 'Finance Head', ROLES.FINANCE_HEAD, 48),
      step(4, 'Managing Director', ROLES.MD, 72),
    ],
  },
  // Purchase orders
  {
    documentType: 'PURCHASE_ORDER',
    name: 'PO — up to ₹5L',
    priority: 1,
    conditions: { all: [{ field: 'total_amount', op: 'lte', value: '500000' }] },
    steps: [step(1, 'Procurement Head', ROLES.PROCUREMENT_HEAD)],
  },
  {
    documentType: 'PURCHASE_ORDER',
    name: 'PO — ₹5L to ₹25L',
    priority: 2,
    conditions: {
      all: [
        { field: 'total_amount', op: 'gt', value: '500000' },
        { field: 'total_amount', op: 'lte', value: '2500000' },
      ],
    },
    steps: [
      step(1, 'Procurement Head', ROLES.PROCUREMENT_HEAD),
      step(2, 'Plant Head', ROLES.PLANT_HEAD, 48),
      step(3, 'Finance Head', ROLES.FINANCE_HEAD, 48),
    ],
  },
  {
    documentType: 'PURCHASE_ORDER',
    name: 'PO — above ₹25L',
    priority: 3,
    conditions: { all: [{ field: 'total_amount', op: 'gt', value: '2500000' }] },
    steps: [
      step(1, 'Procurement Head', ROLES.PROCUREMENT_HEAD),
      step(2, 'Plant Head', ROLES.PLANT_HEAD, 48),
      step(3, 'Finance Head', ROLES.FINANCE_HEAD, 48),
      step(4, 'Managing Director', ROLES.MD, 72),
    ],
  },
];

// ── Budgets (FY 2026-27) ────────────────────────────────────────────────────

export interface SeedBudget {
  ccCode: string;
  allocated: string;
  /** Portion already committed against historical POs (believable "remaining"). */
  committed: string;
}

export const SLICE4_BUDGETS: SeedBudget[] = [
  { ccCode: 'CC-0421', allocated: '8000000', committed: '4260000' }, // Mill #3 ₹80L
  { ccCode: 'CC-0311', allocated: '12000000', committed: '4800000' }, // Kiln #1 ₹1.2Cr
  { ccCode: 'CC-0102', allocated: '180000000', committed: '72000000' }, // Raw material ₹18Cr
  { ccCode: 'CC-0201', allocated: '60000000', committed: '24000000' }, // Fuel ₹6Cr
  { ccCode: 'CC-0512', allocated: '40000000', committed: '16000000' }, // Packaging ₹4Cr
];
