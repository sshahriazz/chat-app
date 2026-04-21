#!/usr/bin/env bash
# Timestamped Postgres backup using pg_dump's custom format (compressed,
# restorable with pg_restore). Retains 14 days of local dumps; uploads
# elsewhere is left to the operator (rclone, aws s3 cp, gsutil, etc).
#
# Usage:
#   DATABASE_URL=postgresql://... ./scripts/backup.sh [target_dir]
#
# Intended to run via cron:
#   0 2 * * * DATABASE_URL=... /app/scripts/backup.sh /var/backups/chat
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "[backup] DATABASE_URL is required" >&2
  exit 1
fi

TARGET="${1:-./backups}"
mkdir -p "$TARGET"

TIMESTAMP=$(date -u +%Y-%m-%dT%H-%M-%SZ)
OUT="$TARGET/chatapp-$TIMESTAMP.dump"

echo "[backup] dumping to $OUT"
# --format=custom → single file, compressible, pg_restore-friendly
# --no-owner / --no-acl → portable across role setups (staging ↔ prod)
pg_dump --format=custom --no-owner --no-acl \
  --file="$OUT" "$DATABASE_URL"

# Retention: drop dumps older than 14 days. Off-site retention is the
# operator's responsibility — this only protects against local disk
# filling up.
find "$TARGET" -maxdepth 1 -name 'chatapp-*.dump' -type f -mtime +14 -delete

SIZE=$(du -h "$OUT" | cut -f1)
echo "[backup] done — $OUT ($SIZE)"
