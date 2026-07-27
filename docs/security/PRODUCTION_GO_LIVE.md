# Production Go-Live Runbook — Security Hardening

**Branch:** `security/audit-hardening` (merged to `main`; contains the CASA work too).
**Target:** Dokploy self-hosted (`chat.technext.it`).
**Verified locally:** prod images build; prod + dev compose render valid; server suite 86/86; RLS + pg_tde proven auto-activating on a fresh volume; DAST clean.

> **This runbook assumes a FRESH-START deploy** (empty database — existing data
> is discarded). On a fresh volume the full posture — Row-Level Security,
> pg_tde at-rest encryption, and push-key field encryption — **self-activates on
> first boot with no manual DB steps**. The only genuinely manual item left is
> the optional Vault key-store upgrade (§3). If you must preserve existing data,
> see [§5 Preserving existing data](#5-preserving-existing-data) — that path
> reintroduces the manual, phased activation.

---

## 0. Pre-flight (once)

1. **Generate the one required secret** you don't already have (keep it in the
   Dokploy env panel, never in git):
   ```sh
   openssl rand -base64 32   # JWT_SECRET_ENCRYPTION_KEY   (REQUIRED — server won't boot without it)
   openssl rand -base64 32   # FIELD_ENCRYPTION_KEY        (DISTINCT from above; enables push-key encryption)
   ```
2. **Fix CORS**: `CORS_ALLOWED_ORIGINS` must contain **https, non-loopback**
   origins only. A `http://localhost:3000` left in the list makes the server
   `exit(1)` at boot ([env.ts](../../apps/server/src/env.ts) prod guard).
3. **Deploy artifact**: merge `security/audit-hardening → main`, deploy the
   merged tag from Dokploy.

---

## 1. What auto-activates on a fresh deploy

No action needed — these come up on their own because the Postgres init scripts
in [`docker/postgres-init/`](../../docker/postgres-init/) run **once, on the
empty volume, before the `migrate` service creates the tables**. Ordinary
redeploys skip them (the role, keyring, and encryption persist in the volume).

| Control | Mechanism | Env needed |
|---|---|---|
| **Row-Level Security** | `00-app-role.sh` creates the NOSUPERUSER `chatapp_app` role + default privileges; the server's `DATABASE_URL` defaults to that role so RLS enforces (Postgres bypasses RLS for superusers). `migrate` keeps the owner role for DDL. | none — role reuses `POSTGRES_PASSWORD` |
| **pg_tde at-rest encryption** | Postgres defaults to the Percona image with `shared_preload_libraries=pg_tde`; `01-pg-tde.sh` enables the extension + makes `tde_heap` the DB-default access method, so every table is **born encrypted** (no rewrite). | none |
| **Push-key field encryption** | `lib/field-crypto.ts` reads `FIELD_ENCRYPTION_KEY`; the compose now passes it through. | `FIELD_ENCRYPTION_KEY` |
| **Web/API security headers, tamper-evident audit log, revocation-aware 401 client, hardened CI** | ships in the app/build. | — |

The volume was bumped `postgres_data_v2 → v3` so the init scripts are guaranteed
to hit an empty dir (they can't half-apply to a pre-existing volume).

---

## 2. Deploy + verify

1. **Set env** in Dokploy (server service): the existing required secrets
   (`POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `CENTRIFUGO_*`, `MINIO_ROOT_PASSWORD`,
   `CORS_ALLOWED_ORIGINS`, `PUBLIC_URL`, `S3_PUBLIC_URL_BASE`, `MASTER_API_KEY`)
   plus `JWT_SECRET_ENCRYPTION_KEY` and `FIELD_ENCRYPTION_KEY`. You do **not**
   set `APP_DATABASE_URL`, `POSTGRES_IMAGE`, or `POSTGRES_COMMAND` — the
   automated defaults handle those.
2. **Deploy.** The one-shot `migrate` service applies all migrations (as owner)
   before the server starts.
3. **Verify** (all should pass on a healthy fresh deploy):
   ```sh
   # web + API security headers
   curl -sS -D - -o /dev/null https://chat.technext.it/ | grep -iE 'content-security-policy|strict-transport|x-frame|x-content-type'
   curl -sS -D - -o /dev/null https://chat.technext.it/api/openapi.json | grep -i 'content-security-policy'
   ```
   ```sql
   -- RLS role is non-superuser
   SELECT rolname, rolsuper FROM pg_roles WHERE rolname = 'chatapp_app';   -- rolsuper = f

   -- every app table is encrypted at rest
   SELECT c.relname, a.amname FROM pg_class c JOIN pg_am a ON c.relam=a.oid
   WHERE c.relkind='r' AND c.relnamespace='public'::regnamespace ORDER BY 1;   -- amname = tde_heap

   -- RLS actually filters cross-tenant (run as the app role)
   SET ROLE chatapp_app;
   SELECT set_config('app.current_tenant_id', '<a-real-tenant-id>', false);
   SELECT count(*) FILTER (WHERE tenant_id <> '<a-real-tenant-id>') AS should_be_0 FROM "user";
   RESET ROLE;
   ```
   Plaintext-on-disk check: send a message via the API, then
   `grep` the raw relation file (`pg_relation_filepath`) — the content must be
   absent as cleartext yet read back through the app.
4. **Bootstrap tenants.** The database is empty — create tenants via the
   `MASTER_API_KEY`-gated `POST /api/admin/tenants` and rotate keys as needed.

---

## 3. Optional hardening — Vault key store for pg_tde

pg_tde ships with the **file provider**: the principal key lives in a file inside
`PGDATA`, i.e. on the same volume as the data. That gives at-rest encryption with
zero external infra, but it does **not** defend a stolen disk / leaked backup —
the key travels with the data. To get that protection, move the key into Vault:

1. Stand up **HashiCorp Vault** (or KMIP) reachable from the DB.
2. Register the Vault global provider and re-point the principal key:
   ```sql
   SELECT pg_tde_add_global_key_provider_vault_v2('vault', :'token', :'url', :'mount', NULL);
   SELECT pg_tde_create_key_using_global_key_provider('principal_key', 'vault');
   SELECT pg_tde_set_default_key_using_global_key_provider('principal_key', 'vault');
   ```
   No schema change and no table rewrite — the access method stays `tde_heap`;
   only the key custodian changes.
3. *(Optional)* WAL encryption:
   `pg_tde_set_server_key_using_global_key_provider(...)` then
   `ALTER SYSTEM SET pg_tde.wal_encrypt=on` + restart.

> **Threat coverage:** pg_tde (either provider) covers leaked-backup / stolen-disk
> only when the key is **separate** from the data (Vault) — the file provider does
> not. Neither stops a live rogue-DBA / SQLi read (encryption is transparent to an
> authenticated session) — that's what RLS + the least-priv `chatapp_app` role +
> the DAST-clean API cover.

---

## 4. Rollback

- **Whole deploy:** redeploy the previous tag. Migrations are additive (no
  down-migration needed); the old server ignores new columns.
- **RLS:** set `APP_DATABASE_URL` to the owner role (`chatapp`) — RLS goes inert,
  no data change.
- **pg_tde:** override `POSTGRES_IMAGE=postgres:17-alpine` +
  `POSTGRES_COMMAND=postgres` on a fresh volume (the init script skips itself
  when pg_tde isn't preloaded). To decrypt an existing encrypted volume in place:
  `ALTER TABLE … SET ACCESS METHOD heap` per table, then revert the image.

---

## 5. Preserving existing data

The fresh-start automation only fires on an **empty** volume. To harden a volume
that already has data, the init scripts won't run — do the activations manually,
each independently deployable and reversible:

1. **RLS** — as the DB owner: `CREATE ROLE chatapp_app NOSUPERUSER LOGIN
   PASSWORD '<pw>'`, grant SELECT/INSERT/UPDATE/DELETE on all existing tables +
   sequences, `ALTER DEFAULT PRIVILEGES … TO chatapp_app`, then set
   `APP_DATABASE_URL=postgresql://chatapp_app:<pw>@postgres:5432/<db>` and
   redeploy.
2. **Field encryption** — set `FIELD_ENCRYPTION_KEY`; new writes encrypt, legacy
   plaintext rows still read (no migration).
3. **pg_tde** — switch to Percona (`POSTGRES_IMAGE`/`POSTGRES_COMMAND`), enable
   the extension + a key provider, then rewrite existing tables with
   [`pg_tde-encrypt-existing-tables.sql`](./pg_tde-encrypt-existing-tables.sql)
   (idempotent; `ACCESS EXCLUSIVE` rewrite per table — maintenance window, take a
   verified backup first).

---

## Verification checklist (post go-live)
- [ ] Web + API security headers present
- [ ] `chatapp_app` is `rolsuper = f`; RLS `should_be_0` check returns 0
- [ ] Every app table `amname = tde_heap`; raw message file has no plaintext
- [ ] `FIELD_ENCRYPTION_KEY` set; a new push sub stores ciphertext
- [ ] Admin audit chain `verifyAuditChain() → ok:true`
- [ ] App smoke: create tenant, login, send/receive message, attachments, realtime
- [ ] Vault key store in place (or file-provider risk explicitly accepted)
- [ ] CI `security.yml` jobs flipped to **required status checks**

## CASA (separate track)
Confirm which component holds the Google restricted OAuth scopes (likely a tenant
IdP, not this server). Then: run the authenticated ZAP scan against **staging**,
fill the CASA workbook from `CASA_ASVS_GAP_CHECKLIST.md`, fill the placeholder
contacts, engage an Authorized Lab.
