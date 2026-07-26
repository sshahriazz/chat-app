# Secure Software Development Lifecycle (SDLC) — chat-app

**Owner:** Engineering · **Last reviewed:** 2026-07-26 · **Cadence:** annual (CASA re-cert) + on process change.

Supports CASA Tier 2 / OWASP ASVS V1.1 (secure SDLC) and V14.2 (build pipeline, dependency management).

---

## 1. Principles
- **Security is a merge gate, not an afterthought.** Automated checks run on every push/PR and are intended to be required status checks before merge.
- **Least privilege** in code (tenant/membership scoping), runtime (non-root containers, `cap_drop:[ALL]`), and secrets (env-validated, never committed).
- **Defense in depth** — no single control is trusted alone (see [THREAT_MODEL.md](./THREAT_MODEL.md)).

## 2. Change flow
1. Work happens on a feature branch off `main` (e.g. `security/casa-tier2-fixes`).
2. **Pull request** with human review required before merge to `main`. Reviewers check: authorization scoping, input validation, secret handling, and test coverage for the change.
3. **CI gates** (`.github/workflows/security.yml`) run on every push and PR:
   | Job | Tool | Gate |
   |---|---|---|
   | Secret scan | gitleaks (full history) | no committed secrets |
   | Dependency audit | `pnpm audit --prod --audit-level moderate` | no moderate+ advisories |
   | SAST | semgrep `p/owasp-top-ten` + `p/javascript` + `p/typescript` | no new findings |
   | Type + unit tests | `tsc --noEmit` + vitest | compile clean + tests pass |
   | SBOM | `anchore/sbom-action` (CycloneDX) | inventory artifact produced |
4. **Branch protection (operator action):** flip the jobs above to *required status checks* in GitHub repo settings so red CI blocks merge. (Currently non-blocking by default — see the header comment in `security.yml`.)
5. **Release:** annotated tag via `make tag VERSION=x.y.z`; images built strictly (no dev overlay) and deployed via Dokploy/Traefik.

## 3. Secure coding standards
- **Input:** allowlist validation with Zod at every boundary; `idParam()` charset checks; structural caps on rich text; `httpUrl()` scheme blocking.
- **Data access:** Prisma parameterized queries only; `escapeLike()` on `ILIKE`; all reads/writes tenant- and membership-scoped.
- **AuthN/Z:** verify tenant JWT (`aud`/`iss`/`exp`/skew/TTL cap); membership checks before object access and before signing attachment URLs.
- **Crypto:** `node:crypto` only; AES-256-GCM for at-rest secret wrap; Argon2id for API keys; HMAC-SHA256 + `timingSafeEqual` for signatures; `crypto.randomBytes` for all tokens/IVs. No `md5`/`sha1`/`Math.random` for security.
- **Output/errors:** generic client errors; stack traces logged only; PII redacted in logs; security headers via helmet.

## 4. Dependency & supply-chain management
- Lockfile committed; CI installs `--frozen-lockfile`.
- `pnpm audit` at `moderate` in CI; CycloneDX SBOM generated per run and retained as evidence.
- Container base + sidecar images pinned by digest where feasible; images run as non-root with dropped capabilities.
- Renovate/Dependabot-style updates (recommended) reviewed via the same PR + CI gate.

## 5. Secrets management
- All config validated by a single Zod schema (`env.ts`); the process **refuses to boot** on invalid/missing critical vars.
- Production hard-fails on: dev-default secrets, missing `PUBLIC_URL`, missing `JWT_SECRET_ENCRYPTION_KEY`, missing/loopback `CORS_ALLOWED_ORIGINS`, dev-default DB creds.
- `.env.example` ships placeholders only; compose uses `${VAR:?required}`; gitleaks guards regressions.
- Secret rotation: tenant API key + `jwtSecret` rotate via admin endpoints; `MASTER_API_KEY`/infra secrets rotate via the deployment env (see [DATA_RETENTION_POLICY.md](./DATA_RETENTION_POLICY.md) and the deployment runbook).

## 6. Testing & verification
- Unit/integration tests (vitest) gate merges.
- **DAST**: authenticated OWASP ZAP active scan (OpenAPI-seeded, all endpoints) run pre-release; reports retained in `security-reports/`.
- Threat model reviewed on any auth/data-flow change.

## 7. Roles
- **Author** — implements + tests + self-reviews against this standard.
- **Reviewer** — independent approval; owns the AuthZ/validation/secret checklist.
- **Operator** — manages env/secrets, branch protection, deploys, and incident response ([INCIDENT_RESPONSE_PLAN.md](./INCIDENT_RESPONSE_PLAN.md)).
