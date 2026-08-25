# =============================================================================
# ProcureFlow backend (NestJS API) — Docker image for Railway.
#
# Build context = repo root of the BACKEND repo, which is a pnpm workspace
# containing apps/api, packages/db and packages/shared. The Python OCR engine is
# a separate repository and image entirely; this one never builds it.
#
# Debian base (node:20-slim) so the Prisma query engine (debian-openssl-3.0.x)
# and the argon2 native binding both resolve. Alpine/musl would need different
# targets and a musl argon2 build.
# =============================================================================

# ---- build stage: install + compile shared → db → api --------------------
FROM node:20-slim AS build

# Toolchain: openssl for Prisma; python3/make/g++ for the argon2 native addon.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.1.0 --activate

WORKDIR /app
COPY . .

# Install the whole workspace (dev deps included — needed to build).
RUN pnpm install --frozen-lockfile

# Build order matters: shared and db are workspace deps of the API.
# db#build runs `prisma generate` (emits the client + engine into node_modules).
RUN pnpm --filter @procureflow/shared build \
  && pnpm --filter @procureflow/db build \
  && pnpm --filter @procureflow/api build

# ---- runtime stage: lean image that just runs the compiled server --------
FROM node:20-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# pnpm is needed at RUNTIME too, not just to build: the entrypoint runs the
# db package's migrate:deploy script before the API starts.
RUN corepack enable && corepack prepare pnpm@9.1.0 --activate

ENV NODE_ENV=production
WORKDIR /app

# Copy the built workspace (dist output + node_modules with the generated
# Prisma client and pnpm symlinks intact). Simple and reliable; optimise later
# with `pnpm deploy --prod` if image size becomes a concern.
COPY --from=build /app ./

# The host injects $PORT; main.ts binds it (falls back to API_PORT locally).
# The entrypoint applies pending migrations, then execs the API. Booting
# straight into the server would leave a deploy running new code against an
# old schema — see docker-entrypoint.sh for why that fails silently.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3001
CMD ["/usr/local/bin/docker-entrypoint.sh"]
