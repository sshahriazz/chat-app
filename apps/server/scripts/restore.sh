#!/usr/bin/env bash
# Restore a pg_dump custom-format backup. DESTRUCTIVE — drops matching
# tables and recreates them from the dump. Always test on a staging
# instance first; point at an empty DB if restoring for audit.
#
# Usage:
#   DATABASE_URL=postgresql://... ./scripts/restore.sh /path/to/chatapp-TIMESTAMP.dump
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "[restore] DATABASE_URL is required" >&2
  exit 1
fi
if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <dump-file>" >&2
  exit 1
fi

DUMP="$1"
if [[ ! -f "$DUMP" ]]; then
  echo "[restore] dump file not found: $DUMP" >&2
  exit 1
fi

echo "[restore] restoring $DUMP → $DATABASE_URL"
echo "[restore] this is DESTRUCTIVE — matching tables will be dropped."
read -r -p "[restore] type 'yes' to continue: " CONFIRM
if [[ "$CONFIRM" != "yes" ]]; then
  echo "[restore] aborted."
  exit 1
fi

# --clean + --if-exists → drop objects before recreating, safe on an
# empty DB too.
# --no-owner / --no-acl → portable across role setups.
pg_restore --clean --if-exists --no-owner --no-acl \
  --dbname="$DATABASE_URL" "$DUMP"

echo "[restore] done."
