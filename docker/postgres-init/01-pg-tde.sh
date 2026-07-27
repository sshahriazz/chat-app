#!/bin/bash
# Enable pg_tde transparent data-at-rest encryption on fresh init.
#
# Runs ONCE, on a fresh Percona-PostgreSQL volume, BEFORE the `migrate`
# service creates the app tables. It:
#   1. creates the pg_tde extension (preloaded via shared_preload_libraries),
#   2. registers a FILE key provider + a principal key,
#   3. makes `tde_heap` (the encrypting access method) the DATABASE default,
# so every table the migrate role then creates is encrypted at rest and the
# app reads/writes transparently — no table rewrite, no manual step on deploy.
#
# KEY-STORE TRADE-OFF (read before trusting this for compliance):
# the principal key lives in a FILE inside PGDATA — i.e. on the same volume as
# the data. That gives you at-rest encryption with zero external infra, but it
# does NOT defend a stolen disk / leaked backup (the key travels with it). To
# get that protection, switch to the Vault global provider
# (pg_tde_add_global_key_provider_vault_v2) so the key lives in Vault, separate
# from the data. See docs/security/OPS_HARDENING.md. This script is the
# simple, automated baseline; Vault is the later upgrade.
set -e

# Skip gracefully if pg_tde isn't preloaded (e.g. someone overrode
# POSTGRES_IMAGE back to stock postgres). The DB just comes up unencrypted
# instead of crashing the whole init.
if ! psql -tAc "SHOW shared_preload_libraries" \
     --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" | grep -q pg_tde; then
  echo "[pg-tde-init] pg_tde not in shared_preload_libraries — skipping at-rest encryption setup"
  exit 0
fi

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
	CREATE EXTENSION IF NOT EXISTS pg_tde;
	SELECT pg_tde_add_global_key_provider_file('local_file_provider', '$PGDATA/pg_tde_keyring');
	SELECT pg_tde_create_key_using_global_key_provider('principal_key', 'local_file_provider');
	SELECT pg_tde_set_default_key_using_global_key_provider('principal_key', 'local_file_provider');
	-- New tables in this database default to the encrypting access method.
	ALTER DATABASE "$POSTGRES_DB" SET default_table_access_method = 'tde_heap';
EOSQL

echo "[pg-tde-init] pg_tde enabled; default_table_access_method=tde_heap for $POSTGRES_DB"
