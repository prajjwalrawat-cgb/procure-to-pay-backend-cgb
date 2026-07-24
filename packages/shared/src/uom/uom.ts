import Decimal from 'decimal.js';

/**
 * Unit-of-measure conversion (Slice 4, Master Context §item-master). PURE.
 *
 * A conversion is a directed edge `from → to` with a multiplicative `factor`
 * (qty_in_to = qty_in_from × factor). Reverse edges are derived automatically
 * (factor⁻¹). A path is found by BFS over the conversion graph, so
 * tonne → bag resolves via the shared kg intermediate even when only
 * tonne → kg and bag → kg are defined.
 */

export interface UomConversion {
  fromUom: string;
  toUom: string;
  /** qty_in_to = qty_in_from × factor. */
  factor: string;
}

/** Thrown when no conversion path exists between two units. */
export class UomConversionError extends Error {
  readonly fromUom: string;
  readonly toUom: string;
  constructor(fromUom: string, toUom: string) {
    super(`No unit conversion path from "${fromUom}" to "${toUom}".`);
    this.name = 'UomConversionError';
    this.fromUom = fromUom;
    this.toUom = toUom;
  }
}

function norm(u: string): string {
  return u.trim().toLowerCase();
}

/**
 * Convert `qty` from `fromUom` to `toUom` using the supplied conversion edges.
 * Returns a decimal string (up to 6 dp). Throws `UomConversionError` if there
 * is no path. Same-unit conversion is the identity.
 */
export function convertQty(
  qty: string | number,
  fromUom: string,
  toUom: string,
  conversions: UomConversion[],
): string {
  const from = norm(fromUom);
  const to = norm(toUom);
  const amount = new Decimal(qty);
  if (from === to) return amount.toFixed(6);

  // Build a bidirectional adjacency list. Each edge yields its inverse too.
  const adjacency = new Map<string, { to: string; factor: Decimal }[]>();
  const addEdge = (a: string, b: string, factor: Decimal): void => {
    const list = adjacency.get(a) ?? [];
    list.push({ to: b, factor });
    adjacency.set(a, list);
  };
  for (const c of conversions) {
    const a = norm(c.fromUom);
    const b = norm(c.toUom);
    const factor = new Decimal(c.factor);
    if (factor.isZero()) continue;
    addEdge(a, b, factor);
    addEdge(b, a, new Decimal(1).dividedBy(factor));
  }

  // BFS carrying the accumulated multiplicative factor.
  const queue: { node: string; factor: Decimal }[] = [
    { node: from, factor: new Decimal(1) },
  ];
  const visited = new Set<string>([from]);
  while (queue.length > 0) {
    const current = queue.shift() as { node: string; factor: Decimal };
    if (current.node === to) return amount.times(current.factor).toFixed(6);
    for (const edge of adjacency.get(current.node) ?? []) {
      if (visited.has(edge.to)) continue;
      visited.add(edge.to);
      queue.push({ node: edge.to, factor: current.factor.times(edge.factor) });
    }
  }

  throw new UomConversionError(fromUom, toUom);
}

/** True when a conversion path (or identity) exists between the two units. */
export function hasConversion(
  fromUom: string,
  toUom: string,
  conversions: UomConversion[],
): boolean {
  try {
    convertQty(1, fromUom, toUom, conversions);
    return true;
  } catch {
    return false;
  }
}
