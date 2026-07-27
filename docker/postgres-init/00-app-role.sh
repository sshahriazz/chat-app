#!/bin/bash
# Create the least-privilege application role so Row-Level Security ENFORCES.
#
# Runs ONCE, on a FRESH postgres volume, BEFORE the `migrate` service creates
# the tables (Postgres runs /docker-entrypoint-initdb.d/* only when the data
# directory is empty). `ALTER DEFAULT PRIVILEGES` therefore auto-grants every
# table/sequence the migrate role (owner) creates afterwards to chatapp_app —
# so there is no per-migration grant upkeep, and no manual step on deploy.
#
# The role password is the standard POSTGRES_PASSWORD. The role's isolation
# comes from it being NOSUPERUSER (Postgres bypasses RLS for superusers), not
# from a distinct secret — so reusing the one password keeps deploys simple
# with zero extra env vars. The server connects as this role (see the server
# DATABASE_URL in docker-compose.yml); the migrate service keeps the owner
# role for DDL.
#
# Idempotent: the role is only created if absent (\gexec runs the generated
# CREATE ROLE only when the guard SELECT returns a row).
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v pw="$POSTGRES_PASSWORD" <<'EOSQL'
SELECT format('CREATE ROLE chatapp_app NOSUPERUSER LOGIN PASSWORD %L', :'pw')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'chatapp_app')\gexec

GRANT USAGE ON SCHEMA public TO chatapp_app;
-- Cover anything that already exists (nothing on a truly fresh init).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO chatapp_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO chatapp_app;
-- Cover everything the migrate (owner) role creates next.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO chatapp_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO chatapp_app;
EOSQL

echo "[app-role-init] chatapp_app role ready (non-superuser; RLS enforcement role)"
