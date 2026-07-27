#!/bin/bash
# DEV-ONLY: enable pg_tde transparent data-at-rest encryption on fresh init.
#
# Runs once, on a fresh Percona-PostgreSQL volume, BEFORE the `migrate`
# service creates the app tables. It:
#   1. creates the pg_tde extension (preloaded via shared_preload_libraries),
#   2. registers a FILE key provider + a principal key,
#   3. makes `tde_heap` (the encrypting access method) the DATABASE default,
# so every table the migrate role then creates is encrypted at rest and the
# app reads/writes transparently.
#
# The dev keyring lives inside PGDATA purely to prove the MECHANISM without
# extra infra — that means the key sits next to the data, which defeats the
# point in production. PROD MUST use the Vault global provider instead
# (pg_tde_add_global_key_provider_vault_v2), so the principal key lives in
# Vault, separate from the data. See docs/security/OPS_HARDENING.md.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
	CREATE EXTENSION IF NOT EXISTS pg_tde;
	SELECT pg_tde_add_global_key_provider_file('dev_file_provider', '$PGDATA/pg_tde_dev_keyring');
	SELECT pg_tde_create_key_using_global_key_provider('dev_principal', 'dev_file_provider');
	SELECT pg_tde_set_default_key_using_global_key_provider('dev_principal', 'dev_file_provider');
	-- New tables in this database default to the encrypting access method.
	ALTER DATABASE "$POSTGRES_DB" SET default_table_access_method = 'tde_heap';
EOSQL

echo "[pg-tde-init] pg_tde enabled; default_table_access_method=tde_heap for $POSTGRES_DB"
