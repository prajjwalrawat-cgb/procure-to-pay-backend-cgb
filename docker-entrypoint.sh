#!/bin/sh
# =============================================================================
# Container entrypoint: bring the schema up to date, then start the API.
#
# Nothing used to apply migrations on deploy — no CI step, and the image booted
# straight into `node main.js`. Schema changes therefore had to be remembered
# and run by hand against production, and the failure mode when someone did not
# was silent and total: the new code queries columns that do not exist, so every
# request touching them 500s while the container reports itself healthy.
#
# Migrations run against DIRECT_DATABASE_URL (see `directUrl` in schema.prisma).
# The pooled connection cannot take the advisory lock Prisma needs, nor run DDL,
# so a deploy with only DATABASE_URL set will fail here rather than halfway
# through altering a table.
#
# `migrate:deploy` also applies the RLS and audit-chain SQL, which is idempotent
# and safe on every boot.
#
# This script exits non-zero rather than starting the API on a schema it cannot
# use. That means a bad deploy restart-loops with the reason in the logs, which
# is louder — and far easier to diagnose — than an API that answers every
# request with a 500.
# =============================================================================
set -e

if [ -z "$DIRECT_DATABASE_URL" ]; then
  echo "FATAL: DIRECT_DATABASE_URL is not set." >&2
  echo "Migrations need the direct (non-pooled) connection: Prisma takes an" >&2
  echo "advisory lock and runs DDL, neither of which the pooler supports." >&2
  echo "Set it alongside DATABASE_URL and redeploy." >&2
  exit 1
fi

echo "→ applying database migrations…"
pnpm --filter @procureflow/db migrate:deploy

echo "→ migrations applied; starting API"
exec node apps/api/dist/main.js
