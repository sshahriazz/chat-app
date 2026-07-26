# CASA Tier 2 — Remediation Changes & Frontend Integration

**Branch:** `security/casa-tier2-fixes`
**Date:** 2026-07-26
**Companion doc:** [CASA_ASVS_GAP_CHECKLIST.md](./CASA_ASVS_GAP_CHECKLIST.md)

This documents the code/config changes made to close the CASA Tier 2 (OWASP ASVS L1) **code** gaps, and exactly what — if anything — the frontend and operators must do to integrate.

---

## TL;DR for frontend integrators

**There is one client behavior change, and it is additive/robustness only — no API contract, request shape, or response shape changed.**

| Change | Client impact |
|---|---|
| Web client now handles **HTTP 401** by clearing the token and returning to the sign-in screen | Already applied in `apps/web` (`lib/api.ts`). Custom/native clients **should do the same** — see [§ Frontend integration](#frontend-integration). |

Everything else is server-internal or deploy-time (ops). **No breaking changes to any request/response.**

---

## Server changes

### 1. GDPR deletion-tombstone GC (ASVS V8.3) — `lib/tombstone-gc.ts`, `index.ts`
A nightly cron (03:20) purges expired `DeletedExternalId` rows once their 30-day stickiness elapses. Previously the migration promised this sweep but no job existed, so the table grew unbounded. Read-path behavior is unchanged (expired tombstones were already ignored). **No API impact.**

### 2. `JWT_SECRET_ENCRYPTION_KEY` required in production (ASVS V6.2) — `env.ts`
The server now **refuses to boot in production** if `JWT_SECRET_ENCRYPTION_KEY` is unset. Without it, every tenant's `jwtSecret` (the HMAC key behind all of that tenant's user JWTs) was stored in Postgres as plaintext. Still optional in dev. **⚠️ Deploy action required — see [§ Operator / deploy actions](#operator--deploy-actions).**

### 3. No email in GDPR-delete logs (ASVS V7.1) — `routes/users.ts`
The `gdpr: user deleted` log line no longer includes the deleted user's email. `userId` + attachment count remain for compliance tracing. **No API impact.**

### 4. Structured auth-denied security events (ASVS V7.2) — `index.ts`
Every 401/403/410 now also emits a distinct, greppable `event: "security.auth_denied"` log with the real socket peer IP (not the spoofable `X-Forwarded-For`), method, path (no query string), and error code — so a SIEM can alert on credential-stuffing / enumeration sweeps. **No API impact** (logging only).

### 5. Anti-malware advisory in prod (ASVS V12.6) — `env.ts`
When attachments are enabled (`S3_BUCKET` set) in production but `CLAMAV_HOST` is unset, the server logs a one-time boot **warning** recommending AV scanning. Non-fatal — magic-byte sniffing + private bucket + signed URLs remain the primary controls; ClamAV is documented as opt-in defense-in-depth. **No API impact.**

### 6. Supply-chain CI hardening (ASVS V10.3 / V14.2) — `.github/workflows/security.yml`
- `pnpm audit` threshold lowered from `high` → `moderate`.
- New **`sbom` job** generates a CycloneDX SBOM (`anchore/sbom-action`) and uploads it as a build artifact for the CASA workbook.

### 7. Email in user search — **kept, documented** (ASVS V8.2)
Decision: user-search / directory endpoints continue to return member email. This is an intentional, access-controlled in-tenant directory feature ("search users by name or email"). Recorded in the checklist as **N/A with rationale** rather than removed. **No change** to server or client.

---

## Frontend integration

### What changed in `apps/web` (already applied)
`lib/api.ts` `request()` now branches on **401**:

```ts
if (res.status === 401 && token && typeof window !== "undefined") {
  setAuthToken(null);                 // fires onAuthTokenChange(null) → useSession → <AuthForm/>
  if (window.location.pathname !== "/") window.location.replace("/");
}
```

**Why:** the server's revocation primitives — `POST /api/users/me/revoke` ("log out everywhere") and the `tokensValidAfter` horizon — cause every outstanding JWT to return **401**. Before this change the reference client surfaced a raw error and left the stale token in `localStorage`; now it drops the token and returns to sign-in, so revocation works end-to-end. This mirrors the existing **410 → `/account-deleted`** handling for GDPR deletion.

### What custom / native clients must do
If you maintain a non-web client (mobile, another SPA), replicate this contract:

| Server response | Meaning | Client must |
|---|---|---|
| **401** (`code: UNAUTHORIZED`) | Token missing/invalid/expired/**revoked** | Discard stored token, return user to sign-in. No silent retry (bearer-only; nothing to refresh). |
| **410** (`code: GONE`) | Account deleted (sticky 30 days) | Discard token, show "account deleted"; do **not** retry — a re-minted token for the same user is also rejected. |

No request/response payloads changed, so no schema or endpoint updates are needed — this is purely how the client should *react* to the two auth-termination statuses.

---

## Operator / deploy actions

1. **Set `JWT_SECRET_ENCRYPTION_KEY` in every production environment before deploying this branch**, or the server will refuse to boot:
   ```bash
   openssl rand -base64 32   # → set as JWT_SECRET_ENCRYPTION_KEY
   ```
   > First-time enablement only wraps **newly written** secrets; existing plaintext `Tenant.jwtSecret` rows are read transparently (`enc:v1:` prefix detection) but stay plaintext until rewritten (rotate via `POST /api/admin/tenants/:id/rotate-jwt-secret` to encrypt them at rest).
2. *(Optional, recommended)* Enable the ClamAV sidecar — uncomment the `clamav` block in `docker-compose.yml` and set `CLAMAV_HOST=clamav` / `CLAMAV_PORT=3310`. Otherwise the new boot warning documents the accepted residual risk.
3. In GitHub repo settings, flip the `security.yml` jobs (gitleaks, audit, semgrep, sbom, typecheck-test) to **required status checks** so they block merges.

---

## Verification

- `pnpm --filter @chat-app/server exec tsc --noEmit` → clean
- `pnpm --filter @chat-app/server test` → passing
- `pnpm --filter @chat-app/web exec tsc --noEmit` → clean
