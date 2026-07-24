import Decimal from 'decimal.js';

/**
 * Approval conditions DSL evaluator (Slice 2).
 *
 * A PURE function — no I/O, no Prisma, no clock. Given a condition tree and a
 * flat/nested document context, it returns whether the condition matched plus a
 * step-by-step trace used by the matrix builder's "Test with sample" view.
 *
 * The same evaluator runs on the backend (routing + simulate) and is unit-tested
 * to full coverage here so the routing engine can trust it.
 */

export const CONDITION_OPS = [
  'eq',
  'ne',
  'lt',
  'lte',
  'gt',
  'gte',
  'in',
  'nin',
  'contains',
] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

/** Recursive condition node. A node is either a group (all/any/none) or a leaf. */
export interface Condition {
  all?: Condition[];
  any?: Condition[];
  none?: Condition[];
  field?: string;
  op?: ConditionOp;
  value?: unknown;
}

/** Max nesting depth allowed for a condition tree (root = depth 1). */
export const MAX_CONDITION_DEPTH = 4;

export interface EvalStep {
  /** Dotted path to this node in the tree, e.g. "all[0].any[1]". */
  path: string;
  kind: 'all' | 'any' | 'none' | 'leaf' | 'empty';
  field?: string;
  op?: ConditionOp;
  value?: unknown;
  /** Resolved value from the context for a leaf node. */
  actual?: unknown;
  matched: boolean;
}

export interface EvalResult {
  matched: boolean;
  trace: EvalStep[];
}

/** The document context a condition is evaluated against. Fields are resolved
 *  by dotted path (e.g. `vendor.is_msme`). */
export type ApprovalContextValue =
  string | number | boolean | null | undefined | ApprovalContext | ApprovalContextValue[];

export interface ApprovalContext {
  [key: string]: ApprovalContextValue;
}

/** Compute the nesting depth of a condition tree (root node counts as 1). */
export function conditionDepth(cond: Condition): number {
  const children = [...(cond.all ?? []), ...(cond.any ?? []), ...(cond.none ?? [])];
  if (children.length === 0) return 1;
  return 1 + Math.max(...children.map((c) => conditionDepth(c)));
}

/** Resolve a dotted path from the context. Returns `undefined` when missing. */
export function resolveField(ctx: ApprovalContext, field: string): unknown {
  const parts = field.split('.');
  let current: unknown = ctx;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Evaluate a condition tree against a context, collecting a trace. */
export function evaluateConditions(cond: Condition, ctx: ApprovalContext): EvalResult {
  const trace: EvalStep[] = [];
  const matched = evalNode(cond, ctx, 'root', trace);
  return { matched, trace };
}

function evalNode(
  cond: Condition,
  ctx: ApprovalContext,
  path: string,
  trace: EvalStep[],
): boolean {
  const hasAll = Array.isArray(cond.all);
  const hasAny = Array.isArray(cond.any);
  const hasNone = Array.isArray(cond.none);
  const isLeaf = cond.field !== undefined && cond.op !== undefined;

  // A group node combines its listed sub-groups with AND semantics between the
  // three keys (all AND any AND none), matching a natural reading of the DSL.
  if (hasAll || hasAny || hasNone) {
    const results: boolean[] = [];

    if (hasAll) {
      const children = cond.all ?? [];
      const childResults = children.map((c, i) =>
        evalNode(c, ctx, `${path}.all[${i}]`, trace),
      );
      const ok = childResults.every(Boolean);
      trace.push({ path: `${path}.all`, kind: 'all', matched: ok });
      results.push(ok);
    }
    if (hasAny) {
      const children = cond.any ?? [];
      const childResults = children.map((c, i) =>
        evalNode(c, ctx, `${path}.any[${i}]`, trace),
      );
      const ok = childResults.length === 0 ? false : childResults.some(Boolean);
      trace.push({ path: `${path}.any`, kind: 'any', matched: ok });
      results.push(ok);
    }
    if (hasNone) {
      const children = cond.none ?? [];
      const childResults = children.map((c, i) =>
        evalNode(c, ctx, `${path}.none[${i}]`, trace),
      );
      const ok = !childResults.some(Boolean);
      trace.push({ path: `${path}.none`, kind: 'none', matched: ok });
      results.push(ok);
    }

    return results.every(Boolean);
  }

  if (isLeaf) {
    const actual = resolveField(ctx, cond.field as string);
    const ok = evalLeaf(cond.op as ConditionOp, actual, cond.value);
    trace.push({
      path,
      kind: 'leaf',
      field: cond.field,
      op: cond.op,
      value: cond.value,
      actual,
      matched: ok,
    });
    return ok;
  }

  // Empty node (no group keys, no leaf) — treated as a vacuous match so a rule
  // with `conditions: {}` applies to everything.
  trace.push({ path, kind: 'empty', matched: true });
  return true;
}

function evalLeaf(op: ConditionOp, actual: unknown, value: unknown): boolean {
  switch (op) {
    case 'eq':
      return looseEquals(actual, value);
    case 'ne':
      return !looseEquals(actual, value);
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return compareNumeric(op, actual, value);
    case 'in':
      return Array.isArray(value) && value.some((v) => looseEquals(actual, v));
    case 'nin':
      return Array.isArray(value) && !value.some((v) => looseEquals(actual, v));
    case 'contains':
      return evalContains(actual, value);
    default:
      return false;
  }
}

function evalContains(actual: unknown, value: unknown): boolean {
  if (Array.isArray(actual)) return actual.some((v) => looseEquals(v, value));
  if (typeof actual === 'string') return actual.includes(String(value));
  return false;
}

/** Numeric-aware equality: money/number strings compare by value, else strict. */
function looseEquals(a: unknown, b: unknown): boolean {
  if (isNumeric(a) && isNumeric(b)) {
    return new Decimal(a as Decimal.Value).equals(new Decimal(b as Decimal.Value));
  }
  return a === b;
}

function compareNumeric(
  op: 'lt' | 'lte' | 'gt' | 'gte',
  actual: unknown,
  value: unknown,
): boolean {
  if (!isNumeric(actual) || !isNumeric(value)) return false;
  const a = new Decimal(actual as Decimal.Value);
  const b = new Decimal(value as Decimal.Value);
  switch (op) {
    case 'lt':
      return a.lessThan(b);
    case 'lte':
      return a.lessThanOrEqualTo(b);
    case 'gt':
      return a.greaterThan(b);
    case 'gte':
      return a.greaterThanOrEqualTo(b);
  }
}

function isNumeric(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string' && v.trim() !== '') return /^-?\d+(\.\d+)?$/.test(v.trim());
  return false;
}
