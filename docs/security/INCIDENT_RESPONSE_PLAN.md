# Incident Response Plan — chat-app

**Owner:** Engineering / Operations · **Last reviewed:** 2026-07-26 · **Cadence:** annual + post-incident review.

Supports CASA Tier 2 / OWASP ASVS V1 & V7. Companion: [THREAT_MODEL.md](./THREAT_MODEL.md), [DATA_RETENTION_POLICY.md](./DATA_RETENTION_POLICY.md).

> **Fill in before submission:** on-call contact, escalation chain, and the security inbox (see [VULNERABILITY_DISCLOSURE_POLICY.md](./VULNERABILITY_DISCLOSURE_POLICY.md)).

---

## 1. Roles
- **Incident Commander (IC)** — the operator on call; coordinates response, owns decisions, communications.
- **Responder(s)** — engineers with prod access executing containment/eradication.
- **Comms/DPO** — handles user/tenant notification and any regulatory (GDPR) reporting.

## 2. Severity levels
| Sev | Definition | Target response |
|---|---|---|
| **SEV1** | Confirmed breach / data exfiltration / auth bypass / secret leak in prod | Immediate (24/7) |
| **SEV2** | Exploitable vuln, no confirmed exploitation; partial outage | Same business day |
| **SEV3** | Low-risk vuln, degraded non-critical function | Next business day |

## 3. Detection sources
- **`security.auth_denied`** structured events (401/403/410 with actor IP, path, code) — alert on spikes (credential-stuffing / enumeration).
- **Admin audit log** (`admin_audit_log`) — unexpected `tenant.create` / key-rotation / admin actions or unfamiliar actor IPs.
- **Metrics** (`/metrics`, token-gated) — rate-limit rejections, outbox depth/lag, error rates.
- **CI signals** — gitleaks (leaked secret), `pnpm audit`/semgrep (new CVE/finding).
- **External reports** — via the vulnerability-disclosure inbox.

## 4. Response procedure (NIST-aligned)
### a. Identify & triage
Assign IC + severity; open an incident channel/ticket; correlate via `requestId` across access logs ↔ audit log.

### b. Contain
Choose the minimal effective action:
- **Compromised user token(s)** → `POST /api/users/me/revoke` (per-user "log out everywhere" via `tokensValidAfter`).
- **Compromised tenant `jwtSecret`** → rotate via admin `rotate-jwt-secret` (invalidates all that tenant's tokens; new secret encrypted at rest).
- **Compromised tenant API key** → rotate via admin `rotate-api-key` (webhook forgery requires key + HMAC sig).
- **Compromised `MASTER_API_KEY` / infra secret** → rotate in the deployment env + redeploy; admin surface also IP-allowlisted.
- **Active attack from an IP/range** → tighten `TRUST_PROXY_CIDRS` / edge (Cloudflare/Traefik) block; rate limits already Redis-backed.
- **Malicious upload** → delete S3 object + purge row; ClamAV path auto-purges infected files.
- **Worst case** → scale server to 0 / take offline at the edge.

### c. Eradicate
Patch the root cause on a branch → PR + CI gates → deploy. Rotate any exposed secrets. Confirm no persistence (unexpected users/tenants, orphan attachments).

### d. Recover
Redeploy fixed build; verify health (`/livez`, `/readyz`); confirm rate/auth metrics normal; lift temporary blocks. Restore from encrypted postgres backup only if integrity is in question.

### e. Post-incident
Within 5 business days: written post-mortem (timeline, root cause, blast radius, corrective actions), update this plan + [THREAT_MODEL.md](./THREAT_MODEL.md), add a regression test / CI rule.

## 5. Breach notification
If personal data is confirmed compromised, Comms/DPO assesses **GDPR obligations (notify the supervisory authority within 72 hours** of becoming aware, and affected users without undue delay where required). Notify affected tenants per contractual terms. Record the decision and rationale.

## 6. Preparation checklist (operator)
- [ ] On-call + escalation contacts filled in above.
- [ ] Log sink retains ≥ 30 days and is searchable by `requestId` / `security.auth_denied`.
- [ ] `METRICS_TOKEN` set; alerting wired to auth-denial spikes, error rate, outbox lag.
- [ ] Secret-rotation runbook rehearsed (tenant key/secret, master key).
- [ ] Encrypted, access-controlled postgres backups verified restorable.
