# syntax=docker/dockerfile:1.7

# ---- Stage 1: install full deps ----
FROM node:24-alpine AS deps
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
# Prisma schema must exist for postinstall `prisma generate` to succeed.
COPY apps/server/prisma apps/server/prisma
RUN pnpm install --frozen-lockfile --filter @chat-app/server...

# ---- Stage 2: build ----
FROM deps AS build
WORKDIR /app
COPY apps/server apps/server
COPY tsconfig.base.json ./
# DATABASE_URL at build time is only needed by `prisma generate` which
# does NOT connect. Provide a dummy so Prisma validates the schema.
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
RUN pnpm --filter @chat-app/server exec prisma generate \
 && pnpm --filter @chat-app/server run build

# ---- Stage 3: runtime ----
FROM node:24-alpine AS runtime
RUN corepack enable && corepack prepare pnpm@10 --activate \
 && apk add --no-cache wget
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/server/prisma apps/server/prisma
RUN pnpm install --frozen-lockfile --prod --filter @chat-app/server...

COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/src/generated ./apps/server/src/generated
# `prisma migrate deploy` needs prisma.config.ts at runtime to resolve
# DATABASE_URL (Prisma 7 moved connection config out of schema.prisma).
COPY --from=build /app/apps/server/prisma.config.ts ./apps/server/prisma.config.ts

ENV NODE_ENV=production \
    TZ=UTC \
    NODE_OPTIONS=--enable-source-maps

EXPOSE 3001

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -q --spider http://localhost:3001/livez || exit 1

WORKDIR /app/apps/server

# Migrations run as a ONE-SHOT step before rolling deploys, not on every
# container start. Starting them inline would make N replicas race on
# the same `prisma migrate deploy`, which occasionally corrupts state
# (two replicas picking the same pending migration, partial writes, etc).
#
# Recommended orchestration:
#   k8s:    Job (or initContainer with leader election) using the same
#           image — `docker run <image> pnpm exec prisma migrate deploy`.
#   ECS:    One-off task pre-deploy.
#   docker: `./scripts/migrate.sh` before `docker compose up -d`.
#
# The advisory-lock wrapper at `scripts/migrate.sh` is safe to invoke
# from every replica — only one will acquire the lock and run migrations.
CMD ["node", "dist/index.mjs"]
