import { z } from 'zod';

import type { LiveApprovalStep } from './approvals';
import type { BudgetCheckResult } from './budget';
import {
  NON_CATALOG_REASON,
  REQUISITION_PRIORITY,
  REQUISITION_STATUS,
} from '../constants/status';

const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'must be a decimal string');

// ── Inputs ─────────────────────────────────────────────────────────────────

export const RequisitionLineInputSchema = z.object({
  itemId: z.string().nullish(),
  itemDesc: z.string().min(1).max(500),
  uom: z.string().min(1).max(20),
  qty: decimalString,
  unitPrice: decimalString,
  discountPct: decimalString.default('0'),
  taxRate: decimalString.default('0'),
  hsnCode: z.string().max(12).nullish(),
  category: z.string().max(80).nullish(),
  subCategory: z.string().max(80).nullish(),
  notes: z.string().max(1000).nullish(),
  preferredVendorId: z.string().nullish(),
  /** Required when itemId is absent (non-catalogued line). */
  reasonCode: z.enum(NON_CATALOG_REASON).nullish(),
});
export type RequisitionLineInput = z.infer<typeof RequisitionLineInputSchema>;

export const RequisitionCreateInputSchema = z.object({
  title: z.string().min(5).max(200),
  businessJustification: z.string().min(20).max(2000),
  costCenterId: z.string().min(1),
  plantId: z.string().min(1),
  deliveryLocation: z.string().max(400).nullish(),
  neededBy: z.string().datetime(),
  priority: z.enum(REQUISITION_PRIORITY).default('STANDARD'),
  lines: z.array(RequisitionLineInputSchema).min(1),
});
export type RequisitionCreateInput = z.infer<typeof RequisitionCreateInputSchema>;

export const RequisitionUpdateInputSchema = RequisitionCreateInputSchema.partial().extend(
  {
    lines: z.array(RequisitionLineInputSchema).min(1).optional(),
  },
);
export type RequisitionUpdateInput = z.infer<typeof RequisitionUpdateInputSchema>;

export const RequisitionListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().nullish(),
  status: z
    .string()
    .nullish()
    .transform((v) => (v ? v.split(',') : undefined))
    .pipe(z.array(z.enum(REQUISITION_STATUS)).optional()),
  requesterId: z.string().nullish(),
  deptId: z.string().nullish(),
  costCenterId: z.string().nullish(),
  plantId: z.string().nullish(),
  priority: z.enum(REQUISITION_PRIORITY).nullish(),
  hasPreferredVendor: z.coerce.boolean().nullish(),
  msmeOnly: z.coerce.boolean().nullish(),
  myApprovalsOnly: z.coerce.boolean().nullish(),
  tab: z.enum(['active', 'my_approval', 'draft', 'rejected', 'closed']).default('active'),
});
export type RequisitionListQuery = z.infer<typeof RequisitionListQuerySchema>;

export const RequisitionDecisionInputSchema = z.object({
  approvalId: z.string().min(1),
  decision: z.enum(['APPROVE', 'REJECT', 'REQUEST_CHANGES']),
  comment: z.string().max(2000).nullish(),
});
export type RequisitionDecisionInput = z.infer<typeof RequisitionDecisionInputSchema>;

export const RequisitionCancelInputSchema = z.object({
  reason: z.string().min(1).max(500),
});
export type RequisitionCancelInput = z.infer<typeof RequisitionCancelInputSchema>;

export const RequisitionCommentInputSchema = z.object({
  body: z.string().min(1).max(4000),
});
export type RequisitionCommentInput = z.infer<typeof RequisitionCommentInputSchema>;

// ── Procurement reference lists (Slice 4 — for wizard pickers) ───────────────

export interface CostCenterRef {
  id: string;
  code: string;
  name: string;
  deptId: string | null;
  plantId: string | null;
}

export interface PlantRef {
  id: string;
  name: string;
  stateCode: string;
  address: string | null;
}

export interface VendorRef {
  id: string;
  code: string;
  name: string;
  isMsme: boolean;
  status: string;
  bankVerified: boolean;
}

// ── Read models ────────────────────────────────────────────────────────────

export type RequisitionKanbanColumn =
  'DRAFT' | 'AWAITING_APPROVAL' | 'SOURCING' | 'PO_ISSUED' | 'RECEIVED';

export interface RequisitionCardView {
  id: string;
  number: string;
  title: string;
  costCenter: { id: string; code: string; name: string };
  totalAmount: string;
  currency: string;
  status: string;
  priority: string;
  neededBy: string | null;
  agingDays: number;
  requester: { id: string; name: string };
  lineCount: number;
  hasMsmeVendor: boolean;
  column: RequisitionKanbanColumn;
}

export interface RequisitionKanbanResponse {
  columns: Record<RequisitionKanbanColumn, RequisitionCardView[]>;
  counts: Record<RequisitionKanbanColumn, number>;
}

export interface RequisitionListResponse {
  items: RequisitionCardView[];
  nextCursor: string | null;
  totalEstimate: number;
}

export interface RequisitionLineView {
  id: string;
  lineNo: number;
  itemId: string | null;
  skuCode: string | null;
  itemDesc: string;
  hsnCode: string | null;
  uom: string;
  qty: string;
  qtyIssued: string;
  qtyRemaining: string;
  qtyReceived: string;
  unitPrice: string;
  discountPct: string;
  taxRate: string;
  taxAmount: string;
  lineTotal: string;
  category: string | null;
  preferredVendor: { id: string; name: string; isMsme: boolean } | null;
  reasonCode: string | null;
  isCatalogued: boolean;
  /** Current item-master state alongside the line snapshot (may differ). */
  itemCurrent: { name: string; gstRate: string; isActive: boolean } | null;
}

export interface RequisitionPoConversionView {
  id: string;
  number: string;
  vendorName: string;
  status: string;
  totalAmount: string;
}

export interface RequisitionDetailResponse {
  id: string;
  number: string;
  title: string;
  businessJustification: string;
  status: string;
  priority: string;
  neededBy: string | null;
  agingDays: number;
  createdAt: string;
  requester: { id: string; name: string; deptName: string | null };
  costCenter: { id: string; code: string; name: string };
  plant: { id: string; name: string };
  deliveryLocation: string | null;
  stages: { key: string; label: string; state: 'done' | 'active' | 'todo' }[];
  lines: RequisitionLineView[];
  amounts: {
    subtotal: string;
    taxAmount: string;
    taxKind: string;
    total: string;
    currency: string;
  };
  budget: BudgetCheckResult | null;
  committedAmount: string | null;
  poConversions: RequisitionPoConversionView[];
  attachments: { id: string; url: string; mimeType: string }[];
  comments: {
    id: string;
    authorId: string;
    authorName: string;
    body: string;
    createdAt: string;
  }[];
  activity: { id: string; action: string; actorId: string | null; at: string }[];
  liveApprovalChain: LiveApprovalStep[];
  myApprovalId: string | null;
  canDecide: boolean;
  canCreatePo: boolean;
  canWithdraw: boolean;
  canCancel: boolean;
  budgetBreachDetail: BudgetCheckResult | null;
}
