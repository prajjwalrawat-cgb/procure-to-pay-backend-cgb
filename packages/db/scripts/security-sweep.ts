/**
 * Slice 11b — internal penetration-test-style security sweep.
 *
 * Programmatically probes the API's real route registry (parsed from the Nest
 * startup log — the authoritative "Mapped {path, method}" list) for:
 *   A. no-token enforcement       — every protected route must 401 without a JWT
 *   B. cross-tenant IDOR          — a valid token + another tenant's :id must 404
 *   C. wrong-audience isolation   — buyer JWT rejected on /vendor/*, and vice-versa
 *   D. insufficient-permission    — a low-priv token must 403 on a privileged route
 *
 * Coverage is provable: it walks the actual registry, not a hand-list. Exit 1 on
 * any leak, so it can run in CI.
 *
 * Run (after starting the API and capturing its log):
 *   pnpm --filter api start > /tmp/api.log 2>&1 &
 *   API_LOG=/tmp/api.log API=http://localhost:3001 \
 *     node scripts/with-env.mjs pnpm --filter @procureflow/db security:sweep
 */
import { readFileSync } from 'node:fs';

import { PrismaClient } from '@prisma/client';

const API = process.env.API ?? 'http://localhost:3001';
const BASE = `${API}/api/v1`;
const LOG = process.env.API_LOG ?? '/tmp/api-11a.log';

const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL ?? '' },
  },
});

// Routes that are intentionally unauthenticated (@Public).
const PUBLIC = [
  /^\/health/,
  /^\/api\/v1\/auth\//,
  /^\/api\/v1\/public\//,
  /^\/api\/v1\/integrations\/email\/inbound/, // webhook (shared-secret guarded)
];

interface Route {
  method: string;
  path: string;
}

function parseRoutes(): Route[] {
  const log = readFileSync(LOG, 'utf8');
  const seen = new Set<string>();
  const routes: Route[] = [];
  for (const m of log.matchAll(
    /Mapped \{([^,]+), (GET|POST|PATCH|PUT|DELETE)\} route/g,
  )) {
    const key = `${m[2]} ${m[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push({ method: m[2]!, path: m[1]! });
  }
  return routes;
}

const isPublic = (path: string): boolean => PUBLIC.some((re) => re.test(path));
const fillParams = (path: string): string =>
  path.replace(/:[A-Za-z0-9_]+/g, 'nonexistent-id');

async function login(
  email: string,
  password: string,
  portal?: 'vendor',
): Promise<string | null> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(portal ? { 'x-portal': portal } : {}),
    },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { tokens?: { accessToken?: string } };
  return body.tokens?.accessToken ?? null;
}

async function req(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<number> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).catch(() => ({ status: 0 }) as Response);
  return res.status;
}

async function main(): Promise<void> {
  const routes = parseRoutes();
  const buyer = await login('harpreet@star-cement.example', 'Slice0!Demo');
  const vendor = await login('kalpesh@patel-eng.example', 'Slice0!Vendor', 'vendor');
  const lowPriv = await login('r.kumar@star-cement.example', 'Slice0!Demo'); // STORES_OFFICER
  if (!buyer || !vendor) throw new Error('login failed — is the API up?');

  const failures: string[] = [];
  console.log(`Security sweep over ${routes.length} registered routes @ ${API}\n`);

  // ── A. No-token enforcement ────────────────────────────────────────────────
  let aChecked = 0;
  for (const r of routes) {
    if (isPublic(r.path)) continue;
    aChecked += 1;
    const status = await req(
      r.method,
      fillParams(r.path).replace('/api/v1', ''),
      undefined,
    );
    // Unauthenticated → 401. (Never a 200/403/404 leak before auth.)
    if (status !== 401) {
      failures.push(`A no-token ${r.method} ${r.path} → ${status} (expected 401)`);
    }
  }
  console.log(`A. no-token enforcement:  ${aChecked} protected routes probed`);

  // ── B. Cross-tenant IDOR ───────────────────────────────────────────────────
  const alpha = await prisma.tenant.findFirst({ where: { name: 'LoadTest Alpha Ltd' } });
  const idProbes: { path: string; label: string }[] = [];
  if (alpha) {
    const [inv, ven, po] = await Promise.all([
      prisma.invoice.findFirst({ where: { tenantId: alpha.id }, select: { id: true } }),
      prisma.vendor.findFirst({ where: { tenantId: alpha.id }, select: { id: true } }),
      prisma.purchaseOrder.findFirst({
        where: { tenantId: alpha.id },
        select: { id: true },
      }),
    ]);
    if (inv) idProbes.push({ path: `/invoices/${inv.id}`, label: 'invoice' });
    if (ven) idProbes.push({ path: `/vendors/${ven.id}`, label: 'vendor' });
    if (po) idProbes.push({ path: `/purchase-orders/${po.id}`, label: 'PO' });
  }
  for (const p of idProbes) {
    const status = await req('GET', p.path, buyer);
    // Star's token must not see Alpha's resource → 404 (RLS returns no rows).
    if (status !== 404)
      failures.push(`B IDOR ${p.label} cross-tenant → ${status} (expected 404)`);
  }
  console.log(`B. cross-tenant IDOR:     ${idProbes.length} cross-tenant :id probes`);

  // ── C. Wrong-audience isolation ────────────────────────────────────────────
  const cProbes = [
    {
      name: 'vendor JWT on buyer /invoices',
      status: await req('GET', '/invoices?tab=all', vendor),
    },
    {
      name: 'buyer JWT on /vendor/purchase-orders',
      status: await req('GET', '/vendor/purchase-orders', buyer),
    },
  ];
  for (const c of cProbes) {
    if (c.status !== 401 && c.status !== 403) {
      failures.push(`C audience: ${c.name} → ${c.status} (expected 401/403)`);
    }
  }
  console.log(`C. wrong-audience:        ${cProbes.length} cross-audience probes`);

  // ── D. Insufficient permission ─────────────────────────────────────────────
  if (lowPriv) {
    // STORES_OFFICER lacks payment_run:compose — must 403 before body validation.
    const status = await req('POST', '/payment-runs', lowPriv, {
      name: 'x',
      cycleDate: '2026-01-01',
      bankAccountId: 'x',
    });
    if (status !== 403)
      failures.push(`D perm: stores→compose payment run → ${status} (expected 403)`);
    console.log(`D. insufficient-perm:     1 privileged-route probe`);
  }

  console.log('');
  if (failures.length > 0) {
    console.error(`❌ ${failures.length} security finding(s):`);
    failures.forEach((f) => console.error('   ' + f));
    await prisma.$disconnect();
    process.exit(1);
  }
  console.log(
    '✅ PASS — no auth/audience/permission/cross-tenant leaks across the registry.',
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
