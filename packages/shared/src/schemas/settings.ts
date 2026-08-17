import { z } from 'zod';

import { GST_STATES } from '../constants/gst-states';

/**
 * Organisation settings — the tenant's own identity, its GST registrations and
 * its letterhead.
 *
 * Everything a document or screen needs to name the buying organisation comes
 * from here: the PO PDF's letterhead and jurisdiction clause, the app's page
 * subheadings, and the place of supply that decides CGST/SGST vs IGST. None of
 * it may be a literal in code — a second tenant must see its own details.
 */

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const STATE_CODES = GST_STATES.map((s) => s.code);

const gstin = z
  .string()
  .trim()
  .toUpperCase()
  .regex(GSTIN_RE, 'Enter a valid 15-character GSTIN')
  .nullish();

/**
 * One GST registration = one branch. An entity registered in several states
 * holds a GSTIN per state, and a purchase order is always raised in the name of
 * exactly one of them.
 */
export const BranchSchema = z.object({
  id: z.string(),
  name: z.string(),
  address: z.string().nullable(),
  stateCode: z.string(),
  gstin: z.string().nullable(),
  /** The registration used when a document does not name one explicitly. */
  isDefault: z.boolean(),
});
export type Branch = z.infer<typeof BranchSchema>;

export const OrganisationSettingsSchema = z.object({
  tenant: z.object({
    id: z.string(),
    name: z.string(),
    pan: z.string().nullable(),
    currency: z.string(),
  }),
  branches: z.array(BranchSchema),
  /** Time-limited URL for the letterhead logo, null when none is uploaded. */
  logoUrl: z.string().nullable(),
});
export type OrganisationSettings = z.infer<typeof OrganisationSettingsSchema>;

export const OrganisationUpdateInputSchema = z.object({
  name: z.string().trim().min(1, 'Organisation name is required').max(160).optional(),
  /// A company holds one PAN however many state registrations it has.
  pan: z
    .string()
    .trim()
    .toUpperCase()
    .regex(PAN_RE, 'Enter a valid 10-character PAN')
    .nullish(),
  currency: z.string().trim().length(3).toUpperCase().optional(),
});
export type OrganisationUpdateInput = z.infer<typeof OrganisationUpdateInputSchema>;

export const BranchInputSchema = z.object({
  name: z.string().trim().min(1, 'Branch name is required').max(120),
  address: z.string().trim().max(400).nullish(),
  stateCode: z
    .string()
    .trim()
    .refine((c) => STATE_CODES.includes(c), 'Select a valid GST state'),
  gstin: gstin,
  isDefault: z.boolean().optional(),
});
export type BranchInput = z.infer<typeof BranchInputSchema>;
