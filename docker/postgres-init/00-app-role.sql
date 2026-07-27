-- DEV-ONLY: create the least-privilege application role so Row-Level
-- Security actually ENFORCES locally (Postgres bypasses RLS for
-- superusers, and the dev `chatapp` role is a superuser).
--
-- This runs once, on a FRESH postgres volume, BEFORE the `migrate` service
-- creates the tables. `ALTER DEFAULT PRIVILEGES` therefore ensures every
-- table/sequence the migrate role (chatapp) creates afterwards is
-- automatically granted to chatapp_app — so no per-migration grant upkeep.
--
-- Mounted only via compose.dev.yml. PROD uses a real role + strong password
-- via the deployment env (see DEPLOYMENT_RUNBOOK.md "Activate RLS"), never
-- this dev-default password.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chatapp_app') THEN
    CREATE ROLE chatapp_app NOSUPERUSER LOGIN PASSWORD 'chatapp_app';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO chatapp_app;

-- Cover any tables/sequences that already exist (none on a truly fresh
-- init, but harmless and correct if the DB was pre-seeded).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO chatapp_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO chatapp_app;

-- Cover everything the migrate role creates next.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO chatapp_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO chatapp_app;
