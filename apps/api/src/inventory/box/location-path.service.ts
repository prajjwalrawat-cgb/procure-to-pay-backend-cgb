import { Injectable } from '@nestjs/common';
import type { LocationKind, LocationPath } from '@procureflow/shared';

import { PrismaService } from '../../prisma/prisma.service';

interface Ancestor {
  id: string;
  name: string;
  kind: LocationKind;
  depth: number;
}

/**
 * LocationPathService (Slice 14) — resolves a location to its full ancestry:
 * Warehouse → Rack → Section.
 *
 * Done with a recursive walk up `Location.parentId` rather than a materialised
 * path column. A stored path would be faster but it is a second copy of the
 * tree's shape, and it goes stale the moment somebody re-parents a rack — the
 * same class of bug this module refuses to accept for quantities. At warehouse
 * scale (hundreds of locations, nesting three or four deep) the walk is
 * cheap, and results are memoised per request below.
 */
@Injectable()
export class LocationPathService {
  constructor(private readonly prisma: PrismaService) {}

  /** Ancestry for one location, outermost first. */
  async pathFor(locationId: string): Promise<LocationPath> {
    const paths = await this.pathsFor([locationId]);
    return paths.get(locationId) ?? emptyPath();
  }

  /**
   * Ancestry for many locations in one query. The reverse lookup renders a row
   * per place a product sits; resolving each separately would fire a recursive
   * query per row for a page that shows a handful of them.
   */
  async pathsFor(locationIds: string[]): Promise<Map<string, LocationPath>> {
    const out = new Map<string, LocationPath>();
    const unique = [...new Set(locationIds.filter(Boolean))];
    if (unique.length === 0) return out;

    // One recursive CTE seeded with every location of interest. `root` carries
    // the location we started from so ancestors can be grouped back to it.
    const rows = await this.prisma.client.$queryRaw<
      { root: string; id: string; name: string; kind: LocationKind; depth: number }[]
    >`
      WITH RECURSIVE up AS (
        SELECT l."id" AS root, l."id", l."name", l."kind", l."parent_id", 0 AS depth
        FROM "Location" l
        WHERE l."id" = ANY(${unique})
        UNION ALL
        SELECT up.root, p."id", p."name", p."kind", p."parent_id", up.depth + 1
        FROM "Location" p
        JOIN up ON p."id" = up."parent_id"
        -- A cycle would spin forever. Locations are a tree by construction, but
        -- nothing in the schema enforces it, and an infinite loop inside a
        -- request transaction is a far worse failure than a truncated path.
        WHERE up.depth < 10
      )
      SELECT root, "id", "name", "kind", depth FROM up
    `;

    const byRoot = new Map<string, Ancestor[]>();
    for (const r of rows) {
      const list = byRoot.get(r.root) ?? [];
      list.push({ id: r.id, name: r.name, kind: r.kind, depth: Number(r.depth) });
      byRoot.set(r.root, list);
    }

    for (const [root, ancestors] of byRoot) {
      // Deepest depth = furthest ancestor = outermost level.
      const ordered = [...ancestors].sort((a, b) => b.depth - a.depth);
      out.set(root, {
        warehouse: pick(ordered, 'WAREHOUSE'),
        rack: pick(ordered, 'RACK'),
        section: pick(ordered, 'SECTION'),
        full: ordered.map((a) => ({ id: a.id, name: a.name, kind: a.kind })),
      });
    }
    return out;
  }
}

/**
 * The name of the nearest ancestor of a given kind.
 *
 * Returns null rather than guessing when the tree is unlabelled — the 625
 * migrated legacy locations are all `OTHER`, and inventing "the top one must be
 * the warehouse" would put confident but wrong labels on a screen an operator
 * uses to walk to a shelf.
 */
function pick(ordered: Ancestor[], kind: LocationKind): string | null {
  return ordered.find((a) => a.kind === kind)?.name ?? null;
}

function emptyPath(): LocationPath {
  return { warehouse: null, rack: null, section: null, full: [] };
}
