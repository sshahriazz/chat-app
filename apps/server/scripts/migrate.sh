#!/usr/bin/env bash
# Run Prisma migrations behind a Postgres advisory lock so concurrent
# callers (one per replica during a rolling deploy) can't race on the
# same migration. Only the first caller to acquire the lock does the
# `migrate deploy`; everyone else no-ops and exits 0.
#
# The lock key `8821077` is arbitrary — any constant int is fine as long
# as it doesn't collide with another advisory-lock user in the DB.
#
# Usage:
#   DATABASE_URL=postgresql://... ./scripts/migrate.sh
#
# Runs pnpm from the same dir as this script; safe to call from any
# working directory.
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "[migrate] DATABASE_URL is required" >&2
  exit 1
fi

LOCK_KEY=8821077
ACQUIRED=$(psql "$DATABASE_URL" -tA -c "SELECT pg_try_advisory_lock($LOCK_KEY);" 2>/dev/null || echo "error")

if [[ "$ACQUIRED" = "error" ]]; then
  echo "[migrate] failed to query Postgres for the advisory lock; aborting" >&2
  exit 1
fi

if [[ "$ACQUIRED" != "t" ]]; then
  echo "[migrate] another replica is running migrations — waiting for it to finish, then exiting."
  # Block on the lock so we don't return until migrations are definitely
  # complete. The session auto-releases the lock on exit.
  psql "$DATABASE_URL" -tA -c "SELECT pg_advisory_lock($LOCK_KEY); SELECT pg_advisory_unlock($LOCK_KEY);" >/dev/null
  echo "[migrate] other replica finished; no action taken."
  exit 0
fi

echo "[migrate] acquired advisory lock — running prisma migrate deploy"
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$SCRIPT_DIR/.."
pnpm exec prisma migrate deploy

psql "$DATABASE_URL" -tA -c "SELECT pg_advisory_unlock($LOCK_KEY);" >/dev/null
echo "[migrate] done."
