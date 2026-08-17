import { Prisma } from '@procureflow/db';

/**
 * A tenant registered in more than one state holds a GSTIN per state, and the
 * place of supply — which decides CGST+SGST vs IGST — follows whichever
 * registration a document bills to.
 *
 * Where no registration is named, the fallback has to be *deliberate*. A bare
 * `findFirst({ where: { tenantId } })` returns whatever the planner hands back,
 * so with two registrations it decides the tax treatment by chance. This orders
 * the tenant's own default first (Settings → Branches), then the oldest branch.
 */
export const DEFAULT_PLANT_ORDER: Prisma.PlantOrderByWithRelationInput[] = [
  { isDefault: 'desc' },
  { createdAt: 'asc' },
];

export function defaultPlantQuery(tenantId: string): {
  where: Prisma.PlantWhereInput;
  orderBy: Prisma.PlantOrderByWithRelationInput[];
} {
  return { where: { tenantId }, orderBy: DEFAULT_PLANT_ORDER };
}
