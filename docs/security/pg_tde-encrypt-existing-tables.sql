-- Encrypt EXISTING tables at rest with pg_tde (Phase 3 of
-- docs/security/PRODUCTION_GO_LIVE.md).
--
-- Tables created before pg_tde was enabled use the plain `heap` access
-- method. `ALTER TABLE ... SET ACCESS METHOD tde_heap` rewrites each table
-- into an encrypted one. Run this AFTER the extension + Vault key provider
-- + default key are set up (see the runbook), as the table OWNER.
--
-- ⚠️  Each ALTER takes an ACCESS EXCLUSIVE lock and fully rewrites the
--     table — run in a maintenance window, and take a verified, restore-
--     tested backup first. Idempotent: tables already tde_heap are skipped.
--
-- Verify afterwards:
--   SELECT c.relname, a.amname FROM pg_class c JOIN pg_am a ON c.relam=a.oid
--   WHERE c.relkind='r' AND c.relnamespace='public'::regnamespace ORDER BY 1;
--   -- every row should show amname = tde_heap

DO $$
DECLARE
  r record;
  n int := 0;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    JOIN pg_am a ON a.oid = c.relam
    WHERE ns.nspname = 'public'
      AND c.relkind = 'r'            -- ordinary tables only
      AND a.amname <> 'tde_heap'     -- skip already-encrypted
    ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER TABLE public.%I SET ACCESS METHOD tde_heap', r.relname);
    RAISE NOTICE 'encrypted: %', r.relname;
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'pg_tde: rewrote % table(s) to tde_heap', n;
END $$;
