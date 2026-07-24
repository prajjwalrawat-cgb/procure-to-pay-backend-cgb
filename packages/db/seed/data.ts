import {
  ROLES,
  type ApprovalStep,
  type Condition,
  type DocumentType,
  type RoleName,
} from '@procureflow/shared';

/** Demo passwords (Master Context §11 / Slice 0 demo script). Dev only. */
export const DEMO_PASSWORD = 'Slice0!Demo';
export const VENDOR_PASSWORD = 'Slice0!Vendor';

export interface SeedUser {
  email: string;
  name: string;
  roles: RoleName[];
  password: string;
}

/** The 6 Star Cement employees from Master Context §11. */
export const BUYER_USERS: SeedUser[] = [
  {
    email: 'harpreet@star-cement.example',
    name: 'Harpreet Singh',
    roles: [ROLES.TENANT_ADMIN, ROLES.PROCUREMENT_HEAD],
    password: DEMO_PASSWORD,
  },
  {
    email: 'm.iyer@star-cement.example',
    name: 'M. Iyer',
    roles: [ROLES.FINANCE_OFFICER],
    password: DEMO_PASSWORD,
  },
  {
    email: 'r.das@star-cement.example',
    name: 'R. Das',
    roles: [ROLES.FINANCE_HEAD],
    password: DEMO_PASSWORD,
  },
  {
    email: 'm.banerjee@star-cement.example',
    name: 'M. Banerjee',
    roles: [ROLES.PLANT_HEAD],
    password: DEMO_PASSWORD,
  },
  {
    email: 'r.kumar@star-cement.example',
    name: 'R. Kumar',
    roles: [ROLES.STORES_OFFICER],
    password: DEMO_PASSWORD,
  },
  {
    email: 'a.menon@star-cement.example',
    name: 'A. Menon',
    roles: [ROLES.MD],
    password: DEMO_PASSWORD,
  },
];

/** Vendor-portal login for the demo (Slice 0 demo step 7). */
export const VENDOR_USER: SeedUser = {
  email: 'kalpesh@patel-eng.example',
  name: 'Kalpesh Patel',
  roles: [ROLES.VENDOR_USER],
  password: VENDOR_PASSWORD,
};

export interface SeedVendor {
  code: string;
  name: string;
  gstin?: string;
  pan?: string;
  isMsme: boolean;
  udyamNumber?: string;
  msmeCategory?: string;
  categoryTags: string[];
  bank?: { bankName: string; accountLast4: string; ifsc: string; holderName: string };
}

/** The 11 vendors from Master Context §11. */
export const VENDORS: SeedVendor[] = [
  {
    code: 'V-PATEL',
    name: 'Patel Engineering',
    gstin: '24AABCP1234K1Z5',
    isMsme: true,
    udyamNumber: 'UDYAM-GJ-04-0089123',
    msmeCategory: 'SMALL',
    categoryTags: ['fabrication', 'spares'],
    bank: {
      bankName: 'HDFC Bank',
      accountLast4: '2841',
      ifsc: 'HDFC0000123',
      holderName: 'Patel Engineering',
    },
  },
  {
    code: 'V-TATA',
    name: 'Tata Steel Long Products',
    gstin: '21AAACT2727Q1ZW',
    isMsme: false,
    categoryTags: ['steel'],
  },
  {
    code: 'V-BPCL',
    name: 'BPCL Industrial',
    gstin: '27AAACB0000A1Z1',
    isMsme: false,
    categoryTags: ['fuel'],
  },
  {
    code: 'V-SAURA',
    name: 'Saurashtra Refractories',
    gstin: '24AAACS9999R1Z2',
    isMsme: true,
    udyamNumber: 'UDYAM-GJ-05-0011223',
    msmeCategory: 'MICRO',
    categoryTags: ['refractory'],
  },
  {
    code: 'V-BHILAI',
    name: 'Bhilai Steel Spares',
    gstin: '22AAACB3333S1Z8',
    isMsme: false,
    categoryTags: ['spares'],
  },
  {
    code: 'V-CONTI',
    name: 'Continental Belt',
    gstin: '29AAACC4444T1Z6',
    isMsme: false,
    categoryTags: ['conveyor', 'belts'],
  },
  {
    code: 'V-HONEY',
    name: 'Honeywell Thermal',
    gstin: '06AAACH5555U1Z4',
    isMsme: false,
    categoryTags: ['instrumentation'],
  },
  {
    code: 'V-JKPAP',
    name: 'JK Paper Mills',
    gstin: '08AAACJ6666V1Z2',
    isMsme: false,
    categoryTags: ['packaging'],
  },
  {
    code: 'V-RAJGY',
    name: 'Rajasthan Gypsum',
    gstin: '08AAACR7777W1Z0',
    isMsme: false,
    categoryTags: ['raw-material', 'gypsum'],
  },
  {
    code: 'V-VISHK',
    name: 'Vishakha Plastics',
    gstin: '24AAACV8888X1Z9',
    isMsme: true,
    udyamNumber: 'UDYAM-GJ-06-0022334',
    msmeCategory: 'SMALL',
    categoryTags: ['packaging', 'plastics'],
  },
  {
    code: 'V-SURAK',
    name: 'Suraksha Chem Industries',
    gstin: '19AAACS1111Y1Z7',
    isMsme: false,
    categoryTags: ['chemicals'],
  },
];

export interface SeedCostCenter {
  code: string;
  name: string;
  dept: string;
  budget: string;
}

/** Cost centers + the departments they belong to (Master Context §11). */
export const COST_CENTERS: SeedCostCenter[] = [
  { code: 'CC-0421', name: 'Mill #3', dept: 'Milling', budget: '25000000' },
  { code: 'CC-0311', name: 'Kiln #1', dept: 'Pyro', budget: '40000000' },
  { code: 'CC-0102', name: 'Raw material', dept: 'Raw Material', budget: '60000000' },
  { code: 'CC-0201', name: 'Fuel', dept: 'Utilities', budget: '55000000' },
  { code: 'CC-0512', name: 'Packaging', dept: 'Packing', budget: '18000000' },
];

export interface SeedMatrixRule {
  documentType: DocumentType;
  name: string;
  priority: number;
  conditions: Condition;
  steps: ApprovalStep[];
}

/**
 * Seed approval matrix rules driving the Slice 2 engine. Conditions/steps use the
 * real DSL and are snapshotted onto documents at submission time.
 *
 * The Star Cement demo tenant has no seeded DEPT_HEAD user, so the low-value
 * invoice band routes straight to the Finance Head (CFO). This is why INV-4471
 * (~₹2.17L) resolves to R. Das as a single approval step (Slice 2 demo).
 */
export const APPROVAL_RULES: SeedMatrixRule[] = [
  {
    documentType: 'INVOICE',
    name: 'Standard — up to ₹5L',
    priority: 1,
    conditions: { all: [{ field: 'total_amount', op: 'lte', value: '500000' }] },
    steps: [
      {
        step_no: 1,
        name: 'Finance Head',
        role: ROLES.FINANCE_HEAD,
        scope: 'tenant',
        sla_hours: 24,
      },
    ],
  },
  {
    documentType: 'INVOICE',
    name: 'Mid value — ₹5L to ₹25L',
    priority: 2,
    conditions: {
      all: [
        { field: 'total_amount', op: 'gt', value: '500000' },
        { field: 'total_amount', op: 'lte', value: '2500000' },
      ],
    },
    steps: [
      {
        step_no: 1,
        name: 'Plant Head',
        role: ROLES.PLANT_HEAD,
        scope: 'tenant',
        sla_hours: 24,
        escalate_to: { role: ROLES.FINANCE_HEAD, sla_hours: 24 },
      },
      {
        step_no: 2,
        name: 'Finance Head',
        role: ROLES.FINANCE_HEAD,
        scope: 'tenant',
        sla_hours: 48,
      },
    ],
  },
  {
    documentType: 'INVOICE',
    name: 'High value — ₹25L and above',
    priority: 3,
    conditions: { all: [{ field: 'total_amount', op: 'gt', value: '2500000' }] },
    steps: [
      {
        step_no: 1,
        name: 'Plant Head',
        role: ROLES.PLANT_HEAD,
        scope: 'tenant',
        sla_hours: 24,
      },
      {
        step_no: 2,
        name: 'Finance Head',
        role: ROLES.FINANCE_HEAD,
        scope: 'tenant',
        sla_hours: 48,
      },
    ],
  },
  {
    // Slice 3: payment run ≤ ₹50L → Finance Head only.
    documentType: 'PAYMENT_RUN',
    name: 'Payment run — up to ₹50L',
    priority: 1,
    conditions: { all: [{ field: 'total_amount', op: 'lte', value: '5000000' }] },
    steps: [
      {
        step_no: 1,
        name: 'Finance Head',
        role: ROLES.FINANCE_HEAD,
        scope: 'tenant',
        sla_hours: 24,
      },
    ],
  },
  {
    // Slice 3: payment run > ₹50L → Finance Head, then Managing Director.
    documentType: 'PAYMENT_RUN',
    name: 'Payment run — above ₹50L',
    priority: 2,
    conditions: { all: [{ field: 'total_amount', op: 'gt', value: '5000000' }] },
    steps: [
      {
        step_no: 1,
        name: 'Finance Head',
        role: ROLES.FINANCE_HEAD,
        scope: 'tenant',
        sla_hours: 24,
      },
      {
        step_no: 2,
        name: 'Managing Director',
        role: ROLES.MD,
        scope: 'tenant',
        sla_hours: 48,
      },
    ],
  },
];

export interface SeedBankAccount {
  bankName: string;
  accountNoLast4: string;
  ifsc: string;
  holderName: string;
  formatKey: 'NEFT_BULK' | 'ICICI_CINB' | 'SBI_CINB';
  dailyLimit: string;
}

/** Star Cement's configured disbursement bank accounts (Slice 3 §In-scope 2). */
export const BANK_ACCOUNTS: SeedBankAccount[] = [
  {
    bankName: 'HDFC Corporate',
    accountNoLast4: '7890',
    ifsc: 'HDFC0000234',
    holderName: 'Star Cement Ltd',
    formatKey: 'NEFT_BULK',
    dailyLimit: '50000000',
  },
  {
    bankName: 'ICICI Corporate',
    accountNoLast4: '0123',
    ifsc: 'ICIC0000505',
    holderName: 'Star Cement Ltd',
    formatKey: 'ICICI_CINB',
    dailyLimit: '50000000',
  },
];
