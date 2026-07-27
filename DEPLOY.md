# Deployment — Frontend (Vercel) + Backend (Railway)

Two repos, two hosts. The frontend never touches the database; it calls the
backend API, and the backend owns all DB/Redis/S3/OCR access.

```
Browser ──► Frontend (Next.js, Vercel) ──► Backend API (NestJS, Railway) ──► Supabase / Redis / S3
                                                        └──► OCR (Python, Railway, private network)
```

Why the backend leaves Vercel: NestJS is a long-running, stateful server
(BullMQ workers, persistent Redis, SSE for reverse auctions). Vercel serverless
is stateless and short-lived, which is what caused `FUNCTION_INVOCATION_FAILED`.
Railway runs it as a normal always-on container.

---

## 1. Repo split — what goes where

**`procure-to-pay-frontend`** (deploys to Vercel)
```
apps/web/            apps/vendor/            packages/ui/            packages/shared/*
pnpm-workspace.yaml  package.json  turbo.json  tsconfig.base.json
```

**`procure-to-pay-backend`** (deploys to Railway)
```
apps/api/            packages/db/            packages/shared/*       services/ocr-service/
Dockerfile  .dockerignore  railway.toml
pnpm-workspace.yaml  package.json  turbo.json  tsconfig.base.json  scripts/with-env.mjs
```

### The shared package (`@procureflow/shared`)
It's imported by BOTH sides but is pure TypeScript (types, constants, validation
— no DB, no server code). With two repos you have two options:

- **Duplicate it** (simplest): copy `packages/shared/` into each repo. It changes
  rarely; accept the occasional manual sync. **Recommended to start.**
- **Publish it** to GitHub Packages (private) and depend on it by version in both
  repos. Cleaner long-term, but adds a registry + auth + release step.

After copying folders into each repo, delete the now-unused workspace globs and
run `pnpm install` so each repo regenerates its own `pnpm-lock.yaml` (the current
monorepo lockfile references web+vendor+api together and won't match a split repo).

> Trim `pnpm-workspace.yaml` in each repo. Backend:
> `packages: ['apps/*', 'packages/*', 'services/*']`. Frontend: `['apps/*', 'packages/*']`.

---

## 2. Backend on Railway

Create ONE Railway project with **two services** from the backend repo:

### Service A — `api` (NestJS)
- **Source:** the backend repo, root directory `/`.
- **Build:** Dockerfile (`railway.toml` already selects it). Railway injects
  `$PORT`; `main.ts` now binds it.
- **Health check:** `/health` (already in `railway.toml`).
- **Env vars** (Railway → service → Variables):

  | Var | Value |
  |---|---|
  | `NODE_ENV` | `production` |
  | `DATABASE_URL` | Supabase pooled URL (`...pooler.supabase.com:6543/...pgbouncer=true`) |
  | `DIRECT_DATABASE_URL` | Supabase direct URL (`...:5432/...`) — for migrate/security |
  | `REDIS_URL` | your Upstash `rediss://...` |
  | `S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` / `S3_FORCE_PATH_STYLE` | Supabase Storage S3 creds |
  | `JWT_PRIVATE_KEY_BASE64` / `JWT_PUBLIC_KEY_BASE64` | RS256 keypair (base64 PEM) |
  | `JWT_ACCESS_TTL` `JWT_REFRESH_TTL` `JWT_ISSUER` `JWT_BUYER_AUDIENCE` `JWT_VENDOR_AUDIENCE` | as in `.env.example` |
  | `API_CORS_ORIGINS` | `https://<web>.vercel.app,https://<vendor>.vercel.app` (the deployed frontend origins) |
  | `RESEND_API_KEY` **or** `BREVO_API_KEY` | **One is required.** Railway blocks outbound SMTP on every plan below Pro (`:465` and `:587` both `ETIMEDOUT`), so nodemailer cannot deliver from here — mail must go over HTTPS. Resend needs the `SMTP_FROM` *domain* DNS-verified (SPF + DKIM) or it 403s; Brevo needs only the single *address* verified by clicking a link it emails there, so it works without DNS access. |
  | `SMTP_FROM` | e.g. `Procure To Pay <no-reply@cgbindia.com>` — the from address on every transport |
  | `APP_BASE_URL` | Public web origin (e.g. `https://vendor.artboxsolutions.ai`) — builds the invite/set-password links. Defaults to `http://localhost:3000`, which silently produces dead links. |
  | `OCR_API_URL` | `http://ocr.railway.internal:8000` (private URL of service B) |

  Do NOT set `API_INTERNAL_URL` here — that's a frontend var.

### Service B — `ocr` (Python)
- **Source:** same repo, **root directory `services/ocr-service`**, its own
  `Dockerfile` (already present).
- Keep it **private** (no public domain) — only the API calls it, over Railway's
  private network at `http://ocr.railway.internal:8000`.
- **Env vars:** `OCR_PROVIDER`, `AZURE_DOC_INTEL_ENDPOINT/KEY`, `LLM_*`,
  `OCR_DEFAULT_TAX_RATE`, `OCR_DEFAULT_UOM` (see `docker-compose.yml` for the list).

### Database migrations on deploy
Run once after the first deploy (Railway → service → one-off command, using the
`DIRECT_DATABASE_URL`):
```
pnpm --filter @procureflow/db migrate:deploy
```
`migrate:deploy` also runs `security:apply` (RLS + the audit-chain trigger — the
`sha256` fix). Re-run it whenever migrations or `prisma/security/*.sql` change.

---

## 3. Frontend on Vercel

Two Vercel projects from the frontend repo (root directory per app):

### `web` project — root `apps/web`
| Var | Value |
|---|---|
| `NEXT_PUBLIC_API_URL` | `https://<api>.up.railway.app/api/v1` |
| `VENDOR_ZONE_URL` | `https://<vendor>.vercel.app` (for the `/vendor` multi-zone rewrite) |

### `vendor` project — root `apps/vendor`
| Var | Value |
|---|---|
| `NEXT_PUBLIC_VENDOR_API_URL` | `https://<api>.up.railway.app/api/v1` |

> This uses the cross-origin model (browser → Railway API directly), which is the
> natural fit for split hosting. `API_CORS_ORIGINS` on the API must list both
> Vercel origins. The single-origin `API_INTERNAL_URL` proxy is only for local
> `pnpm dev` on one port — not needed in this split.

---

## 4. Order of operations
1. Create the two GitHub repos (empty).
2. Split the folders as in §1; `pnpm install` in each; commit & push.
3. Railway: create project → `api` + `ocr` services → set env → deploy → run the
   migrate one-off.
4. Confirm `https://<api>.up.railway.app/health` → `{"status":"ok",...}`.
5. Vercel: create `web` + `vendor` projects → set env (API URL from step 4) → deploy.
6. Set `API_CORS_ORIGINS` on Railway to the real Vercel origins → redeploy API.
7. Open `https://<web>.vercel.app/login` and sign in (`harpreet@star-cement.example` / `Slice0!Demo`).
```
