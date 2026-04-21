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

ENV NODE_ENV=production \
    TZ=UTC \
    NODE_OPTIONS=--enable-source-maps

EXPOSE 3001

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -q --spider http://localhost:3001/livez || exit 1

WORKDIR /app/apps/server
# Migrations run on startup so every deploy is consistent; the server
# only binds after they complete.
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && node dist/index.mjs"]
