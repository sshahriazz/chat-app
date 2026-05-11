# Single entry point for every chat-app workflow. Run `make help`
# (or just `make`) to see all targets.
#
# Two compose layers:
#   - docker-compose.yml   → strict prod config. Dokploy reads only this.
#   - compose.dev.yml      → laptop-only overrides (host port binds,
#                            dev-default secrets). Layered via every `make
#                            dev*` target below; never deployed.
#
# Two env-var conventions:
#   - Anything in `.env` (at repo root) is read by both compose and the
#     server's `dotenv` loader. One file, one source of truth.
#   - In prod, Dokploy's env panel takes the place of `.env`.

SHELL          := /bin/bash
COMPOSE_DEV    := docker compose -f docker-compose.yml -f compose.dev.yml
COMPOSE_PROD   := docker compose -f docker-compose.yml

# Default target — show help when you run bare `make`.
.DEFAULT_GOAL  := help

.PHONY: help \
        dev dev-down dev-logs dev-restart dev-build dev-ps dev-nuke \
        prod-build prod-config prod-up prod-down \
        typecheck lint test build smoke \
        migrate migrate-create psql redis-cli \
        tag

# ─── Help ──────────────────────────────────────────────────────────
help: ## Show this help
	@awk 'BEGIN {FS = ":.*?## "} \
	     /^# ─── / {section=$$0; sub(/^# ─── /, "", section); sub(/ ─.*$$/, "", section); print "\n\033[1m" section "\033[0m"; next} \
	     /^[a-zA-Z][a-zA-Z0-9_-]*:.*?## / {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}' \
	     $(MAKEFILE_LIST)

# ─── Local dev ─────────────────────────────────────────────────────
dev: ## Bring up the full local stack (db, redis, centrifugo, minio, server, web)
	$(COMPOSE_DEV) up -d
	@echo ""
	@echo "  Web        → http://localhost:3000"
	@echo "  API        → http://localhost:3001/api"
	@echo "  API docs   → http://localhost:3001/api/docs"
	@echo "  WS         → ws://localhost:8000/connection/websocket"
	@echo "  MinIO UI   → http://localhost:9001"
	@echo "  Postgres   → localhost:5433  (chatapp / chatapp)"
	@echo ""
	@echo "  Tail logs: make dev-logs       Stop: make dev-down"

dev-build: ## Rebuild dev images (after Dockerfile changes)
	$(COMPOSE_DEV) build

dev-down: ## Stop the dev stack (keeps volumes)
	$(COMPOSE_DEV) down

dev-nuke: ## Stop dev stack AND delete volumes (DB, redis, minio data — irreversible)
	$(COMPOSE_DEV) down -v

dev-logs: ## Tail logs for all services (S=server limits to one)
	$(COMPOSE_DEV) logs -f $(S)

dev-restart: ## Restart a single service (usage: make dev-restart S=centrifugo)
	@test -n "$(S)" || (echo "Usage: make dev-restart S=<service>" && exit 1)
	$(COMPOSE_DEV) restart $(S)

dev-recreate: ## Force-rebuild images AND recreate every container (use after compose/dockerfile changes)
	$(COMPOSE_DEV) up -d --build --force-recreate

dev-ps: ## List dev containers + their health
	$(COMPOSE_DEV) ps

# ─── Prod-shape locally ────────────────────────────────────────────
prod-build: ## Build production images locally (strict, no dev overlay)
	$(COMPOSE_PROD) build

prod-config: ## Render the final compose Dokploy would see (debug missing env)
	$(COMPOSE_PROD) config

prod-up: ## Bring up the strict prod stack locally (requires real env vars)
	$(COMPOSE_PROD) up -d

prod-down: ## Stop the strict prod stack
	$(COMPOSE_PROD) down

# ─── CI-equivalent checks ──────────────────────────────────────────
typecheck: ## tsc --noEmit across all workspaces
	pnpm -r run type-check

lint: ## ESLint across all workspaces
	pnpm -r run lint

test: ## Run server vitest suite
	pnpm --filter @chat-app/server test -- --run

build: ## Production build of server + web (host machine, no docker)
	pnpm -r run build

# Smoke test the deployed public surface. Override HOST when targeting prod.
HOST ?= http://localhost:3001
smoke: ## Curl the key public endpoints (HOST=https://chat.technext.it for prod)
	@echo "→ $(HOST)/api/health";  curl -fsS -o /dev/null -w "  %{http_code}\n" $(HOST)/api/health  || echo "  FAILED"
	@echo "→ $(HOST)/api/livez";   curl -fsS -o /dev/null -w "  %{http_code}\n" $(HOST)/api/livez   || echo "  FAILED"
	@echo "→ $(HOST)/api/docs";    curl -fsS -o /dev/null -w "  %{http_code}\n" $(HOST)/api/docs   || echo "  FAILED"

# ─── Database ──────────────────────────────────────────────────────
migrate: ## Apply pending prisma migrations against the dev DB
	$(COMPOSE_DEV) exec server pnpm exec prisma migrate deploy

migrate-create: ## Generate a new prisma migration (usage: make migrate-create NAME=add_foo)
	@test -n "$(NAME)" || (echo "Usage: make migrate-create NAME=add_foo" && exit 1)
	$(COMPOSE_DEV) exec server pnpm exec prisma migrate dev --name $(NAME)

psql: ## Open a psql shell on the dev database
	$(COMPOSE_DEV) exec postgres psql -U chatapp chatapp

redis-cli: ## Open redis-cli on the dev cache
	$(COMPOSE_DEV) exec redis redis-cli

# ─── Release ───────────────────────────────────────────────────────
tag: ## Cut and push an annotated release tag (usage: make tag VERSION=1.1.2)
	@test -n "$(VERSION)" || (echo "Usage: make tag VERSION=x.y.z" && exit 1)
	@test -z "$$(git status --porcelain)" || (echo "Working tree has uncommitted changes — commit or stash first" && exit 1)
	git tag -a v$(VERSION) -m "v$(VERSION)"
	git push origin v$(VERSION)
	@echo ""
	@echo "  Tagged v$(VERSION) → origin"
	@echo "  Trigger Dokploy redeploy to ship it."
