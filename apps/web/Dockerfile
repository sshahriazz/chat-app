# syntax=docker/dockerfile:1.7
#
# Multi-stage Next.js build using `output: "standalone"`. The runtime
# image contains only the minimum node_modules needed to run the app
# (pnpm is not installed at runtime — `node server.js` is the entry).

# ---- Stage 1: install ------------------------------------------------------
FROM node:24-alpine AS deps
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /app

# Only the lockfile + workspace manifests first so the install layer
# is cache-friendly (reused when source code changes but deps haven't).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @chat-app/web...

# ---- Stage 2: build --------------------------------------------------------
FROM deps AS build
WORKDIR /app

# NEXT_PUBLIC_* values are baked into the client JS bundle at build
# time. Dokploy / compose supply them as build args.
ARG NEXT_PUBLIC_API_BASE_URL=""
ARG NEXT_PUBLIC_CENTRIFUGO_URL=""
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_CENTRIFUGO_URL=$NEXT_PUBLIC_CENTRIFUGO_URL

# Rewrite destinations are evaluated at `next build` and serialized
# into the routes-manifest — they HAVE to be set as build args, not
# runtime envs. Defaults point at compose service names so rebuilding
# with no overrides produces a working image.
ARG API_PROXY_URL=http://server:3001
ARG WS_PROXY_URL=http://centrifugo:8000
ARG STORAGE_PROXY_URL=http://minio:9000
ARG STORAGE_BUCKET=chatapp
ENV API_PROXY_URL=$API_PROXY_URL \
    WS_PROXY_URL=$WS_PROXY_URL \
    STORAGE_PROXY_URL=$STORAGE_PROXY_URL \
    STORAGE_BUCKET=$STORAGE_BUCKET

COPY apps/web apps/web
COPY tsconfig.base.json ./

RUN pnpm --filter @chat-app/web run build

# ---- Stage 3: runtime ------------------------------------------------------
FROM node:24-alpine AS runtime
RUN apk add --no-cache wget \
 && addgroup -S nodejs \
 && adduser -S nextjs -G nodejs
WORKDIR /app

# `output: "standalone"` emits a self-contained tree at
# `.next/standalone/`. With `outputFileTracingRoot` pointed at the repo
# root, the tree mirrors the workspace: copy it to / and the entry is at
# `/apps/web/server.js`. Static assets + public/ aren't included by the
# tracer and must be copied separately.
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public

USER nextjs

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -q --spider http://localhost:3000 || exit 1

CMD ["node", "apps/web/server.js"]
