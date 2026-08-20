import { z } from 'zod';

import {
  SCREENING_TYPE,
  VENDOR_DOCUMENT_TYPE,
  type ScreeningType,
  type VendorDocumentType,
} from '../constants/vendor-status';
import {
  DEFAULT_CATEGORY_REQUIRED_DOCUMENTS,
  DEFAULT_CATEGORY_REQUIRED_SCREENINGS,
} from '../vendors/category-configs';

/**
 * Vendor categories as **tenant data**.
 *
 * `VENDOR_CATEGORY_CONFIGS` ships a cement-industry starter set (mechanical
 * spares, raw materials, chemicals…). Those are defaults, not the truth: a
 * reseller-and-OEM business classifies its vendors differently, and no code
 * change should be needed to say so. An admin maintains the list from Settings;
 * every category dropdown — buyer invite, public self-registration, the
 * onboarding wizard's document hints — reads whatever that tenant has.
 *
 * `categoryKey` is derived from the name once, at creation, then frozen:
 * vendors, onboardings and scorecards already point at it, and renaming the key
 * would orphan them. Renaming the *display name* is always safe.
 */

export const VendorCategorySchema = z.object({
  id: z.string(),
  categoryKey: z.string(),
  displayName: z.string(),
  description: z.string().nullable(),
  requiredDocuments: z.array(z.enum(VENDOR_DOCUMENT_TYPE)),
  optionalDocuments: z.array(z.enum(VENDOR_DOCUMENT_TYPE)),
  requiredScreenings: z.array(z.enum(SCREENING_TYPE)),
  requiredCertifications: z.array(z.enum(VENDOR_DOCUMENT_TYPE)),
  approvalMatrixName: z.string(),
  slaHours: z.number().int(),
  isActive: z.boolean(),
});
export type VendorCategory = z.infer<typeof VendorCategorySchema>;

/** What a category dropdown needs — served to anyone who can start an
 *  onboarding, including the unauthenticated self-registration page. */
export const VendorCategoryOptionSchema = z.object({
  key: z.string(),
  displayName: z.string(),
  slaHours: z.number().int(),
  /** Carried on the option so the onboarding wizard can list the paperwork this
   *  category expects without a second round trip. */
  requiredDocuments: z.array(z.enum(VENDOR_DOCUMENT_TYPE)),
  optionalDocuments: z.array(z.enum(VENDOR_DOCUMENT_TYPE)),
});
export type VendorCategoryOption = z.infer<typeof VendorCategoryOptionSchema>;

const documentList = z
  .array(z.enum(VENDOR_DOCUMENT_TYPE))
  .max(VENDOR_DOCUMENT_TYPE.length)
  .optional();

/** Review turnaround. A week is the longest anyone has justified; the floor of
 *  one hour keeps a typo from silently marking every onboarding overdue. */
const slaHours = z.number().int().min(1).max(720).optional();

export const VendorCategoryCreateInputSchema = z.object({
  displayName: z.string().trim().min(1, 'Name is required').max(80),
  description: z.string().trim().max(200).nullish(),
  slaHours,
  requiredDocuments: documentList,
  optionalDocuments: documentList,
});
export type VendorCategoryCreateInput = z.infer<typeof VendorCategoryCreateInputSchema>;

/** `categoryKey` is deliberately absent — see the note above. */
export const VendorCategoryUpdateInputSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(200).nullish(),
  slaHours,
  requiredDocuments: documentList,
  optionalDocuments: documentList,
  isActive: z.boolean().optional(),
});
export type VendorCategoryUpdateInput = z.infer<typeof VendorCategoryUpdateInputSchema>;

/** Applied to categories an admin creates: the statutory minimum every vendor
 *  is asked for regardless of trade. Anything beyond it is the admin's call. */
export const NEW_CATEGORY_DEFAULTS = {
  requiredDocuments: DEFAULT_CATEGORY_REQUIRED_DOCUMENTS as VendorDocumentType[],
  optionalDocuments: ['MSME_UDYAM'] as VendorDocumentType[],
  requiredScreenings: DEFAULT_CATEGORY_REQUIRED_SCREENINGS as ScreeningType[],
  requiredCertifications: [] as VendorDocumentType[],
  approvalMatrixName: 'Vendor onboarding — standard',
  slaHours: 120,
} as const;

/** "Reseller" → "RESELLER", "Fuel & lubricants" → "FUEL_LUBRICANTS". */
export function vendorCategoryKey(displayName: string): string {
  return displayName
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}
