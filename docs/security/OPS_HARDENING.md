# Operational Hardening Runbook — chat-app

**Owner:** Operations / Engineering · **Last reviewed:** 2026-07-26 · **Cadence:** annual + on infra change.

Infrastructure-layer controls that complement the application hardening. Maps to CASA/ASVS V6/V8/V9/V14, SOC 2 (confidentiality, availability), and ISO 27001 Annex A. Companion: [THREAT_MODEL.md](./THREAT_MODEL.md).

> These are **operator actions** on the deployment (Dokploy host / Cloudflare / Vault). Track each as a ticket; most are one-time with periodic review.

---

## 1. Encryption at rest (data-at-rest)

Choose based on the "keep all search" constraint (see [THREAT_MODEL.md](./THREAT_MODEL.md) §5):

### Recommended: `pg_tde` (Percona TDE) + Vault principal key
Transparent DB-layer encryption of tables, indexes, and WAL. **Preserves 100% of search** (decrypts below SQL), with the principal key in Vault (key/data separation).
- Switch the DB image from `postgres:17-alpine` to **Percona Distribution for PostgreSQL** (ships `pg_tde`).
- Store the **principal key in HashiCorp Vault** (KMIP), not a local keyring file.
- Migrate the data directory; validate perf (~single-digit % overhead with AES-NI).
- **Covers:** leaked backup / stolen disk / compliance. **Does NOT cover:** live DB read / rogue DBA / SQLi (transparent = plaintext to any query).

### Baseline alternative: encrypted volume (LUKS / cloud disk)
Simpler, no DB change, but one key unlocks everything and no WAL/backup granularity. Use if you can't adopt Percona yet.

### Backups
Encrypt the dumps regardless of TDE: `pg_dump ... | age -r <recipient> > backup.age` (or gpg). Store off-host, access-controlled. **Test restores quarterly** — an untested backup is an audit finding.

### Field-level (app-layer) — for the rogue-DBA gap only
`lib/field-crypto.ts` (AES-256-GCM) encrypts **non-searched** sensitive columns so a live DB read yields ciphertext. Wire it to `push_subscription.p256dh`/`auth`, `attachments.filename`. Requires `FIELD_ENCRYPTION_KEY` (base64 32 bytes, **distinct** from `JWT_SECRET_ENCRYPTION_KEY`). Cannot cover messages/email (searched). E2E is the only "server-blind" option and is a separate opt-in project.

---

## 2. Encryption in transit

- **Client ↔ edge:** TLS via Cloudflare (have it) + HSTS 2y/preload (helmet).
- **Cloudflare ↔ origin:** set SSL/TLS mode to **Full (Strict)** and enable **Authenticated Origin Pulls** so only Cloudflare can reach Traefik. (Note: Cloudflare terminates TLS, so it sees plaintext — only E2E changes that.)
- **Server ↔ Postgres:** `sslmode=verify-full` in `DATABASE_URL` + server cert + `sslrootcert`. Encrypts the DB hop even on the private network.
- **Server ↔ Redis:** enable TLS (`rediss://`) if Redis is off-host; already password-gated (`--requirepass`).

---

## 3. Database least privilege

- **Separate roles:** the app connects as a role that can `SELECT/INSERT/UPDATE/DELETE` on app tables but **cannot** `DROP`/`ALTER`/`CREATE` or read `pg_authid`. Migrations run as a distinct, higher-privilege role used only by the `migrate` one-shot. Contains the blast radius of SQLi / a leaked app credential.
- **Dynamic credentials (best):** issue the app's Postgres creds from **Vault's database secrets engine** — short-lived, auto-rotating, per-lease audited. A leaked `DATABASE_URL` then expires in ~1h.
- **Row-Level Security** (tracked separately): `tenant_id` RLS policies as a second enforcement layer beneath the app filters — even a forgotten `WHERE` can't leak cross-tenant. Guarded by the cross-tenant isolation suite (`test/tenant-isolation.test.ts`).

---

## 4. Edge & network

- **Cloudflare WAF** (OWASP managed ruleset) + **Bot Management** + edge **rate limiting** in front of the app-layer limiters.
- **Egress filtering:** restrict the server's outbound to only Postgres, Redis, S3, Centrifugo, and the push/webhook host-allowlist it already enforces in code. Contains SSRF/exfil.
- **Network segmentation:** data stores stay off the public network (already true — only `server`/`web` are edge-routed).
- **DDoS:** Cloudflare absorbs volumetric attacks; app + edge rate limits handle application-layer floods.

---

## 5. Secrets & key management

- **Vault** as the system of record for: the field/JWT KEKs (or `pg_tde` principal key), dynamic DB creds, and infra secrets. Removes long-lived secrets from the app env.
- **Rotation schedule:** tenant API keys + `jwtSecret` via admin endpoints; `MASTER_API_KEY`, KEKs, DB creds via Vault. Document the cadence.
- **Boot validation** already fails closed on missing/dev-default prod secrets (`env.ts`).

---

## 6. Access, identity & governance (what SOC 2 / ISO grade hardest)

- **MFA everywhere** touching prod: Dokploy, GitHub, Cloudflare, Vault, cloud console.
- **Break-glass admin:** replace the static `MASTER_API_KEY` with time-bound, MFA-gated, fully-audited elevation (a permanent god-key is a finding). Admin surface is already IP-allowlisted + audit-logged.
- **Quarterly access reviews**; documented onboarding/offboarding (least privilege by default).
- **Security awareness training** + a named security owner.

---

## 7. Detection & response

- **Ship logs to a SIEM**; alert on `security.auth_denied` spikes, admin-audit anomalies, rate-limit storms, error-rate/outbox-lag (`/metrics`, token-gated).
- **Tamper-evident audit log** (tracked): hash-chain `admin_audit_log` so edits/deletions are detectable.
- **Canary rows / honeytokens** in the DB that page on any read.
- Runbook: [INCIDENT_RESPONSE_PLAN.md](./INCIDENT_RESPONSE_PLAN.md).

---

## 8. Supply chain & build

- CI: gitleaks + semgrep + `pnpm audit` (moderate) + CycloneDX SBOM + **Trivy** (IaC misconfig + fs CVE/secret) — see [`security.yml`](../../.github/workflows/security.yml). **Flip all to required status checks.**
- **Sign** commits + container images (sigstore/cosign); verify signatures at deploy (→ SLSA provenance).
- Pin every image by digest; `--frozen-lockfile` installs.

---

## Priority order (highest ROI first)
1. Encrypted volume/`pg_tde` + **tested** encrypted backups; MFA on all prod systems.
2. DB-TLS (`sslmode=verify-full`) + least-privilege DB role; Cloudflare Full(Strict) + Origin Pulls + WAF.
3. Vault (KEK/`pg_tde` key + dynamic DB creds); SIEM + alerting; Trivy + required CI checks.
4. RLS + tamper-evident audit log + field-level encryption of non-searched columns; egress filtering; signed builds.
