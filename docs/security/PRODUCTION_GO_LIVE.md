# Production Go-Live Runbook — Security Hardening

**Branch:** `security/audit-hardening` (11 commits ahead of `main`; contains the CASA work too).
**Target:** Dokploy self-hosted (`chat.technext.it`), **live with data**.
**Verified locally:** prod images build; prod compose validates; server suite 86/86; RLS + pg_tde proven; DAST clean.

This ships in **independent phases**, each deployable, verifiable, and reversible on its own. **Do every phase on staging first.** Phase 0 is the low-risk baseline (do it first); Phases 1–3 are activations you can schedule separately.

---

## Pre-flight (once)

1. **Generate secrets** (keep them in the Dokploy env panel, never in git):
   ```sh
   openssl rand -base64 32   # JWT_SECRET_ENCRYPTION_KEY   (REQUIRED prod)
   openssl rand -base64 32   # FIELD_ENCRYPTION_KEY        (Phase 2; DISTINCT from above)
   openssl rand -base64 24   # chatapp_app DB password     (Phase 1)
   ```
2. **Stand up staging** on the same branch with a **copy of prod data** (`make dev` with a restored dump, or a Dokploy staging app). Every phase below is validated on staging before prod.
3. **Merge/deploy artifact:** open a PR `security/audit-hardening → main`, review, then deploy the merged tag.

---

## Phase 0 — Ship the code baseline  *(low risk, immediate value)*

Delivers: web-app security headers, tamper-evident audit log, revocation-aware 401 client handling, hardened CI. RLS migration applies but stays **inert** (superuser bypass) until Phase 1. No feature is "activated" yet beyond headers.

1. **Set env** in Dokploy (server service):
   - `JWT_SECRET_ENCRYPTION_KEY=<base64-32>` — **the server will not boot without this.**
   - Confirm the already-required prod vars are set: `PUBLIC_URL`, `CORS_ALLOWED_ORIGINS`, `CENTRIFUGO_*`, `MASTER_API_KEY`, `TRUST_PROXY_CIDRS`, `S3_*`.
2. **Apply migrations** (additive; brief `ACCESS EXCLUSIVE` lock when RLS enables — low-traffic window):
   ```sh
   docker compose run --rm migrate
   ```
3. **Deploy** the new server + web images.
4. **Verify:**
   ```sh
   curl -sS -D - -o /dev/null https://chat.technext.it/ | grep -iE 'content-security-policy|strict-transport|x-frame|x-content-type'   # web headers present
   curl -sS -D - -o /dev/null https://chat.technext.it/api/openapi.json | grep -i 'content-security-policy'                            # API CSP present
   # audit log still records + chain intact after an admin action (rotate a test tenant key), then verifyAuditChain() → ok:true
   ```
5. **Rollback:** redeploy the previous tag. Migrations are additive — no down-migration needed; the old server ignores the new columns.

---

## Phase 1 — Activate Row-Level Security

RLS only enforces when the app connects as a **non-superuser** role. Prod has existing data, so grant on existing tables **and** set default privileges for future ones.

1. **On the prod DB, as the owner/superuser** (one-time):
   ```sql
   CREATE ROLE chatapp_app NOSUPERUSER LOGIN PASSWORD '<generated>';
   GRANT USAGE ON SCHEMA public TO chatapp_app;
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO chatapp_app;      -- existing tables
   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO chatapp_app;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO chatapp_app;  -- future
   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO chatapp_app;
   ```
2. **Set `APP_DATABASE_URL`** in the deploy env (the base compose routes the
   **server** to it while `migrate` keeps the owner URL — no compose edit):
   ```
   APP_DATABASE_URL=postgresql://chatapp_app:<pw>@postgres:5432/<db>
   ```
3. **Redeploy the server.**
4. **Verify enforcement** (as the app role):
   ```sql
   SET ROLE chatapp_app;
   SELECT set_config('app.current_tenant_id', '<a-real-tenant-id>', false);
   SELECT count(*) FILTER (WHERE tenant_id <> '<a-real-tenant-id>') AS should_be_0 FROM "user";   -- expect 0
   RESET ROLE;
   ```
   Also smoke the app: send a message, load conversations — all normal.
5. **Rollback:** point the `server` `DATABASE_URL` back at the owner role. RLS goes inert; **no data change.**

---

## Phase 2 — Field-level encryption of push keys

1. **Set** `FIELD_ENCRYPTION_KEY=<base64-32>` (DISTINCT from `JWT_SECRET_ENCRYPTION_KEY`) on the server; redeploy.
2. New push subscriptions store encrypted keys; existing plaintext rows keep working (decrypt passthrough). **No migration.**
3. *(Optional)* backfill existing rows by re-encrypting them once (a one-off script; not required).
4. **Rollback:** unset the key. New writes go back to plaintext; already-encrypted rows still decrypt as long as the key was set when they can still be read — so prefer keeping the key once enabled.

---

## Phase 3 — `pg_tde` transparent at-rest encryption  *(largest; downtime + Vault)*

Encrypts message content/email/all tables at rest while preserving search. Requires an image swap, a key store, and a **rewrite of existing tables** (they were created as plain `heap`).

1. **Stand up HashiCorp Vault** (or KMIP) reachable from the DB — the principal key must live **separate from the data** (the dev file-provider is a mechanism proof only).
2. **Switch the DB to Percona** via deploy env (the base compose already pins `PGDATA` + runs the entrypoint as root — no compose edit):
   ```
   POSTGRES_IMAGE=percona/percona-distribution-postgresql:17
   POSTGRES_COMMAND=postgres -c shared_preload_libraries=pg_tde
   ```
   *(Percona is PostgreSQL-compatible; restore your dump into it on a fresh volume.)*
3. **Enable + key (Vault provider):**
   ```sql
   CREATE EXTENSION pg_tde;
   SELECT pg_tde_add_global_key_provider_vault_v2('vault', :'token', :'url', :'mount', NULL);
   SELECT pg_tde_create_key_using_global_key_provider('principal', 'vault');
   SELECT pg_tde_set_default_key_using_global_key_provider('principal', 'vault');
   ALTER DATABASE <db> SET default_table_access_method = 'tde_heap';   -- future tables
   ```
4. **Encrypt existing tables** — run [`pg_tde-encrypt-existing-tables.sql`](./pg_tde-encrypt-existing-tables.sql) (idempotent; rewrites every `public` table to `tde_heap`). Low-traffic window; each takes an `ACCESS EXCLUSIVE` rewrite lock.
5. **Verify:** every table `amname = tde_heap`; a message sent via the API is **absent as plaintext** in the raw data file on disk (`pg_relation_filepath` + `grep`), yet reads back; app smoke passes.
6. *(Optional)* WAL encryption: `pg_tde_set_server_key_using_global_key_provider(...)` then `ALTER SYSTEM SET pg_tde.wal_encrypt=on` + restart.
7. **Rollback:** `ALTER TABLE … SET ACCESS METHOD heap` (decrypts back) and revert the image. **Take a verified backup before starting** — this phase touches every table.

> **Threat coverage:** pg_tde covers leaked-backup / stolen-disk. It does **not** stop a live rogue-DBA / SQLi read (transparent) — that's what RLS + least-priv roles + the DAST-clean API cover.

---

## Verification checklist (post go-live)
- [ ] Web + API security headers present (Phase 0)
- [ ] Admin audit chain `verifyAuditChain() → ok:true` (Phase 0)
- [ ] RLS: cross-tenant `should_be_0` check returns 0 as `chatapp_app` (Phase 1)
- [ ] App smoke: login, send/receive message, attachments, realtime (all phases)
- [ ] `FIELD_ENCRYPTION_KEY` set; a new push sub stores ciphertext (Phase 2)
- [ ] pg_tde: raw message file has no plaintext; app reads normally (Phase 3)
- [ ] Encrypted, **restore-tested** backup taken before Phase 3
- [ ] CI `security.yml` jobs flipped to **required status checks**

## CASA (separate track)
Confirm which component holds the Google restricted OAuth scopes (likely a tenant IdP, not this server). Then: run the authenticated ZAP scan against **staging**, fill the CASA workbook from `CASA_ASVS_GAP_CHECKLIST.md`, fill the placeholder contacts, engage an Authorized Lab.
