# CASA Tier 2 — ASVS Gap Checklist (chat-app server)

**Scope:** `apps/server` (multi-tenant chat backend) + `apps/web` reference client.
**Framework:** CASA Tier 2 = OWASP **ASVS 4.0.x Level 1** (the CASA Web Application Requirements workbook is an ASVS subset).
**Trigger:** Google OAuth restricted/sensitive-scope verification (annual re-assessment by an Authorized Lab).
**Assessed against:** `main` as of 2026-07-26.

> **How to use this:** Each row maps an ASVS control to the current implementation with a status and evidence pointer. Fill the Authorized Lab's workbook from the **Evidence** column. Close every ❌ **Gap** and 🟡 **Partial** before the DAST scan and lab submission.

> **Update 2026-07-26 — branch `security/casa-tier2-fixes`:** The code/config gaps below are now **closed**: tombstone GC cron (V8.3), `JWT_SECRET_ENCRYPTION_KEY` required in prod (V6.2), email dropped from GDPR-delete logs (V7.1), structured `security.auth_denied` events (V7.2), ClamAV prod advisory (V12.6), `pnpm audit` → moderate + CycloneDX SBOM job (V10.3), and email-in-search accepted as a documented directory feature (V8.2). Web client now handles **401** (revocation) → sign-in, matching the existing 410 handling. See [CASA_TIER2_FIXES.md](./CASA_TIER2_FIXES.md). **Remaining = documentation deliverables + DAST report** (below).

---

## 0. The critical trust-boundary assumption (state this up front to the lab)

This server is a **stateless, federated bearer-JWT resource server**. It **never sees end-user passwords**: tenants authenticate their own users (including any Google OAuth flow) and mint short-lived HS256 JWTs that this server only *verifies*. Consequently a large block of ASVS **V2 (passwords, lockout, MFA, password reset)** is **N/A — delegated to the tenant IdP**.

**You must document this trust boundary explicitly**, because:
1. It makes ~10 ASVS V2 rows legitimately N/A — the lab needs the written rationale, not silence.
2. **The OAuth security actually being verified lives in the tenant IdP, not here.** If the Google restricted-scope app *is* one of your tenants, that tenant's OAuth token handling is in CASA scope too. Confirm which component holds the Google OAuth client and scopes — that may be the real assessment target.

---

## Status legend

| | Meaning |
|---|---|
| ✅ | **Met** — implemented, evidence exists |
| 🟡 | **Partial** — mostly met, specific fix or evidence needed |
| ❌ | **Gap** — must close before submission |
| ⚪ | **N/A** — out of scope, *with documented rationale* |
| 📄 | **Doc-only** — control is satisfied but needs a written artifact for the workbook |

---

## V1 — Architecture, Design & Threat Modeling  *(mostly documentation)*

| Control | Requirement | Status | Evidence / Action |
|---|---|---|---|
| V1.1 | Secure SDLC documented | ✅ | [security/SECURE_SDLC.md](./security/SECURE_SDLC.md) |
| V1.1 | **Threat model / data-flow diagram** | ✅ | [security/THREAT_MODEL.md](./security/THREAT_MODEL.md) — DFD + STRIDE + trust boundaries |
| V1.2 | Authentication architecture documented | ✅ | [THREAT_MODEL.md §1](./security/THREAT_MODEL.md) — federated-JWT model + V2 delegation |
| V1.4 | Access control enforced at trusted layer | ✅ | Membership/tenant filtering in queries; see V4. |
| V1.5 | Input/output trust boundaries documented | ✅ | [THREAT_MODEL.md §2](./security/THREAT_MODEL.md) trust boundaries; enforced per V5. |
| V1.14 | Segregation of components (data flows) | ✅ | `docker-compose.yml` (8 services, `cap_drop:[ALL]`, non-root); DFD in THREAT_MODEL. |

**V1 documentation is now complete (`docs/security/`).**

---

## V2 — Authentication

| Control | Requirement | Status | Evidence / Action |
|---|---|---|---|
| V2.1 | No default/weak passwords | ⚪ | Server sees no passwords — delegated to tenant IdP. Document. |
| V2.2 | Anti-automation / brute-force controls | 🟡 | No login endpoint here; `preAuthIpLimiter` (60/min/IP) fronts crypto-verify routers (`index.ts:275-298`). **Gap:** primary authenticated JWT path (`/api/users`, `/api/attachments`) has only *post-auth* per-user limiters (`rate-limit.ts`). Document delegation + note pre-auth DoS coverage. |
| V2.3–2.6 | Password strength/reset/recovery | ⚪ | Delegated to tenant IdP. Document. |
| V2.7 | MFA available | ⚪ | Delegated to tenant IdP (no MFA in server). Document. |
| V2.8 | Time-based tokens / clock skew | ✅ | `clockTolerance` capped 60s; server TTL cap 1h (`jwt-tenant.ts:116,129-135`). |
| V2.10 | Service auth credentials not default, stored hashed | ✅ | Tenant API keys Argon2id-hashed (`tenant.ts:49-64`); master key SHA-256 + `timingSafeEqual` (`require-master-key.ts:81-83`). |
| — | JWT algorithm pinned (no `alg:none`/confusion) | ✅ | `algorithms:["HS256"]` (`jwt-tenant.ts:112-113`); `aud`=`chat-app`, `iss` double-checked. |
| — | Token revocation | ✅ | `tokensValidAfter` horizon + `POST /me/revoke` (`users.ts:342-357`, `require-user-jwt.ts:112-120`). |

---

## V3 — Session Management

| Control | Requirement | Status | Evidence / Action |
|---|---|---|---|
| V3.1 | No session tokens in URL | ✅ | Bearer header only; query strings stripped from logs. |
| V3.2 | Stateless tokens validated | ✅ | Per-request HS256 verify; no server sessions. |
| V3.3 | Logout / token invalidation | ✅ | `/me/revoke` bumps horizon + busts caches (`users.ts:353-355`). |
| V3.4/3.5 | Cookie flags (HttpOnly/Secure/SameSite) | ⚪ | **No cookies** — `credentials:false` CORS (`index.ts:175-181`). N/A, document. |
| V3.7 | Session/token TTL bounded | ✅ | 1h server-side cap on tenant JWTs. |
| — | **Client token storage** | 🟡 | Reference web client stores JWT in `localStorage` (`apps/web/src/lib/auth-token.ts:19`) → XSS-exposed, no HttpOnly. **Mitigated** by strict CSP `default-src 'none'` (`index.ts:138`). Document the CSP mitigation; expect the lab to raise this. |

---

## V4 — Access Control

| Control | Requirement | Status | Evidence / Action |
|---|---|---|---|
| V4.1 | Enforced server-side, deny by default | ✅ | `requireAuth` on all user routes; tenant + membership filters in queries (`chat.ts`). |
| V4.2 | No IDOR / object-level checks | ✅ | Attachment `/view`/`/download` membership-checked before signing; cross-tenant rows return 404. |
| V4.3 | Admin surface protected | ✅ | Master-key + IP allowlist via `req.socket.remoteAddress` (`require-master-key.ts`); dev routes 404 in prod; OpenAPI strips admin/dev. |
| — | Cursor integrity (no enumeration) | ✅ | HMAC-signed user-list cursors, constant-time verify (`users.ts:53-85`). |

---

## V5 — Validation, Sanitization & Encoding

| Control | Requirement | Status | Evidence / Action |
|---|---|---|---|
| V5.1 | Input validation (allowlist) | ✅ | Zod schemas repo-wide; `idParam()` uuid charset; `param()` fails-closed. |
| V5.2 | Sanitize untrusted HTML/rich text | ✅ | Tiptap depth(32)/node(5000) caps *before* `generateHTML` (`canonicalizeFromJson`). |
| V5.3 | Output encoding / injection defense | ✅ | Prisma parameterized; `escapeLike()` on ILIKE search (`lib/like-escape.ts`). |
| V5.3 | SSRF / URL scheme controls | ✅ | `httpUrl()` blocks `javascript:`/`data:`; push endpoint host-allowlist (FCM/Mozilla/Apple/Windows, https-only). |
| V5.5 | Deserialization safe | ✅ | JSON only; body limit 512KB + structural caps. |

---

## V6 — Stored Cryptography

| Control | Requirement | Status | Evidence / Action |
|---|---|---|---|
| V6.2 | Approved algorithms, no weak crypto | ✅ | AES-256-GCM envelope (`tenant.ts:89-103`); HMAC-SHA256; Argon2id; **no md5/sha1/`createCipher`/`Math.random`** for security. |
| V6.2 | Secrets encrypted at rest | 🟡 | `JWT_SECRET_ENCRYPTION_KEY` wraps tenant `jwtSecret` (AES-256-GCM, random 12B IV). **Gap:** key is **optional** → secrets stored **plaintext by default**. **Action:** make it required in prod (boot-fail if unset) and set it in prod env. |
| V6.3 | Random values from CSPRNG | ✅ | `crypto.randomBytes` for keys/IVs/tokens throughout. |
| V6.4 | Key management (32-byte validation) | ✅ | Boot-time exact-32-byte check (`env.ts:104-117`). |

---

## V7 — Error Handling & Logging

| Control | Requirement | Status | Evidence / Action |
|---|---|---|---|
| V7.1 | No sensitive data in logs | 🟡 | pino redacts authorization/cookie/password/token/secret/content (`logger.ts:20-38`); query strings stripped. **Gap:** email logged at info in GDPR-delete path (`users.ts:434-438`). **Action:** hash/drop email there or add to redact list. |
| V7.2 | Log security events (auth failures, access denials) | 🟡 | Denials centralize into terminal handler (4xx→warn, 5xx→error, `index.ts:313`). Admin mutations → append-only `admin_audit_log` (`lib/admin-audit.ts`). **Gap:** no structured per-denial security-event log (actor/IP) for non-admin auth failures. **Action:** add a structured `security.auth_denied` log event. |
| V7.4 | Generic error messages, no stack traces to client | ✅ | `DomainError` envelope; unknown → generic 500, stack **logged only** (`index.ts:376-385`). |
| — | No enumeration oracle | ✅ | `/metrics` 404 on bad token; cross-tenant → 404. |

---

## V8 — Data Protection & Privacy

| Control | Requirement | Status | Evidence / Action |
|---|---|---|---|
| V8.1 | Sensitive data cached/handled safely | ✅ | Only *wrapped* jwtSecret cached in Redis; unwrapped never cached (`tenant.ts:264-296`). |
| V8.2 | Data minimization (PII) | 🟡 | JWTs omit internal ids; `publicUserSchema` drops email. **Gap:** `searchUserResultSchema` returns email in search results (`openapi.ts:81-90`). **Action:** confirm this is intended/consented, or drop it. |
| V8.3 | Right to deletion (GDPR) | ✅ | `DELETE /api/users/me` hard-deletes + cascade + 30-day tombstone → 410 Gone (`users.ts:358-440`). |
| V8.3 | **Data retention policy** | ❌ 📄 | **Gap:** tombstone GC job **does not exist** — rows honored at read time but never physically purged (migration comment claims nightly GC). **Action:** (a) add the tombstone sweep cron, (b) **write a data-retention policy doc** (messages, attachments, tombstones, audit log, logs). |
| — | Attachment cleanup | ✅ | Delete-time enumeration + fire-and-forget purge; 6h orphan-GC cron (`lib/attachments-gc.ts`); optional ClamAV. |

---

## V9 — Communications

| Control | Requirement | Status | Evidence / Action |
|---|---|---|---|
| V9.1 | TLS everywhere, HSTS | ✅ 📄 | HSTS 2y+preload (helmet); prod boot rejects non-https CORS origins. **Action:** attach TLS config evidence (Traefik/Cloudflare) — note the Host-header/SigV4 caveat from prior work. |
| V9.2 | Strong TLS config | 📄 | Run SSL Labs against `chat.technext.it`, attach A/A+ report. |

---

## V10 — Malicious Code

| Control | Requirement | Status | Evidence / Action |
|---|---|---|---|
| V10.3 | Dependency integrity / no known-vuln deps | 🟡 | `pnpm audit --prod --audit-level high` in CI. **Action:** lower to `moderate` once baseline clean; generate an **SBOM** (CycloneDX) for the workbook. |
| — | Subresource / supply chain | ✅ | gitleaks + semgrep + pinned image digests (MinIO/mc); lockfile frozen in CI. |

---

## V11 — Business Logic

| Control | Requirement | Status | Evidence / Action |
|---|---|---|---|
| V11.1 | Anti-automation / rate limits per action | ✅ | Redis-backed per-user limiters: send 30/min, search 10/s, upload 30/min, reactions 30/min, etc. (`rate-limit.ts`). |
| — | Mention/push abuse throttle | ✅ | Per-recipient mention-push throttle (5/min); `MAX_MENTIONS_PER_MESSAGE=50`. |

---

## V12 — Files & Resources

| Control | Requirement | Status | Evidence / Action |
|---|---|---|---|
| V12.1 | Upload size/type limits enforced | ✅ | Presigned POST policy + magic-byte sniff deletes polyglots; server-derived extension from MIME. |
| V12.3 | Filename sanitization / path traversal | ✅ | RTL/control/NFC strip (`FILENAME_STRIP`); `objectKey` server-controlled. |
| V12.4 | Files served safely | ✅ | Private bucket; short-lived signed URLs (view 300s / download 120s); SVG/XML never inline; `Content-Disposition` forced for non-inline MIME. |
| V12.6 | Upload AV scanning | 🟡 | Optional ClamAV (`env.ts:155-170`). **Action:** enable in prod and document, or justify N/A. |

---

## V13 — API & Web Service

| Control | Requirement | Status | Evidence / Action |
|---|---|---|---|
| V13.1 | Auth on all API endpoints | ✅ | `requireAuth` gating; `/livez`/`/readyz` minimal. |
| V13.2 | CORS restrictive | ✅ | Allowlist, `credentials:false`, prod rejects non-https/localhost (`index.ts:175-181`). |
| V13.2 | Security headers | ✅ | helmet CSP `default-src 'none'`, `frame-ancestors 'none'`, Permissions-Policy, HSTS. **Note:** web app *root* had no CSP historically — confirm the browser app now ships headers. |
| V13.4 | No mass assignment | ✅ | Zod body schemas whitelist fields. |

---

## V14 — Configuration

| Control | Requirement | Status | Evidence / Action |
|---|---|---|---|
| V14.1 | Secure build / no secrets in repo | ✅ | gitleaks CI; `.env.example` placeholders; `${VAR:?required}` in compose. |
| V14.2 | Dependencies current, SAST in CI | ✅ | `security.yml`: gitleaks, pnpm audit, semgrep (`p/owasp-top-ten`), typecheck+tests. **Action:** flip these from non-blocking to **required status checks**. |
| V14.3 | No debug/dev features in prod | ✅ | Dev routes 404 in prod + master-key gate; metrics token-gated (404 on miss). |
| V14.4 | Security headers present | ✅ | See V13.2. |
| V14.5 | Container hardening | ✅ | Non-root `node`, `cap_drop:[ALL]`, `no-new-privileges`, pinned digests. |

---

## Priority action list (close before lab submission)

**Documentation (largest gap, no code):**
1. 📄 Threat model + data-flow diagram (V1.1) — trust boundaries: tenant IdP → JWT → server → data stores.
2. 📄 Auth-architecture doc stating the federated-JWT delegation (justifies all N/A V2 rows).
3. 📄 Secure-SDLC doc (references `security.yml`).
4. 📄 Data-retention & deletion policy (V8.3).
5. 📄 Incident-response + vulnerability-disclosure policy (CASA expects both).

**Code / config fixes — ✅ DONE on `security/casa-tier2-fixes`:**
6. ✅ Tombstone GC cron added (V8.3) — `lib/tombstone-gc.ts` + nightly schedule in `index.ts`.
7. ✅ `JWT_SECRET_ENCRYPTION_KEY` now required in prod (V6.2) — boot-fails if unset. *Operator must set it.*
8. ✅ Email removed from GDPR-delete log (V7.1) — `routes/users.ts`.
9. ✅ Structured `security.auth_denied` events on 401/403/410 (V7.2) — `index.ts`.
10. ✅ Email-in-search kept as documented, access-controlled directory feature (V8.2) → **⚪ N/A w/ rationale**.
11. ✅ ClamAV prod advisory warning added (V12.6); sidecar remains opt-in with documented compensating controls.
12. ✅ `pnpm audit` → `moderate` + CycloneDX SBOM job (V10.3). *CI "required status checks" is a repo-settings toggle — still to flip (V14.2).*

**Client:** ✅ Web `lib/api.ts` handles 401 (revocation/invalid token) → clear token + sign-in, mirroring 410 handling.

**DAST — ✅ RUN locally on `security/casa-tier2-fixes` (2026-07-26):**
- **ZAP baseline** (passive) vs local server: **0 FAIL / 2 WARN / 65 PASS** — both warns low-severity on 404 pages.
- **ZAP authenticated active API scan** (OpenAPI-seeded, bearer token injected, all 31 endpoints, full active battery — SQLi/XSS/traversal/cmd-injection/SSTI/XXE/Log4Shell/etc.): **0 FAIL / 0 High / 0 Medium / 118 PASS**. Only Low finding: "Unexpected Content-Type" ×42, all on `404` responses (benign — fuzzed IDs return 404 JSON). Reports in `security-reports/zap-baseline/report-auth.*`.
- CSP fix applied: `form-action 'self'` added to the Scalar `/docs` policy (closed ZAP rule 10055 for that route).

**Documentation deliverables — ✅ WRITTEN (`docs/security/`):**
13. ✅ [Threat model + DFD](./security/THREAT_MODEL.md), [Secure SDLC](./security/SECURE_SDLC.md), [Data-retention policy](./security/DATA_RETENTION_POLICY.md), [Incident-response plan](./security/INCIDENT_RESPONSE_PLAN.md), [Vuln-disclosure policy](./security/VULNERABILITY_DISCLOSURE_POLICY.md) + root `SECURITY.md` + `security.txt`. *(Operator: fill contacts, confirm security inbox.)*

**Still open — process + deploy (operator, not code):**
14. **Authenticated ZAP scan against staging/prod** for the lab submission — the local run above proves posture; the lab will want it run against the deployed instance (with authorization). SSL Labs report (V9.2); Trivy image scan; flip CI jobs to required.

---

## Process (Tier 2 mechanics)

1. Obtain the **CASA ASVS workbook** from the Google OAuth verification email or the Authorized Lab.
2. Fill every row from the **Evidence** column above.
3. Close the priority list; re-run `security.yml` + ZAP until clean.
4. Pick an **App Defense Alliance Authorized Lab**, submit workbook + ZAP report + architecture docs.
5. Answer lab clarifications; they issue the result to Google. Budget a few weeks + a lab fee; re-assessment is annual.
