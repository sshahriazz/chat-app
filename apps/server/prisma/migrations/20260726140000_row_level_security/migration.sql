-- Row-Level Security (defense-in-depth tenant isolation).
--
-- App-layer `WHERE tenant_id = ?` filtering remains the PRIMARY control;
-- this is a second enforcement layer beneath it so a single forgotten
-- filter in a request handler cannot leak cross-tenant rows.
--
-- Policy semantics — FAIL-OPEN WHEN NO CONTEXT:
--   * When `app.current_tenant_id` is unset (system/cron/migration/admin
--     paths, and the auth-resolution queries that run before request
--     context is established) the policy allows all rows — i.e. exactly
--     today's behavior, so nothing breaks.
--   * When it IS set (every authenticated request wraps its ORM queries
--     with `SELECT set_config('app.current_tenant_id', <tenant>, true)`
--     via the Prisma extension) rows are restricted to that tenant, and
--     writes are constrained by WITH CHECK.
--
-- FORCE is required because the app connects as the table owner; without
-- it RLS would not apply to the owner. A future hardening (dedicated
-- non-owner app role + fail-CLOSED policy) is tracked in
-- docs/security/OPS_HARDENING.md.
--
-- NOTE: `tenant`, `admin_audit_log`, and `chat_outbox` are intentionally
-- NOT covered — they are cross-tenant/system tables (tenant resolution,
-- audit trail that must survive tenant deletion, realtime delivery queue).

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'user', 'messages', 'attachments', 'reactions',
    'conversations', 'conversation_members',
    'push_subscriptions', 'deleted_external_id'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (
          current_setting('app.current_tenant_id', true) IS NULL
          OR current_setting('app.current_tenant_id', true) = ''
          OR tenant_id = current_setting('app.current_tenant_id', true)
        )
        WITH CHECK (
          current_setting('app.current_tenant_id', true) IS NULL
          OR current_setting('app.current_tenant_id', true) = ''
          OR tenant_id = current_setting('app.current_tenant_id', true)
        )
    $f$, t);
  END LOOP;
END $$;
