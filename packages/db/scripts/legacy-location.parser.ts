/**
 * Location/carton free-text parser for the legacy Artbox workbook (Slice 12).
 *
 * The workbook records where stock physically sits across two columns that only
 * make sense read together:
 *
 *   Location = "Confrance Room & Store"
 *   Rack No. = "(Confrance Room Me Toal Carton -3, Qty-750) (Store me Mandir ke
 *               samne carton no.-14 Qty.-200)"
 *
 * Note this contradicts the build prompt, which says the carton/qty splits live
 * in the Remark column — they do not. `Remark` is blank on 563 of the 625 rows;
 * the splits are in `Rack No.`.
 *
 * The text is Hinglish, inconsistently spelled ("Confrance", "Toal Carton",
 * "Mandir ke samne"), so this is a deliberately conservative heuristic: it
 * resolves what it can prove and flags the rest for human review rather than
 * guessing. Roughly 40 of the 625 rows need review.
 */

/** One resolved placement of a product's stock. */
export interface ParsedPlacement {
  locationName: string;
  rackOrCarton: string | null;
  /** Null when the text names the location but not how much sits there. */
  qty: number | null;
}

export interface LocationParseResult {
  placements: ParsedPlacement[];
  /** True when a human should check this row before it is trusted. */
  needsReview: boolean;
  reviewReason: string | null;
}

/**
 * Canonical spellings for the three physical locations in the workbook, keyed by
 * the variants actually observed. "Confrance" is the sheet's own spelling.
 */
const LOCATION_ALIASES: { match: RegExp; canonical: string }[] = [
  // The sheet spells it "Confrance", "Confrance room" and — inside the rack
  // notes — bare "cofrance me" with no "Room" at all, so the word alone has to
  // be enough to match.
  { match: /c[o0]n?f?r?ance|conference/i, canonical: 'Conference Room' },
  { match: /(^|[^a-z])-?b2([^0-9a-z]|$)/i, canonical: '-B2' },
  { match: /store/i, canonical: 'Store' },
];

/** Where stock goes when the sheet says nothing usable. */
export const UNASSIGNED_LOCATION = 'Unassigned';

/** Resolve a free-text fragment to a canonical location, or null. */
export function canonicalLocation(text: string): string | null {
  const t = text.trim();
  if (!t || /^n\/?a$/i.test(t)) return null;
  for (const { match, canonical } of LOCATION_ALIASES) {
    if (match.test(t)) return canonical;
  }
  return null;
}

/**
 * Pull a quantity out of a fragment. Matches the observed spellings:
 * "Qty-750", "Qty.-200", "750pcs", "20 pcs", "(238)".
 */
export function extractQty(fragment: string): number | null {
  const patterns = [
    /qty\.?\s*[-:]?\s*(\d+)/i,
    // "pic" is the sheet's own recurring misspelling of "pcs".
    /(\d+)\s*p(?:cs?|ic)\b/i,
    /(\d+)\s*nos?\b/i,
    /\((\d+)\)/,
  ];
  for (const p of patterns) {
    const m = p.exec(fragment);
    if (m?.[1]) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

/**
 * Read a quantity written as a bare suffix on a Location cell, which is how the
 * sheet encodes "Confrance Room-600 & -B2-205". Deliberately separate from
 * `extractQty`: applied to rack text it would read "Carton-14" as a quantity,
 * so it is only ever used on the Location column. Requires two or more digits
 * at the end of the fragment, which "-B2" alone does not satisfy.
 */
export function extractInlineLocationQty(fragment: string): number | null {
  const m = /-\s*(\d{2,})\s*$/.exec(fragment.trim());
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Pull a carton/rack designator: "Carton-3", "carton no.-14", "Rack-6", "R-8". */
export function extractRackOrCarton(fragment: string): string | null {
  const carton = /carton\s*(?:no\.?)?\s*[-:]?\s*(\d+)/i.exec(fragment);
  if (carton?.[1]) return `Carton-${carton[1]}`;

  const rack = /\b(?:rack|r)\s*[-:]?\s*(\d+)/i.exec(fragment);
  if (rack?.[1]) return `Rack-${rack[1]}`;

  const named = /\b(almirah|big suitcase|candle box|mix box|mandir ke samne)\b/i.exec(fragment);
  if (named?.[1]) {
    return named[1].replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return null;
}

/**
 * Split the Rack No. text into per-location fragments. The workbook uses
 * parentheses for explicit grouping — "(Confrance room me ... 20pcs) (Store me
 * ... 20pcs)" — and falls back to "and"/"&" separators otherwise.
 */
function fragments(rackText: string): string[] {
  const parenthesised = rackText.match(/\(([^)]+)\)/g);
  if (parenthesised && parenthesised.length > 1) {
    return parenthesised.map((p) => p.slice(1, -1));
  }
  return rackText
    .split(/\s*(?:&|,?\s+and\s+|;)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parse the Location + Rack No. pair into structured placements.
 *
 * The contract the caller depends on: `placements` always has at least one
 * entry, and when `needsReview` is true the quantities should be treated as
 * unproven. Callers reconcile the parsed quantities against the row's authoritative
 * Current Stock, so a bad split shows up as a mismatch rather than lost units.
 */
export function parseLocations(
  locationText: string,
  rackText: string,
  currentStock: number,
): LocationParseResult {
  const loc = (locationText ?? '').trim();
  const rack = (rackText ?? '').trim();

  // Split the Location cell on "&" into its named locations.
  const named = loc
    .split(/\s*&\s*/)
    .map((part) => ({ raw: part, canonical: canonicalLocation(part) }))
    .filter((p) => p.canonical !== null) as { raw: string; canonical: string }[];

  // Nothing recognisable: park it in Unassigned and flag it.
  if (named.length === 0) {
    return {
      placements: [
        { locationName: UNASSIGNED_LOCATION, rackOrCarton: rack || null, qty: currentStock },
      ],
      needsReview: true,
      reviewReason: loc
        ? `Unrecognised location "${loc}"`
        : 'No location recorded on the source row',
    };
  }

  // Single location: everything sits there. The rack text is a descriptor, not
  // a split, so no quantity arithmetic is needed and nothing can go wrong.
  if (named.length === 1) {
    const only = named[0] as { raw: string; canonical: string };
    // A quantity embedded directly in the Location cell ("Confrance Room-600")
    // that disagrees with Current Stock means the row is telling two stories.
    const inlineQty = extractQty(only.raw) ?? extractInlineLocationQty(only.raw);
    const mismatch = inlineQty !== null && inlineQty !== currentStock;
    return {
      placements: [
        {
          locationName: only.canonical,
          rackOrCarton: extractRackOrCarton(rack) ?? (rack || null),
          qty: currentStock,
        },
      ],
      needsReview: mismatch,
      reviewReason: mismatch
        ? `Location cell says ${inlineQty} but Current Stock is ${currentStock}`
        : null,
    };
  }

  // Multiple locations: try to attribute a quantity to each from the rack text.
  const parts = fragments(rack);
  const placements: ParsedPlacement[] = [];

  for (const { canonical, raw } of named) {
    // Prefer the rack-note fragment that names this location; fall back to the
    // Location cell itself, which is where "Confrance Room-600 & -B2-205" puts
    // the split.
    const fragment = parts.find((f) => canonicalLocation(f) === canonical) ?? '';

    placements.push({
      locationName: canonical,
      rackOrCarton: extractRackOrCarton(fragment) ?? extractRackOrCarton(rack),
      qty: extractQty(fragment) ?? extractInlineLocationQty(raw),
    });
  }

  const attributed = placements.reduce((sum, p) => sum + (p.qty ?? 0), 0);
  const allResolved = placements.every((p) => p.qty !== null);

  // Only trust the split when every location got a number AND they add up.
  if (allResolved && attributed === currentStock) {
    return { placements, needsReview: false, reviewReason: null };
  }

  // Otherwise keep the placements as a hint but put the full quantity on the
  // first location so no units are lost, and send the row to review.
  const fallback: ParsedPlacement[] = placements.map((p, i) => ({
    ...p,
    qty: i === 0 ? currentStock : 0,
  }));
  return {
    placements: fallback,
    needsReview: true,
    reviewReason: allResolved
      ? `Split quantities total ${attributed} but Current Stock is ${currentStock}`
      : `Could not attribute a quantity to every location (${named.map((n) => n.canonical).join(', ')})`,
  };
}
