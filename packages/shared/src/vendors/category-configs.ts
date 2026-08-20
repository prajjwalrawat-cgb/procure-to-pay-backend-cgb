/**
 * Vendor category configs (Slice 7 deliverable) — drive progressive disclosure
 * in the onboarding wizard: which documents/screenings/certifications a category
 * requires, which approval matrix routes it, and the review SLA. Seeded into
 * VendorCategoryConfig; the wizard reads these directly for conditional sections.
 */

import type { ScreeningType, VendorDocumentType } from '../constants/vendor-status';

export interface VendorCategoryConfig {
  categoryKey: string;
  displayName: string;
  description: string;
  requiredDocuments: VendorDocumentType[];
  optionalDocuments: VendorDocumentType[];
  requiredScreenings: ScreeningType[];
  requiredCertifications: VendorDocumentType[];
  approvalMatrixName: string;
  slaHours: number;
}

/** The statutory minimum, asked of every vendor whatever they supply — also
 *  the starting point for a category a tenant admin creates themselves. */
export const DEFAULT_CATEGORY_REQUIRED_DOCUMENTS: VendorDocumentType[] = [
  'GST_CERT',
  'PAN_CARD',
  'CANCELLED_CHEQUE',
];
export const DEFAULT_CATEGORY_REQUIRED_SCREENINGS: ScreeningType[] = [
  'GSTIN_STATUS',
  'PAN_STATUS',
  'SANCTIONS_OFAC',
  'CREDIT_BUREAU',
];

const BASE_DOCS = DEFAULT_CATEGORY_REQUIRED_DOCUMENTS;
const BASE_SCREENINGS = DEFAULT_CATEGORY_REQUIRED_SCREENINGS;

export const VENDOR_CATEGORY_CONFIGS: VendorCategoryConfig[] = [
  {
    categoryKey: 'MECHANICAL_SPARES',
    displayName: 'Mechanical spares',
    description: 'Bearings, liners, castings, machined parts.',
    requiredDocuments: [
      ...BASE_DOCS,
      'ISO_9001',
      'INSURANCE_POLICY',
      'AUDITED_FINANCIALS',
    ],
    optionalDocuments: ['MSME_UDYAM', 'ISO_14001', 'ISO_45001'],
    requiredScreenings: BASE_SCREENINGS,
    requiredCertifications: ['ISO_9001'],
    approvalMatrixName: 'Vendor onboarding — standard',
    slaHours: 120,
  },
  {
    categoryKey: 'RAW_MATERIALS',
    displayName: 'Raw materials',
    description: 'Gypsum, coal, clinker, additives.',
    requiredDocuments: [
      ...BASE_DOCS,
      'POLLUTION_NOC',
      'FACTORY_LICENSE',
      'AUDITED_FINANCIALS',
    ],
    optionalDocuments: ['MSME_UDYAM', 'ISO_9001'],
    requiredScreenings: BASE_SCREENINGS,
    requiredCertifications: [],
    approvalMatrixName: 'Vendor onboarding — standard',
    slaHours: 120,
  },
  {
    categoryKey: 'CHEMICALS',
    displayName: 'Chemicals',
    description: 'Grinding aids, de-dusting oils, process chemicals.',
    requiredDocuments: [
      ...BASE_DOCS,
      'REACH_DECL',
      'SDS',
      'POLLUTION_NOC',
      'FACTORY_LICENSE',
    ],
    optionalDocuments: ['MSME_UDYAM', 'ISO_14001'],
    requiredScreenings: [...BASE_SCREENINGS, 'ADVERSE_MEDIA'],
    requiredCertifications: [],
    approvalMatrixName: 'Vendor onboarding — high-risk',
    slaHours: 168,
  },
  {
    categoryKey: 'LOGISTICS',
    displayName: 'Logistics',
    description: 'Transport, freight, fleet operators.',
    requiredDocuments: [...BASE_DOCS, 'RC_BOOK', 'DRIVING_LICENSE', 'INSURANCE_POLICY'],
    optionalDocuments: ['MSME_UDYAM'],
    requiredScreenings: BASE_SCREENINGS,
    requiredCertifications: [],
    approvalMatrixName: 'Vendor onboarding — standard',
    slaHours: 72,
  },
  {
    categoryKey: 'PROFESSIONAL_SERVICES',
    displayName: 'Professional services',
    description: 'Consulting, audit, engineering services.',
    requiredDocuments: ['GST_CERT', 'PAN_CARD'],
    optionalDocuments: ['MSME_UDYAM', 'CANCELLED_CHEQUE'],
    requiredScreenings: ['GSTIN_STATUS', 'PAN_STATUS', 'SANCTIONS_OFAC'],
    requiredCertifications: [],
    approvalMatrixName: 'Vendor onboarding — standard',
    slaHours: 48,
  },
  {
    categoryKey: 'PACKAGING_MATERIALS',
    displayName: 'Packaging materials',
    description: 'Cement bags, kraft reels, shrink wrap.',
    requiredDocuments: [...BASE_DOCS, 'AUDITED_FINANCIALS'],
    optionalDocuments: ['MSME_UDYAM', 'BIS_CERT', 'ISO_9001'],
    requiredScreenings: BASE_SCREENINGS,
    requiredCertifications: [],
    approvalMatrixName: 'Vendor onboarding — standard',
    slaHours: 120,
  },
  {
    categoryKey: 'FUEL_LUBRICANTS',
    displayName: 'Fuel & lubricants',
    description: 'Petcoke, furnace oil, hydraulic oils.',
    requiredDocuments: [...BASE_DOCS, 'BIS_CERT', 'POLLUTION_NOC', 'AUDITED_FINANCIALS'],
    optionalDocuments: ['MSME_UDYAM'],
    requiredScreenings: [...BASE_SCREENINGS, 'ADVERSE_MEDIA'],
    requiredCertifications: [],
    approvalMatrixName: 'Vendor onboarding — high-risk',
    slaHours: 168,
  },
  {
    categoryKey: 'IT_SERVICES',
    displayName: 'IT services',
    description: 'Software, cloud, integration services.',
    requiredDocuments: ['GST_CERT', 'PAN_CARD', 'CANCELLED_CHEQUE'],
    optionalDocuments: ['MSME_UDYAM', 'ISO_27001'],
    requiredScreenings: ['GSTIN_STATUS', 'PAN_STATUS', 'SANCTIONS_OFAC'],
    requiredCertifications: [],
    approvalMatrixName: 'Vendor onboarding — standard',
    slaHours: 120,
  },
];

/**
 * Statutory documents the vendor uploads in **step 1**, where they drive the
 * auto-fill: the GST certificate and PAN card are the two documents every
 * extracted/verified field on the company-basics step comes from, so they are
 * collected before the form rather than after it.
 */
export const ONBOARDING_STEP1_DOCUMENTS: VendorDocumentType[] = ['GST_CERT', 'PAN_CARD'];

/**
 * The only documents mandatory on **step 4 (Documents)**, for every category.
 * Category-specific certificates (ISO, pollution NOC, factory licence…) stay
 * available under "other documents" and are requested by the buyer during review
 * when the category actually needs them — they were blocking submission before,
 * which is what stalled onboardings on paperwork nobody had chased yet.
 */
export const ONBOARDING_STEP4_DOCUMENTS: VendorDocumentType[] = [
  'CANCELLED_CHEQUE',
  'AUDITED_FINANCIALS',
];

/**
 * Offered on step 4 but never required: a vendor with a catalogue can attach it
 * for the buyer to browse, and one without is not held up. Deliberately kept
 * out of ONBOARDING_MANDATORY_DOCUMENTS — nothing here gates submission.
 */
export const ONBOARDING_OPTIONAL_DOCUMENTS: VendorDocumentType[] = ['CATALOGUE'];

/** Everything a vendor must have uploaded before submit is allowed. */
export const ONBOARDING_MANDATORY_DOCUMENTS: VendorDocumentType[] = [
  ...ONBOARDING_STEP1_DOCUMENTS,
  ...ONBOARDING_STEP4_DOCUMENTS,
];

export function categoryConfig(key: string): VendorCategoryConfig | undefined {
  return VENDOR_CATEGORY_CONFIGS.find((c) => c.categoryKey === key);
}
