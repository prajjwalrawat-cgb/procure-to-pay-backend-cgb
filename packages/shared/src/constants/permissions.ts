import { ROLES, type RoleName } from './roles';

/**
 * Permission format: `resource:action[:scope]` (Master Context §5).
 * Scope defaults to `tenant` when omitted.
 */
export const SCOPES = ['own', 'assigned', 'dept', 'plant', 'tenant'] as const;
export type Scope = (typeof SCOPES)[number];

/**
 * The permission catalogue. This is the excerpt from Master Context §5; the
 * full matrix is materialised in seed data. Slice 0 wires the guard against
 * these strings but only auth/health/users routes actually consume them.
 */
export const PERMISSIONS = {
  INVOICE_READ_TENANT: 'invoice:read:tenant',
  INVOICE_READ_ASSIGNED: 'invoice:read:assigned',
  INVOICE_READ_OWN: 'invoice:read:own',
  INVOICE_CREATE: 'invoice:create',
  INVOICE_RESOLVE_EXCEPTION: 'invoice:resolve_exception',
  INVOICE_APPROVE: 'invoice:approve',
  INVOICE_REJECT: 'invoice:reject',
  INVOICE_PAY: 'invoice:pay',

  PAYMENT_RUN_COMPOSE: 'payment_run:compose',
  PAYMENT_RUN_APPROVE: 'payment_run:approve',
  PAYMENT_RUN_SUBMIT_BANK: 'payment_run:submit_bank',

  // Requisitions (Slice 4)
  REQUISITION_CREATE: 'requisition:create',
  REQUISITION_READ_TENANT: 'requisition:read:tenant',
  REQUISITION_READ_OWN: 'requisition:read:own',
  REQUISITION_UPDATE: 'requisition:update',
  REQUISITION_SUBMIT: 'requisition:submit',
  REQUISITION_CANCEL: 'requisition:cancel',

  // Purchase orders (Slice 4)
  PURCHASE_ORDER_READ_TENANT: 'purchase_order:read:tenant',
  PURCHASE_ORDER_CREATE: 'purchase_order:create',
  PURCHASE_ORDER_UPDATE: 'purchase_order:update',
  PURCHASE_ORDER_ISSUE: 'purchase_order:issue',
  PURCHASE_ORDER_CANCEL: 'purchase_order:cancel',
  PURCHASE_ORDER_SPOT_BUY: 'procurement_order:spot_buy',

  // Item master (Slice 4)
  ITEM_READ: 'item:read',
  ITEM_CREATE: 'item:create',
  ITEM_UPDATE: 'item:update',

  // Budgets (Slice 4)
  BUDGET_READ: 'budget:read',

  // Goods receipt / stores / QC (Slice 5)
  GRN_READ: 'grn:read',
  STORES_RECEIVE_GOODS: 'stores:receive_goods',
  STORES_REVERSE_GRN: 'stores:reverse_grn',
  QC_INSPECT: 'qc:inspect',
  QC_WAIVE: 'qc:waive',
  RMA_READ: 'rma:read',
  RMA_MANAGE: 'rma:manage',
  STOCK_READ: 'stock:read',

  // Vendor-portal GRN/RMA actions (Slice 5, vendor JWT audience)
  VENDOR_GRN_READ: 'vendor_grn:read',
  VENDOR_RMA_READ: 'vendor_rma:read',
  VENDOR_RMA_SCHEDULE_PICKUP: 'vendor_rma:schedule_pickup',

  // Vendor-portal PO actions (Slice 4, vendor JWT audience)
  VENDOR_PO_READ: 'vendor_purchase_order:read',
  VENDOR_PO_ACKNOWLEDGE: 'vendor_purchase_order:acknowledge',
  VENDOR_PO_QUERY: 'vendor_purchase_order:query',

  // Sourcing / RFQ (Slice 6)
  SOURCING_READ: 'sourcing:read',
  SOURCING_MANAGE: 'sourcing:manage',
  SOURCING_OPEN_QUOTES: 'sourcing:open_quotes',
  SOURCING_EVALUATE: 'sourcing:evaluate',
  SOURCING_AWARD: 'sourcing:award',

  // Vendor-portal sourcing actions (Slice 6, vendor JWT audience)
  VENDOR_RFQ_READ: 'vendor_rfq:read',
  VENDOR_QUOTE_MANAGE: 'vendor_quote:manage',

  // Vendor master / onboarding (Slice 7, buyer side)
  VENDOR_READ: 'vendor:read',
  VENDOR_INVITE: 'vendor:invite',
  VENDOR_UPDATE: 'vendor:update',
  VENDOR_ONBOARDING_REVIEW: 'vendor:onboarding_review',
  VENDOR_DOC_VERIFY: 'vendor:doc_verify',
  VENDOR_SCREENING_REVIEW: 'vendor:screening_review',
  VENDOR_SUSPEND: 'vendor:suspend',
  VENDOR_BLACKLIST: 'vendor:blacklist',
  VENDOR_CHANGE_APPROVE: 'vendor:change_approve',
  VENDOR_SCORECARD_READ: 'vendor:scorecard_read',

  // Vendor-portal onboarding actions (Slice 7, vendor JWT audience)
  VENDOR_ONBOARDING_MANAGE: 'vendor_onboarding:manage',

  APPROVAL_MATRIX_READ: 'approval_matrix:read',
  APPROVAL_MATRIX_WRITE: 'approval_matrix:write',

  // Dynamic, document-level approval actions (Slice 2). The *right to be routed*
  // is decided by the matrix; these gate access to the inbox + decision routes.
  APPROVAL_READ: 'approval:read',
  APPROVAL_DECIDE: 'approval:decide',
  APPROVAL_DELEGATE: 'approval:delegate',

  AUDIT_LOG_READ: 'audit_log:read',
  AUDIT_LOG_WRITE: 'audit_log:write',

  USER_READ: 'user:read',
  USER_CREATE: 'user:create',
  USER_UPDATE: 'user:update',

  // Analytics (Slice 8)
  ANALYTICS_READ: 'analytics:read',
  ANALYTICS_MANAGE: 'analytics:manage', // manual refresh + avoided-cost entry
  ANALYTICS_VIEW_BUYER_LEADERBOARD: 'analytics:view_buyer_leaderboard',

  // Contracts (Slice 9)
  CONTRACT_READ: 'contract:read',
  CONTRACT_CREATE: 'contract:create', // draft create + update + clause edits
  CONTRACT_SUBMIT: 'contract:submit',
  CONTRACT_EXECUTE: 'contract:execute',
  CONTRACT_AMEND: 'contract:amend',
  CONTRACT_RENEW: 'contract:renew',
  CONTRACT_TERMINATE: 'contract:terminate',
  CONTRACT_CALL_OFF: 'contract:call_off',
  CONTRACT_ESCALATION_MANAGE: 'contract:escalation_manage', // enter index values
  CLAUSE_LIBRARY_READ: 'clause_library:read',
  CLAUSE_LIBRARY_MANAGE: 'clause_library:manage',

  // Vendor-portal contract actions (Slice 9, vendor JWT audience)
  VENDOR_CONTRACT_READ: 'vendor_contract:read',
  VENDOR_CONTRACT_COUNTERSIGN: 'vendor_contract:countersign',

  // Integrations (Slice 10)
  INTEGRATION_READ: 'integration:read', // usage log + credential status
  INTEGRATION_MANAGE: 'integration:manage', // set credentials, trigger jobs
  INVOICE_INTAKE_MANAGE: 'invoice:intake_manage', // email queues + manual OCR review
  COMPLIANCE_RUN: 'compliance:run', // trigger GSTR-2B recon / IRN validate

  // Inventory management (Slice 12). Receipts and QC deliberately reuse the
  // Slice 5 stores/QC permissions rather than minting parallel ones — the same
  // people do both jobs.
  INVENTORY_READ: 'inventory:read', // stock overview, ledger, reports
  INVENTORY_PRODUCT_MANAGE: 'inventory:product_manage', // product + location catalogue
  INVENTORY_IMPORT: 'inventory:import', // bulk upload + quarantine resolution
  INVENTORY_ISSUE: 'inventory:issue', // internal issue / return (photoshoot, sales, other)
  INVENTORY_FULFILL: 'inventory:fulfill', // customer order-out + customer return intake
  INVENTORY_ADJUST: 'inventory:adjust', // damage write-off, adjustments, corrections
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/**
 * Static role → permission grants (Master Context §5 excerpt). Dynamic,
 * document-level approval permissions (`invoice:approve`, etc.) are resolved
 * from the approval matrix at approval time, not from this table.
 */
/** Read access to procurement documents (PR/PO/item/budget) — Slice 4. */
const PROCURE_READ: Permission[] = [
  PERMISSIONS.REQUISITION_READ_TENANT,
  PERMISSIONS.PURCHASE_ORDER_READ_TENANT,
  PERMISSIONS.ITEM_READ,
  PERMISSIONS.BUDGET_READ,
  PERMISSIONS.GRN_READ,
  PERMISSIONS.RMA_READ,
  PERMISSIONS.STOCK_READ,
  PERMISSIONS.INVENTORY_READ,
];

/**
 * Warehouse floor authority (Slice 12). Receiving and QC are NOT here — they
 * stay on the Slice 5 `stores:receive_goods` / `qc:inspect` permissions so a
 * single grant governs both the formal GRN flow and the inventory ledger.
 */
const INVENTORY_OPS: Permission[] = [
  PERMISSIONS.INVENTORY_READ,
  PERMISSIONS.INVENTORY_PRODUCT_MANAGE,
  PERMISSIONS.INVENTORY_IMPORT,
  PERMISSIONS.INVENTORY_ISSUE,
  PERMISSIONS.INVENTORY_FULFILL,
  PERMISSIONS.INVENTORY_ADJUST,
];

/** Raise + manage own requisitions — Slice 4. */
const REQUISITION_AUTHOR: Permission[] = [
  PERMISSIONS.REQUISITION_CREATE,
  PERMISSIONS.REQUISITION_READ_OWN,
  PERMISSIONS.REQUISITION_UPDATE,
  PERMISSIONS.REQUISITION_SUBMIT,
  PERMISSIONS.REQUISITION_CANCEL,
  PERMISSIONS.ITEM_READ,
  PERMISSIONS.BUDGET_READ,
];

/** Sourcing authority for procurement (Slice 6). */
const SOURCING: Permission[] = [
  PERMISSIONS.SOURCING_READ,
  PERMISSIONS.SOURCING_MANAGE,
  PERMISSIONS.SOURCING_OPEN_QUOTES,
  PERMISSIONS.SOURCING_EVALUATE,
  PERMISSIONS.SOURCING_AWARD,
];

/** Vendor master read + scorecard, granted broadly (Slice 7). */
const VENDOR_READ_ONLY: Permission[] = [
  PERMISSIONS.VENDOR_READ,
  PERMISSIONS.VENDOR_SCORECARD_READ,
];

/** Vendor onboarding + master management authority (Slice 7). */
const VENDOR_MASTER: Permission[] = [
  PERMISSIONS.VENDOR_READ,
  PERMISSIONS.VENDOR_INVITE,
  PERMISSIONS.VENDOR_UPDATE,
  PERMISSIONS.VENDOR_ONBOARDING_REVIEW,
  PERMISSIONS.VENDOR_DOC_VERIFY,
  PERMISSIONS.VENDOR_SCREENING_REVIEW,
  PERMISSIONS.VENDOR_CHANGE_APPROVE,
  PERMISSIONS.VENDOR_SCORECARD_READ,
];

/** Full purchasing authority (PO create/issue/cancel + spot buy) — Slice 4. */
const PURCHASING: Permission[] = [
  PERMISSIONS.REQUISITION_CREATE,
  PERMISSIONS.REQUISITION_READ_TENANT,
  PERMISSIONS.PURCHASE_ORDER_READ_TENANT,
  PERMISSIONS.PURCHASE_ORDER_CREATE,
  PERMISSIONS.PURCHASE_ORDER_UPDATE,
  PERMISSIONS.PURCHASE_ORDER_ISSUE,
  PERMISSIONS.PURCHASE_ORDER_CANCEL,
  PERMISSIONS.PURCHASE_ORDER_SPOT_BUY,
  PERMISSIONS.ITEM_READ,
  PERMISSIONS.BUDGET_READ,
  PERMISSIONS.GRN_READ,
  PERMISSIONS.RMA_READ,
  PERMISSIONS.RMA_MANAGE,
  PERMISSIONS.STOCK_READ,
];

/** Analytics management authority — read + manual refresh + buyer leaderboard (Slice 8). */
const ANALYTICS_ADMIN: Permission[] = [
  PERMISSIONS.ANALYTICS_READ,
  PERMISSIONS.ANALYTICS_MANAGE,
  PERMISSIONS.ANALYTICS_VIEW_BUYER_LEADERBOARD,
];

/** Read-only contract access, granted broadly for transparency (Slice 9). */
const CONTRACT_READ_ONLY: Permission[] = [
  PERMISSIONS.CONTRACT_READ,
  PERMISSIONS.CLAUSE_LIBRARY_READ,
];

/** Full contract lifecycle authority (Slice 9). Terminate/clause-library are
 *  granted separately (terminate needs legal cosign; library edits are legal). */
const CONTRACT_MANAGE: Permission[] = [
  PERMISSIONS.CONTRACT_READ,
  PERMISSIONS.CONTRACT_CREATE,
  PERMISSIONS.CONTRACT_SUBMIT,
  PERMISSIONS.CONTRACT_EXECUTE,
  PERMISSIONS.CONTRACT_AMEND,
  PERMISSIONS.CONTRACT_RENEW,
  PERMISSIONS.CONTRACT_CALL_OFF,
  PERMISSIONS.CLAUSE_LIBRARY_READ,
];

export const ROLE_PERMISSIONS: Record<RoleName, Permission[]> = {
  [ROLES.SYSADMIN]: Object.values(PERMISSIONS),
  [ROLES.TENANT_ADMIN]: [
    ...ANALYTICS_ADMIN,
    ...CONTRACT_MANAGE,
    PERMISSIONS.CONTRACT_TERMINATE,
    PERMISSIONS.CONTRACT_ESCALATION_MANAGE,
    PERMISSIONS.CLAUSE_LIBRARY_MANAGE,
    PERMISSIONS.INTEGRATION_READ,
    PERMISSIONS.INTEGRATION_MANAGE,
    PERMISSIONS.INVOICE_INTAKE_MANAGE,
    PERMISSIONS.COMPLIANCE_RUN,
    ...SOURCING,
    PERMISSIONS.INVOICE_READ_TENANT,
    PERMISSIONS.APPROVAL_MATRIX_READ,
    PERMISSIONS.APPROVAL_MATRIX_WRITE,
    PERMISSIONS.APPROVAL_READ,
    PERMISSIONS.APPROVAL_DECIDE,
    PERMISSIONS.APPROVAL_DELEGATE,
    PERMISSIONS.AUDIT_LOG_READ,
    PERMISSIONS.USER_READ,
    PERMISSIONS.USER_CREATE,
    PERMISSIONS.USER_UPDATE,
    ...PURCHASING,
    ...VENDOR_MASTER,
    PERMISSIONS.VENDOR_SUSPEND,
    PERMISSIONS.VENDOR_BLACKLIST,
    PERMISSIONS.REQUISITION_UPDATE,
    PERMISSIONS.REQUISITION_SUBMIT,
    PERMISSIONS.REQUISITION_CANCEL,
    PERMISSIONS.ITEM_CREATE,
    PERMISSIONS.ITEM_UPDATE,
    ...INVENTORY_OPS,
  ],
  [ROLES.REQUESTER]: [
    PERMISSIONS.INVOICE_READ_OWN,
    PERMISSIONS.APPROVAL_MATRIX_READ,
    ...REQUISITION_AUTHOR,
  ],
  [ROLES.DEPT_HEAD]: [
    PERMISSIONS.INVOICE_READ_ASSIGNED,
    PERMISSIONS.APPROVAL_MATRIX_READ,
    PERMISSIONS.APPROVAL_READ,
    PERMISSIONS.APPROVAL_DECIDE,
    PERMISSIONS.APPROVAL_DELEGATE,
    ...PROCURE_READ,
    PERMISSIONS.REQUISITION_CREATE,
  ],
  [ROLES.PROCUREMENT_OFFICER]: [
    PERMISSIONS.ANALYTICS_READ,
    PERMISSIONS.INVOICE_READ_ASSIGNED,
    PERMISSIONS.INVOICE_RESOLVE_EXCEPTION,
    PERMISSIONS.APPROVAL_MATRIX_READ,
    PERMISSIONS.APPROVAL_READ,
    PERMISSIONS.APPROVAL_DECIDE,
    PERMISSIONS.APPROVAL_DELEGATE,
    ...PURCHASING,
    ...SOURCING,
    ...VENDOR_MASTER,
    ...CONTRACT_MANAGE,
  ],
  [ROLES.PROCUREMENT_HEAD]: [
    ...ANALYTICS_ADMIN,
    ...CONTRACT_MANAGE,
    PERMISSIONS.CONTRACT_TERMINATE,
    PERMISSIONS.INVOICE_READ_ASSIGNED,
    PERMISSIONS.INVOICE_RESOLVE_EXCEPTION,
    PERMISSIONS.APPROVAL_MATRIX_READ,
    PERMISSIONS.APPROVAL_READ,
    PERMISSIONS.APPROVAL_DECIDE,
    PERMISSIONS.APPROVAL_DELEGATE,
    ...PURCHASING,
    ...SOURCING,
    ...VENDOR_MASTER,
    PERMISSIONS.VENDOR_SUSPEND,
    PERMISSIONS.ITEM_CREATE,
    PERMISSIONS.ITEM_UPDATE,
    PERMISSIONS.REQUISITION_UPDATE,
    PERMISSIONS.REQUISITION_SUBMIT,
    PERMISSIONS.REQUISITION_CANCEL,
    ...INVENTORY_OPS,
  ],
  [ROLES.PLANT_HEAD]: [
    PERMISSIONS.ANALYTICS_READ,
    PERMISSIONS.SOURCING_READ,
    PERMISSIONS.SOURCING_OPEN_QUOTES,
    PERMISSIONS.INVOICE_READ_ASSIGNED,
    PERMISSIONS.APPROVAL_MATRIX_READ,
    PERMISSIONS.APPROVAL_READ,
    PERMISSIONS.APPROVAL_DECIDE,
    PERMISSIONS.APPROVAL_DELEGATE,
    // Plant head authorises over-receipt, reverses posted GRNs, co-signs QC waivers.
    PERMISSIONS.STORES_RECEIVE_GOODS,
    PERMISSIONS.STORES_REVERSE_GRN,
    PERMISSIONS.QC_INSPECT,
    PERMISSIONS.QC_WAIVE,
    PERMISSIONS.RMA_MANAGE,
    ...PROCURE_READ,
    ...CONTRACT_READ_ONLY,
    // Plant head authorises high-value internal issues and signs off write-offs.
    PERMISSIONS.INVENTORY_ISSUE,
    PERMISSIONS.INVENTORY_ADJUST,
  ],
  [ROLES.FINANCE_OFFICER]: [
    PERMISSIONS.ANALYTICS_READ,
    PERMISSIONS.INVOICE_READ_TENANT,
    PERMISSIONS.INVOICE_CREATE,
    PERMISSIONS.INVOICE_RESOLVE_EXCEPTION,
    PERMISSIONS.INVOICE_PAY,
    PERMISSIONS.PAYMENT_RUN_COMPOSE,
    PERMISSIONS.APPROVAL_MATRIX_READ,
    PERMISSIONS.APPROVAL_READ,
    PERMISSIONS.APPROVAL_DECIDE,
    PERMISSIONS.APPROVAL_DELEGATE,
    // Finance records credit notes and closes RMAs.
    PERMISSIONS.RMA_MANAGE,
    // AP owns the invoice intake queues + compliance reconciliation (Slice 10a).
    PERMISSIONS.INVOICE_INTAKE_MANAGE,
    PERMISSIONS.COMPLIANCE_RUN,
    PERMISSIONS.INTEGRATION_READ,
    ...PROCURE_READ,
    ...CONTRACT_READ_ONLY,
  ],
  [ROLES.FINANCE_HEAD]: [
    PERMISSIONS.ANALYTICS_READ,
    PERMISSIONS.ANALYTICS_MANAGE,
    PERMISSIONS.SOURCING_READ,
    PERMISSIONS.SOURCING_OPEN_QUOTES,
    PERMISSIONS.SOURCING_AWARD,
    PERMISSIONS.INVOICE_READ_TENANT,
    PERMISSIONS.INVOICE_PAY,
    PERMISSIONS.PAYMENT_RUN_APPROVE,
    PERMISSIONS.PAYMENT_RUN_SUBMIT_BANK,
    PERMISSIONS.APPROVAL_MATRIX_READ,
    PERMISSIONS.APPROVAL_MATRIX_WRITE,
    PERMISSIONS.APPROVAL_READ,
    PERMISSIONS.APPROVAL_DECIDE,
    PERMISSIONS.APPROVAL_DELEGATE,
    PERMISSIONS.AUDIT_LOG_READ,
    PERMISSIONS.COMPLIANCE_RUN,
    PERMISSIONS.INTEGRATION_READ,
    ...VENDOR_READ_ONLY,
    ...PROCURE_READ,
    ...CONTRACT_READ_ONLY,
  ],
  [ROLES.STORES_OFFICER]: [
    PERMISSIONS.APPROVAL_MATRIX_READ,
    PERMISSIONS.STORES_RECEIVE_GOODS,
    PERMISSIONS.RMA_MANAGE,
    ...PROCURE_READ,
    // The warehouse floor runs the inventory module day to day (Slice 12).
    ...INVENTORY_OPS,
  ],
  [ROLES.QC_OFFICER]: [
    PERMISSIONS.APPROVAL_MATRIX_READ,
    PERMISSIONS.QC_INSPECT,
    ...PROCURE_READ,
  ],
  [ROLES.LEGAL_OFFICER]: [
    PERMISSIONS.APPROVAL_MATRIX_READ,
    PERMISSIONS.APPROVAL_READ,
    PERMISSIONS.APPROVAL_DECIDE,
    PERMISSIONS.APPROVAL_DELEGATE,
    // Legal reviews compliance screenings and co-signs blacklisting (Slice 7).
    PERMISSIONS.VENDOR_READ,
    PERMISSIONS.VENDOR_SCREENING_REVIEW,
    PERMISSIONS.VENDOR_BLACKLIST,
    ...PROCURE_READ,
    // Legal governs the clause library, co-signs early termination, and is a
    // routed contract approver (Slice 9).
    ...CONTRACT_READ_ONLY,
    PERMISSIONS.CLAUSE_LIBRARY_MANAGE,
    PERMISSIONS.CONTRACT_TERMINATE,
  ],
  [ROLES.AUDITOR]: [
    PERMISSIONS.ANALYTICS_READ,
    PERMISSIONS.SOURCING_READ,
    PERMISSIONS.INVOICE_READ_TENANT,
    PERMISSIONS.AUDIT_LOG_READ,
    PERMISSIONS.APPROVAL_MATRIX_READ,
    PERMISSIONS.APPROVAL_READ,
    ...VENDOR_READ_ONLY,
    ...PROCURE_READ,
    ...CONTRACT_READ_ONLY,
  ],
  [ROLES.MD]: [
    PERMISSIONS.ANALYTICS_READ,
    PERMISSIONS.SOURCING_READ,
    PERMISSIONS.SOURCING_AWARD,
    PERMISSIONS.INVOICE_READ_TENANT,
    PERMISSIONS.INVOICE_PAY,
    PERMISSIONS.PAYMENT_RUN_APPROVE,
    PERMISSIONS.APPROVAL_MATRIX_READ,
    PERMISSIONS.APPROVAL_READ,
    PERMISSIONS.APPROVAL_DECIDE,
    PERMISSIONS.APPROVAL_DELEGATE,
    // MD imposes/overturns blacklist and suspension (Slice 7).
    ...VENDOR_READ_ONLY,
    PERMISSIONS.VENDOR_SUSPEND,
    PERMISSIONS.VENDOR_BLACKLIST,
    ...PROCURE_READ,
    ...CONTRACT_READ_ONLY,
  ],
  [ROLES.VENDOR_USER]: [
    PERMISSIONS.VENDOR_RFQ_READ,
    PERMISSIONS.VENDOR_QUOTE_MANAGE,
    PERMISSIONS.VENDOR_ONBOARDING_MANAGE,
    PERMISSIONS.INVOICE_CREATE,
    PERMISSIONS.VENDOR_PO_READ,
    PERMISSIONS.VENDOR_PO_ACKNOWLEDGE,
    PERMISSIONS.VENDOR_PO_QUERY,
    PERMISSIONS.VENDOR_GRN_READ,
    PERMISSIONS.VENDOR_RMA_READ,
    PERMISSIONS.VENDOR_RMA_SCHEDULE_PICKUP,
    PERMISSIONS.VENDOR_CONTRACT_READ,
    PERMISSIONS.VENDOR_CONTRACT_COUNTERSIGN,
  ],
};
