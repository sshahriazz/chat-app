# Audit-Hardening Changes — Breaking-Change & Integration Notes

**Branch:** `security/audit-hardening` · **Date:** 2026-07-26

Covers the three defense-in-depth changes: tamper-evident audit log, at-rest
encryption of push keys, and Postgres Row-Level Security. **TL;DR: no
existing HTTP API contract changes.** All impact is DB-migration + operator
configuration. Details below.

---

## 1. Tamper-evident admin audit log (hash chain)

| Aspect | Impact |
|---|---|
| **HTTP API** | **None.** `writeAdminAudit` signature unchanged; no endpoint or response shape changed. |
| **DB** | Migration `20260726130000_audit_log_hash_chain` adds two **nullable** columns (`prev_hash`, `hash`). Backward compatible — legacy rows stay null; the verifier starts the chain at the first hashed row. |
| **Behavior** | Audit appends now run inside a short transaction with an advisory lock (serialized). Audit writes are low-volume; negligible. |
| **New** | `verifyAuditChain()` is available for a cron/IR check (not yet wired to an endpoint or schedule). |

**Operator action:** deploy the migration (`prisma migrate deploy`). Nothing else.

---

## 2. Push-subscription keys encrypted at rest

| Aspect | Impact |
|---|---|
| **HTTP API** | **None.** Clients still send/receive plaintext `keys.p256dh`/`keys.auth`; encryption is purely at rest, server-side. |
| **DB** | **No migration.** Columns are already `TEXT`; ciphertext is a string. |
| **Behavior** | Gated on `FIELD_ENCRYPTION_KEY`: **unset → no change** (plaintext, current behavior); **set → new writes encrypt**, and existing plaintext rows still read (decrypt passes plaintext through). No backfill required. |

**Operator action (optional):** to enable, set a **new** env var:
```
FIELD_ENCRYPTION_KEY=<openssl rand -base64 32>   # base64, 32 bytes; DISTINCT from JWT_SECRET_ENCRYPTION_KEY
```
**Caveat:** if the key is later lost/rotated-away, rows encrypted under it can't be decrypted — those push sends are **skipped and logged**, never fatal (dispatch continues).

---

## 3. Postgres Row-Level Security (defense-in-depth tenant isolation)

| Aspect | Impact |
|---|---|
| **HTTP API** | **None.** No request/response changes. |
| **DB** | Migration `20260726140000_row_level_security` enables RLS + FORCE + a `tenant_isolation` policy on 8 tenant tables (`user`, `messages`, `attachments`, `reactions`, `conversations`, `conversation_members`, `push_subscriptions`, `deleted_external_id`). |
| **Behavior** | Each ORM query issued in an authenticated request now runs inside a per-query transaction that sets the `app.current_tenant_id` GUC (minor: one extra round-trip per query). Interactive transactions (message send, attachment-quota) and raw search queries are intentionally **not** wrapped and rely on the existing app-layer filters. |
| **Policy design** | **Fail-open-when-no-context**: when the GUC is unset (system/cron/admin/migration paths, and the auth-resolution queries that run before request context exists) the policy allows all rows — i.e. exactly today's behavior. When set, rows are restricted to that tenant. This is why the change is **non-breaking**. |

### ⚠️ CRITICAL activation requirement (not a breaking change, but required for the control to do anything)

**RLS is bypassed for PostgreSQL superusers and table owners** (the latter unless `FORCE`, which we set). The default app role (`chatapp`) is a **superuser** in the dev image and typically the table owner in prod — so **with the current connection role, RLS is silently bypassed: the app works unchanged, but RLS provides no enforcement.**

Verified: as a **non-superuser** role with `app.current_tenant_id='demo_acme'`, a filter-less `SELECT ... FROM "user"` returned **0** rows from `demo_beta` (correctly filtered). As the superuser it returned the beta row (bypassed).

**To activate enforcement**, connect the app as a dedicated non-superuser, non-owner role and point `DATABASE_URL` at it. Migrations keep running as the owner role.

```sql
-- One-time, run as the owner/superuser:
CREATE ROLE chatapp_app NOSUPERUSER LOGIN PASSWORD '<strong-password>';
GRANT USAGE ON SCHEMA public TO chatapp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO chatapp_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO chatapp_app;
-- Future tables/sequences created by later migrations:
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO chatapp_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO chatapp_app;
```
Then set the **app** connection (NOT the migration connection):
```
DATABASE_URL=postgresql://chatapp_app:<password>@<host>:5432/<db>
```

Until this role switch, RLS is inert (no enforcement, no breakage). See
[OPS_HARDENING.md](./OPS_HARDENING.md) §3.

**Dev already enforces it**: `docker/postgres-init/00-app-role.sql` creates
`chatapp_app` on fresh init (+ `ALTER DEFAULT PRIVILEGES` so migrate's
tables auto-grant), and `compose.dev.yml` points the dev **server** at it
while `migrate` stays the owner. So a `make dev-nuke && make dev` locally
runs with RLS active — the isolation suite then exercises real enforcement.

### GUC lifecycle (why the app doesn't break under enforcement)
Because Prisma pools connections, a naive per-query GUC would let one
request's tenant leak to the next. The extension therefore sets the GUC to
`''` (explicit reset, treated as fail-open by the policy) for every
no-context query, and the two interactive transactions set the GUC as their
own first statement. This was necessary: without it, the auth-time user
upsert failed WITH CHECK and interactive-tx writes weren't scoped.

---

## Verification performed
- `tsc` clean; audit-chain + field-crypto unit tests pass; audit chain proven end-to-end vs live DB (append→verify→tamper→detect).
- **RLS proven ENFORCING through the running app**: dev server connects as the non-superuser `chatapp_app`; isolation suite 6/6, message send 201 (interactive-tx path), full server suite 86/86, and a DB-level check as `chatapp_app` with `ctx=demo_acme` returns 0 `demo_beta` rows.

## Not done (follow-ups)
- Switch prod/staging `DATABASE_URL` to the non-superuser role (activation step above) — see DEPLOYMENT_RUNBOOK.md.
- Optionally expose `verifyAuditChain()` via a scheduled job/endpoint + alert.
- Optionally backfill existing push rows to ciphertext once `FIELD_ENCRYPTION_KEY` is set.
