import { z } from 'zod';

import {
  CONDITION_OPS,
  MAX_CONDITION_DEPTH,
  conditionDepth,
  type Condition,
  type ConditionOp,
} from '../approvals/evaluator';
import { ALL_ROLES, type RoleName } from '../constants/roles';
import { SCOPES, type Scope } from '../constants/permissions';
import { DOCUMENT_TYPE, type DocumentType } from '../constants/status';

const roleEnum = z.enum(ALL_ROLES as [RoleName, ...RoleName[]]);
const scopeEnum = z.enum(SCOPES as unknown as [Scope, ...Scope[]]);
const docTypeEnum = z.enum(DOCUMENT_TYPE as unknown as [DocumentType, ...DocumentType[]]);

// ── Conditions DSL ─────────────────────────────────────────────────────────

/** Recursive conditions schema (Slice 2). Depth is bounded at the root. */
export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z
    .object({
      all: z.array(ConditionSchema).optional(),
      any: z.array(ConditionSchema).optional(),
      none: z.array(ConditionSchema).optional(),
      field: z.string().min(1).max(120).optional(),
      op: z.enum(CONDITION_OPS).optional(),
      value: z.unknown().optional(),
    })
    .strict(),
);

/** Root conditions: same shape, but rejects trees deeper than the depth limit. */
export const ConditionRootSchema = ConditionSchema.superRefine((cond, ctx) => {
  if (conditionDepth(cond as Condition) > MAX_CONDITION_DEPTH) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Condition nesting exceeds the depth limit of ${MAX_CONDITION_DEPTH}`,
    });
  }
});

// ── Steps DSL ──────────────────────────────────────────────────────────────

export const ApprovalStepSchema = z.object({
  step_no: z.number().int().positive(),
  name: z.string().min(1).max(120),
  role: roleEnum,
  scope: scopeEnum,
  sla_hours: z.number().int().positive().max(4320),
  escalate_to: z
    .object({ role: roleEnum, sla_hours: z.number().int().positive().max(4320) })
    .optional(),
  skip_if: ConditionSchema.optional(),
  parallel_group: z.string().min(1).max(60).optional(),
});
export type ApprovalStep = z.infer<typeof ApprovalStepSchema>;

export const ApprovalStepsSchema = z
  .array(ApprovalStepSchema)
  .min(1)
  .max(20)
  .superRefine((steps, ctx) => {
    const seen = new Set<number>();
    for (const s of steps) {
      if (seen.has(s.step_no)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate step_no ${s.step_no}`,
        });
      }
      seen.add(s.step_no);
    }
  });

// ── Matrix mutation inputs ───────────────────────────────────────────────────

export const ApprovalMatrixCreateInputSchema = z.object({
  documentType: docTypeEnum,
  name: z.string().min(1).max(120),
  priority: z.number().int().min(0).max(10000),
  conditions: ConditionRootSchema,
  steps: ApprovalStepsSchema,
});
export type ApprovalMatrixCreateInput = z.infer<typeof ApprovalMatrixCreateInputSchema>;

export const ApprovalMatrixUpdateInputSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  priority: z.number().int().min(0).max(10000).optional(),
  conditions: ConditionRootSchema.optional(),
  steps: ApprovalStepsSchema.optional(),
});
export type ApprovalMatrixUpdateInput = z.infer<typeof ApprovalMatrixUpdateInputSchema>;

export const SimulateInputSchema = z
  .object({
    documentType: docTypeEnum,
    // When testing an unsaved rule the builder sends conditions+steps inline;
    // the saved-matrix route fills them from the persisted matrix instead.
    conditions: ConditionRootSchema.optional(),
    steps: ApprovalStepsSchema.optional(),
    documentId: z.string().min(1).optional(),
    sampleDocument: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((v) => v.documentId ?? v.sampleDocument, {
    message: 'Provide a documentId or a sampleDocument',
  });
export type SimulateInput = z.infer<typeof SimulateInputSchema>;

// ── Decisions & delegation ───────────────────────────────────────────────────

export const APPROVAL_DECISION_ACTIONS = [
  'APPROVE',
  'REJECT',
  'REQUEST_CHANGES',
] as const;
export type ApprovalDecisionAction = (typeof APPROVAL_DECISION_ACTIONS)[number];

export const ApprovalDecisionInputSchema = z.object({
  decision: z.enum(APPROVAL_DECISION_ACTIONS),
  comment: z.string().max(2000).nullish(),
});
export type ApprovalDecisionInput = z.infer<typeof ApprovalDecisionInputSchema>;

export const ApprovalDelegateInputSchema = z.object({
  delegateToUserId: z.string().min(1),
  reason: z.string().min(1).max(500),
});
export type ApprovalDelegateInput = z.infer<typeof ApprovalDelegateInputSchema>;

export const DELEGATION_SCOPES = ['ALL', 'SPECIFIC'] as const;
export const DelegationCreateInputSchema = z
  .object({
    delegateUserId: z.string().min(1),
    scope: z.enum(DELEGATION_SCOPES).default('ALL'),
    documentTypes: z.array(docTypeEnum).optional(),
    from: z.string().datetime(),
    to: z.string().datetime(),
    reason: z.string().min(1).max(500),
  })
  .refine((v) => v.scope === 'ALL' || (v.documentTypes?.length ?? 0) > 0, {
    message: 'SPECIFIC delegation requires at least one documentType',
  });
export type DelegationCreateInput = z.infer<typeof DelegationCreateInputSchema>;

export const InboxFilterSchema = z.object({
  filter: z
    .enum(['all', 'waiting_on_me', 'delegated_to_me', 'delegated_by_me'])
    .default('waiting_on_me'),
});
export type InboxFilter = z.infer<typeof InboxFilterSchema>;

export const BulkApproveInputSchema = z.object({
  approvalIds: z.array(z.string().min(1)).min(1).max(100),
  comment: z.string().max(2000).nullish(),
});
export type BulkApproveInput = z.infer<typeof BulkApproveInputSchema>;

// ── Read models (typed, shared with the frontend) ────────────────────────────

export interface ApprovalMatrixView {
  id: string;
  documentType: DocumentType;
  name: string;
  priority: number;
  isActive: boolean;
  version: number;
  previousVersionId: string | null;
  conditions: Condition;
  steps: ApprovalStep[];
  updatedBy: string | null;
  updatedByName: string | null;
  createdAt: string;
}

export interface ApprovalMatrixListResponse {
  documentType: DocumentType;
  items: ApprovalMatrixView[];
}

export interface ResolvedChainStep {
  stepNo: number;
  name: string;
  role: string;
  scope: string;
  slaHours: number;
  parallelGroup: string | null;
  approverId: string | null;
  approverName: string | null;
  skipped: boolean;
  skipReason: string | null;
  unresolved: boolean;
  unresolvedReason: string | null;
}

export interface SimulateResult {
  matchedMatrixId: string | null;
  matchedMatrixName: string | null;
  matched: boolean;
  trace: import('../approvals/evaluator').EvalStep[];
  chain: ResolvedChainStep[];
  context: Record<string, unknown>;
}

export type LiveApprovalDecision =
  'PENDING' | 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED' | 'DELEGATED';

export interface LiveApprovalStep {
  approvalId: string | null;
  stepNo: number;
  name: string;
  role: string;
  scope: string;
  slaHours: number;
  parallelGroup: string | null;
  approverId: string | null;
  approverName: string | null;
  decision: LiveApprovalDecision;
  decidedAt: string | null;
  comment: string | null;
  slaDueAt: string | null;
  slaStatus: 'ok' | 'warn' | 'breach' | 'done';
  isCurrent: boolean;
  isEscalation: boolean;
  delegatedFromName: string | null;
}

export interface InboxItem {
  approvalId: string;
  documentType: DocumentType;
  documentId: string;
  title: string;
  number: string;
  submitterName: string | null;
  amount: string | null;
  currency: string;
  daysPending: number;
  slaStatus: 'ok' | 'warn' | 'breach';
  slaDueAt: string | null;
  delegatedFromName: string | null;
  href: string;
}

export interface InboxResponse {
  items: InboxItem[];
  counts: {
    waiting_on_me: number;
    delegated_to_me: number;
    delegated_by_me: number;
  };
}

export interface ApprovalSidebarCounts {
  invoices: number;
  paymentRuns: number;
  total: number;
}

/** Fields the conditions builder offers per document type (Slice 2 field-picker). */
export interface ApprovalFieldDef {
  field: string;
  label: string;
  type: 'money' | 'number' | 'boolean' | 'enum' | 'string';
  ops: ConditionOp[];
}

const MONEY_OPS: ConditionOp[] = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'];
const NUMBER_OPS: ConditionOp[] = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'];
const BOOL_OPS: ConditionOp[] = ['eq', 'ne'];
const ENUM_OPS: ConditionOp[] = ['eq', 'ne', 'in', 'nin'];
const STRING_OPS: ConditionOp[] = ['eq', 'ne', 'contains', 'in', 'nin'];

const INVOICE_FIELDS: ApprovalFieldDef[] = [
  { field: 'total_amount', label: 'Total amount', type: 'money', ops: MONEY_OPS },
  { field: 'tax_amount', label: 'Tax amount', type: 'money', ops: MONEY_OPS },
  { field: 'net_amount', label: 'Net payable', type: 'money', ops: MONEY_OPS },
  { field: 'aging_days', label: 'Aging (days)', type: 'number', ops: NUMBER_OPS },
  { field: 'line_count', label: 'Line count', type: 'number', ops: NUMBER_OPS },
  { field: 'category', label: 'Category', type: 'string', ops: STRING_OPS },
  { field: 'vendor.is_msme', label: 'Vendor is MSME', type: 'boolean', ops: BOOL_OPS },
  { field: 'has_exception', label: 'Has exception', type: 'boolean', ops: BOOL_OPS },
  { field: 'currency', label: 'Currency', type: 'enum', ops: ENUM_OPS },
];

const PAYMENT_RUN_FIELDS: ApprovalFieldDef[] = [
  { field: 'total_amount', label: 'Gross amount', type: 'money', ops: MONEY_OPS },
  { field: 'net_amount', label: 'Net amount', type: 'money', ops: MONEY_OPS },
  { field: 'item_count', label: 'Item count', type: 'number', ops: NUMBER_OPS },
];

/** Fields mirror `ApprovalContextService.buildRequisition`. */
const REQUISITION_FIELDS: ApprovalFieldDef[] = [
  { field: 'total_amount', label: 'Total amount', type: 'money', ops: MONEY_OPS },
  { field: 'tax_amount', label: 'Tax amount', type: 'money', ops: MONEY_OPS },
  { field: 'line_count', label: 'Line count', type: 'number', ops: NUMBER_OPS },
  { field: 'priority', label: 'Priority', type: 'enum', ops: ENUM_OPS },
  { field: 'dept_id', label: 'Department', type: 'string', ops: STRING_OPS },
  { field: 'plant_id', label: 'Plant', type: 'string', ops: STRING_OPS },
  { field: 'cost_center_id', label: 'Cost center', type: 'string', ops: STRING_OPS },
  { field: 'currency', label: 'Currency', type: 'enum', ops: ENUM_OPS },
];

/** Fields mirror `ApprovalContextService.buildPurchaseOrder`. */
const PURCHASE_ORDER_FIELDS: ApprovalFieldDef[] = [
  { field: 'total_amount', label: 'Total amount', type: 'money', ops: MONEY_OPS },
  { field: 'tax_amount', label: 'Tax amount', type: 'money', ops: MONEY_OPS },
  { field: 'po_type', label: 'PO type', type: 'enum', ops: ENUM_OPS },
  { field: 'is_spot_buy', label: 'Is spot buy', type: 'boolean', ops: BOOL_OPS },
  { field: 'line_count', label: 'Line count', type: 'number', ops: NUMBER_OPS },
  { field: 'vendor.is_msme', label: 'Vendor is MSME', type: 'boolean', ops: BOOL_OPS },
  { field: 'currency', label: 'Currency', type: 'enum', ops: ENUM_OPS },
];

/** Fields mirror `ApprovalContextService.buildVendorOnboarding`. */
const VENDOR_ONBOARDING_FIELDS: ApprovalFieldDef[] = [
  { field: 'category', label: 'Vendor category', type: 'string', ops: STRING_OPS },
  {
    field: 'annual_turnover',
    label: 'Declared turnover',
    type: 'money',
    ops: MONEY_OPS,
  },
  {
    field: 'is_related_party',
    label: 'Is related party',
    type: 'boolean',
    ops: BOOL_OPS,
  },
  { field: 'is_msme', label: 'Is MSME', type: 'boolean', ops: BOOL_OPS },
  { field: 'risk_grade', label: 'Risk grade', type: 'enum', ops: ENUM_OPS },
  {
    field: 'has_flagged_screening',
    label: 'Has flagged screening',
    type: 'boolean',
    ops: BOOL_OPS,
  },
  { field: 'source', label: 'Invitation source', type: 'enum', ops: ENUM_OPS },
];

/** Fields mirror `ApprovalContextService.buildVendorChange`. */
const VENDOR_CHANGE_FIELDS: ApprovalFieldDef[] = [
  { field: 'request_type', label: 'Change type', type: 'enum', ops: ENUM_OPS },
  {
    field: 'requires_reverification',
    label: 'Needs re-verification',
    type: 'boolean',
    ops: BOOL_OPS,
  },
  { field: 'category', label: 'Vendor category', type: 'string', ops: STRING_OPS },
];

/** Fields mirror `ApprovalContextService.buildContract`. */
const CONTRACT_FIELDS: ApprovalFieldDef[] = [
  { field: 'total_amount', label: 'Contract value', type: 'money', ops: MONEY_OPS },
  { field: 'contract_type', label: 'Contract type', type: 'enum', ops: ENUM_OPS },
  { field: 'category', label: 'Category', type: 'string', ops: STRING_OPS },
  { field: 'vendor.is_msme', label: 'Vendor is MSME', type: 'boolean', ops: BOOL_OPS },
  { field: 'currency', label: 'Currency', type: 'enum', ops: ENUM_OPS },
];

/** Amendments route on the value of the CHANGE, not the whole contract. */
const CONTRACT_AMENDMENT_FIELDS: ApprovalFieldDef[] = [
  { field: 'total_amount', label: 'Change value', type: 'money', ops: MONEY_OPS },
  { field: 'category', label: 'Category', type: 'string', ops: STRING_OPS },
  { field: 'currency', label: 'Currency', type: 'enum', ops: ENUM_OPS },
];

/** Fields mirror `ApprovalContextService.buildAward`. */
const RFQ_AWARD_FIELDS: ApprovalFieldDef[] = [
  { field: 'total_amount', label: 'Award value', type: 'money', ops: MONEY_OPS },
  { field: 'category', label: 'Category', type: 'string', ops: STRING_OPS },
  { field: 'currency', label: 'Currency', type: 'enum', ops: ENUM_OPS },
];

export const APPROVAL_FIELDS: Partial<Record<DocumentType, ApprovalFieldDef[]>> = {
  INVOICE: INVOICE_FIELDS,
  PAYMENT_RUN: PAYMENT_RUN_FIELDS,
  REQUISITION: REQUISITION_FIELDS,
  PURCHASE_ORDER: PURCHASE_ORDER_FIELDS,
  VENDOR_ONBOARDING: VENDOR_ONBOARDING_FIELDS,
  VENDOR_CHANGE: VENDOR_CHANGE_FIELDS,
  CONTRACT: CONTRACT_FIELDS,
  CONTRACT_AMENDMENT: CONTRACT_AMENDMENT_FIELDS,
  RFQ_AWARD: RFQ_AWARD_FIELDS,
};

/** Document types the approval engine routes end-to-end. GRN is the only
 *  member of `DOCUMENT_TYPE` with no context builder, so it is not routable. */
export const LIVE_APPROVAL_DOC_TYPES: DocumentType[] = [
  'REQUISITION',
  'PURCHASE_ORDER',
  'INVOICE',
  'PAYMENT_RUN',
  'RFQ_AWARD',
  'VENDOR_ONBOARDING',
  'VENDOR_CHANGE',
  'CONTRACT',
  'CONTRACT_AMENDMENT',
];

/** Roles selectable as approval step approvers in the builder. */
export const APPROVER_ROLES: RoleName[] = [
  'DEPT_HEAD',
  'PROCUREMENT_OFFICER',
  'PROCUREMENT_HEAD',
  'PLANT_HEAD',
  'FINANCE_OFFICER',
  'FINANCE_HEAD',
  'LEGAL_OFFICER',
  'MD',
] as RoleName[];
