import { z } from 'zod';

const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'must be a decimal string');

// ── Inputs ─────────────────────────────────────────────────────────────────

export const ItemCreateInputSchema = z.object({
  skuCode: z.string().min(1).max(60),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).nullish(),
  category: z.string().min(1).max(80),
  subcategory: z.string().max(80).nullish(),
  hsnCode: z.string().min(2).max(12),
  gstRate: decimalString,
  primaryUom: z.string().min(1).max(20),
  isCapex: z.boolean().default(false),
  defaultGlAccount: z.string().max(40).nullish(),
  uomConversions: z
    .array(
      z.object({
        fromUom: z.string().min(1).max(20),
        toUom: z.string().min(1).max(20),
        factor: decimalString,
      }),
    )
    .default([]),
});
export type ItemCreateInput = z.infer<typeof ItemCreateInputSchema>;

export const ItemUpdateInputSchema = ItemCreateInputSchema.partial().omit({
  uomConversions: true,
});
export type ItemUpdateInput = z.infer<typeof ItemUpdateInputSchema>;

export const ItemListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().nullish(),
  q: z.string().max(120).nullish(),
  category: z.string().nullish(),
  active: z.coerce.boolean().nullish(),
  hasPreferredVendor: z.coerce.boolean().nullish(),
});
export type ItemListQuery = z.infer<typeof ItemListQuerySchema>;

// ── Read models ────────────────────────────────────────────────────────────

export interface ItemVendorPricingView {
  id: string;
  vendorId: string;
  vendorName: string;
  vendorIsMsme: boolean;
  unitPrice: string;
  uom: string;
  currency: string;
  validFrom: string;
  validTo: string | null;
  isPreferred: boolean;
}

export interface ItemListItem {
  id: string;
  skuCode: string;
  name: string;
  category: string;
  subcategory: string | null;
  hsnCode: string;
  gstRate: string;
  primaryUom: string;
  isActive: boolean;
  isCapex: boolean;
  lastPaidPrice: string | null;
  preferredVendor: { id: string; name: string } | null;
}

export interface ItemListResponse {
  items: ItemListItem[];
  nextCursor: string | null;
  totalEstimate: number;
}

export interface ItemDetailResponse extends ItemListItem {
  description: string | null;
  defaultGlAccount: string | null;
  uomConversions: { fromUom: string; toUom: string; factor: string }[];
  vendorPricing: ItemVendorPricingView[];
}
