import type { ActivityItem, ActivityKind, ApprovalPipelineResponse, DocumentType } from '@procureflow/shared';

import { documentHref } from '../approvals/document-href';

/**
 * Pure formatting for the Home command center: activity-feed wording + links,
 * and approval-pipeline stage labelling. Kept free of Prisma so it is unit-tested
 * directly.
 */

/** Audit actions that make it into the Home activity feed. */
export const ACTIVITY_ACTIONS = [
  'APPROVAL_DECIDED',
  'DOCUMENT_APPROVED',
  'SUBMITTED_FOR_APPROVAL',
  'CONTRACT_SUBMITTED_FOR_APPROVAL',
  'BANK_BATCH_CONFIRMED',
  'PAYMENT_RECORDED',
  'GRN_POSTED',
  'PO_ISSUED',
] as const;

/** AuditLog.entityType → routed document type (for hrefs) + a human label. */
const ENTITY: Record<string, { label: string; doc?: DocumentType }> = {
  Requisition: { label: 'Requisition', doc: 'REQUISITION' },
  PurchaseOrder: { label: 'Purchase order', doc: 'PURCHASE_ORDER' },
  GoodsReceiptNote: { label: 'Goods receipt', doc: 'GRN' },
  Invoice: { label: 'Invoice', doc: 'INVOICE' },
  PaymentRun: { label: 'Payment run', doc: 'PAYMENT_RUN' },
  Contract: { label: 'Contract', doc: 'CONTRACT' },
  ContractAmendment: { label: 'Contract amendment', doc: 'CONTRACT_AMENDMENT' },
  Award: { label: 'RFQ award', doc: 'RFQ_AWARD' },
  VendorOnboarding: { label: 'Vendor onboarding', doc: 'VENDOR_ONBOARDING' },
  VendorChangeRequest: { label: 'Vendor change', doc: 'VENDOR_CHANGE' },
};

export function entityLabel(entityType: string): string {
  return ENTITY[entityType]?.label ?? entityType;
}

/** "Rahul Das" → "R. Das"; single names are kept as-is. */
export function shortName(name: string | null | undefined): string | null {
  if (!name) return null;
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return parts[0] || null;
  return `${parts[0]![0]!.toUpperCase()}. ${parts[parts.length - 1]}`;
}

const ACRONYMS = new Set(['GRN', 'PO', 'GST', 'GSTIN', 'TDS', 'MSME', 'OCR', 'IRN', 'PAN', 'UOM', 'HSN']);

/** "PRICE_VARIANCE" → "Price variance"; known acronyms stay upper-case ("GRN missing"). */
export function humanizeEnum(v: string): string {
  return v
    .split('_')
    .map((w, i) => {
      if (ACRONYMS.has(w.toUpperCase())) return w.toUpperCase();
      const l = w.toLowerCase();
      return i === 0 ? l.charAt(0).toUpperCase() + l.slice(1) : l;
    })
    .join(' ');
}

/** A document reference resolved in bulk: its display number and link target. */
export interface DocRef {
  ref: string;
  /** Overrides the id used for the href (a contract amendment links to its contract). */
  hrefId?: string;
}

export interface AuditRowLike {
  id: string;
  timestamp: Date;
  action: string;
  entityType: string;
  entityId: string;
  actorId: string | null;
  actorType: string;
  before: unknown;
  after: unknown;
}

function field(obj: unknown, key: string): unknown {
  return obj && typeof obj === 'object' ? (obj as Record<string, unknown>)[key] : undefined;
}

function hrefFor(entityType: string, id: string): string | null {
  const doc = ENTITY[entityType]?.doc;
  return doc ? documentHref(doc, id) : null;
}

/** Map one allow-listed audit row to a feed item; null for rows that don't belong. */
export function activityFromAudit(
  row: AuditRowLike,
  ref: DocRef | undefined,
  actorName: string | null,
): ActivityItem | null {
  const label = entityLabel(row.entityType);
  const name = ref?.ref ?? label;
  let kind: ActivityKind;
  let title: string;
  switch (row.action) {
    case 'APPROVAL_DECIDED': {
      const decision = field(row.after, 'decision');
      const step = field(row.before, 'stepNo');
      if (decision === 'APPROVED') {
        kind = 'approval';
        title = typeof step === 'number' ? `${name} approved at step ${step}` : `${name} approved`;
      } else if (decision === 'REJECTED') {
        kind = 'rejection';
        title = `${name} rejected`;
      } else if (decision === 'CHANGES_REQUESTED') {
        kind = 'rejection';
        title = `${name} sent back for changes`;
      } else {
        return null;
      }
      break;
    }
    case 'DOCUMENT_APPROVED':
      kind = 'approval';
      title = `${name} fully approved`;
      break;
    case 'SUBMITTED_FOR_APPROVAL':
    case 'CONTRACT_SUBMITTED_FOR_APPROVAL':
      kind = 'submission';
      title = `${name} submitted for approval`;
      break;
    case 'BANK_BATCH_CONFIRMED':
      kind = 'payment';
      title = `${name} confirmed by the bank`;
      break;
    case 'PAYMENT_RECORDED':
      kind = 'payment';
      title = `Payment recorded on ${name}`;
      break;
    case 'GRN_POSTED':
      kind = 'receipt';
      title = `${name} posted`;
      break;
    case 'PO_ISSUED':
      kind = 'order';
      title = `${name} issued to vendor`;
      break;
    default:
      return null;
  }
  const by = actorName ? `by ${actorName}` : row.actorType === 'SYSTEM' ? 'System' : null;
  return {
    id: row.id,
    at: row.timestamp.toISOString(),
    kind,
    title,
    detail: by ? `${by} · ${label}` : label,
    href: hrefFor(row.entityType, ref?.hrefId ?? row.entityId),
  };
}

export interface ExceptionRowLike {
  id: string;
  invoiceId: string;
  exceptionType: string;
  severity: string;
  raisedAt: Date;
}

export function activityFromException(
  row: ExceptionRowLike,
  invoiceRef: string | undefined,
  actorName: string | null,
): ActivityItem {
  return {
    id: row.id,
    at: row.raisedAt.toISOString(),
    kind: 'exception',
    title: `${humanizeEnum(row.exceptionType)} on ${invoiceRef ?? 'invoice'}`,
    detail: `${actorName ? `by ${actorName}` : 'Auto-detected'} · ${humanizeEnum(row.severity)} severity`,
    href: documentHref('INVOICE', row.invoiceId),
  };
}

/**
 * Merge feed sources newest-first and cut to `limit`. `nextBefore` is the
 * timestamp of the last item shown when more exist (each source was fetched
 * with limit + 1), else null.
 */
export function mergeActivity(
  items: ActivityItem[],
  limit: number,
): { items: ActivityItem[]; nextBefore: string | null } {
  const sorted = [...items].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1));
  const page = sorted.slice(0, limit);
  return {
    items: page,
    nextBefore: sorted.length > limit && page.length ? page[page.length - 1]!.at : null,
  };
}

/**
 * Pipeline stages from "documents whose earliest pending step is N" counts.
 * Step ≤ 1 is the "Submitted" stage (always present); every later step with
 * documents waiting becomes its own stage, labelled with the most common step
 * name the tenant's matrices use for that step number ("Step N" if unnamed).
 */
export function buildPipelineStages(
  stepCounts: { step: number; count: number }[],
  stepNames: { step: number; name: string | null; count: number }[],
): ApprovalPipelineResponse['stages'] {
  const submitted = stepCounts.filter((s) => s.step <= 1).reduce((a, s) => a + s.count, 0);
  const later = stepCounts.filter((s) => s.step > 1 && s.count > 0).sort((a, b) => a.step - b.step);
  return [
    { key: 'submitted', label: 'Submitted', count: submitted },
    ...later.map((s) => {
      const best = stepNames
        .filter((x) => x.step === s.step && x.name)
        .sort((a, b) => b.count - a.count || a.name!.localeCompare(b.name!))[0];
      return { key: `step_${s.step}`, label: best?.name ?? `Step ${s.step}`, count: s.count };
    }),
  ];
}
