/**
 * System roles (Master Context §5). These names are the canonical source used
 * by the seed script, the RBAC guard, and the approval matrix.
 */
export const ROLES = {
  SYSADMIN: 'SYSADMIN',
  TENANT_ADMIN: 'TENANT_ADMIN',
  REQUESTER: 'REQUESTER',
  DEPT_HEAD: 'DEPT_HEAD',
  PROCUREMENT_OFFICER: 'PROCUREMENT_OFFICER',
  PROCUREMENT_HEAD: 'PROCUREMENT_HEAD',
  PLANT_HEAD: 'PLANT_HEAD',
  FINANCE_OFFICER: 'FINANCE_OFFICER',
  FINANCE_HEAD: 'FINANCE_HEAD',
  STORES_OFFICER: 'STORES_OFFICER',
  QC_OFFICER: 'QC_OFFICER',
  LEGAL_OFFICER: 'LEGAL_OFFICER',
  AUDITOR: 'AUDITOR',
  MD: 'MD',
  VENDOR_USER: 'VENDOR_USER',
} as const;

export type RoleName = (typeof ROLES)[keyof typeof ROLES];

export const ALL_ROLES: RoleName[] = Object.values(ROLES);

/** Role descriptions mirror the Master Context §5 table (used in seed + admin UI later). */
export const ROLE_DESCRIPTIONS: Record<RoleName, string> = {
  SYSADMIN:
    'Vizionforge internal — cross-tenant, break-glass. Never provisioned to customers.',
  TENANT_ADMIN:
    'Customer super-admin. Manages users, cost centers, approval matrix, integrations.',
  REQUESTER:
    'Any employee who creates PRs. Read own PRs, own invoices for reimbursement.',
  DEPT_HEAD: 'Approves PRs at dept level. Reads dept-scoped data.',
  PROCUREMENT_OFFICER: 'Handles RFQ, sourcing, PO creation.',
  PROCUREMENT_HEAD: 'Lead procurement, approves POs above dept-head threshold.',
  PLANT_HEAD: 'Approves plant-level POs, invoices above threshold.',
  FINANCE_OFFICER: 'Processes invoices, resolves exceptions, composes payment runs.',
  FINANCE_HEAD: 'Approves payment runs, approves invoices above threshold.',
  STORES_OFFICER: 'Creates GRNs on receipt.',
  QC_OFFICER: 'QC pass/fail on GRN lines.',
  LEGAL_OFFICER: 'Contract review, clause approval.',
  AUDITOR: 'Read-only across finance + procurement. Cannot mutate.',
  MD: 'Approves above CFO threshold (default > ₹50L).',
  VENDOR_USER: 'External. Uses vendor portal only. Separate JWT audience.',
};
