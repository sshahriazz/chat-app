# Security Documentation Index — CASA Tier 2 / OWASP ASVS

This folder holds the written deliverables an Authorized Lab expects for a CASA Tier 2 assessment (OWASP ASVS Level 1). Each maps to ASVS control areas.

| Document | Covers (ASVS) |
|---|---|
| [THREAT_MODEL.md](./THREAT_MODEL.md) | V1.1 threat modeling; V1.2 auth architecture; data-flow diagram + STRIDE + trust boundaries |
| [SECURE_SDLC.md](./SECURE_SDLC.md) | V1.1 secure SDLC; V14.2 build pipeline, SAST, dependency management, SBOM |
| [DATA_RETENTION_POLICY.md](./DATA_RETENTION_POLICY.md) | V8 data protection; retention, deletion, minimization, GDPR erasure |
| [INCIDENT_RESPONSE_PLAN.md](./INCIDENT_RESPONSE_PLAN.md) | V1 governance; V7 logging/monitoring-driven detection & response |
| [VULNERABILITY_DISCLOSURE_POLICY.md](./VULNERABILITY_DISCLOSURE_POLICY.md) | V1 coordinated disclosure |
| [OPS_HARDENING.md](./OPS_HARDENING.md) | V6/V8/V9/V14 infra: at-rest encryption (pg_tde/Vault), DB-TLS, least-priv roles, WAF/egress, key mgmt |
| [AUDIT_HARDENING_CHANGES.md](./AUDIT_HARDENING_CHANGES.md) | Breaking-change/integration notes: audit hash-chain, push-key encryption, RLS (+ activation) |

**Evidence produced elsewhere:**
- Control-by-control mapping → [../CASA_ASVS_GAP_CHECKLIST.md](../CASA_ASVS_GAP_CHECKLIST.md)
- Remediation changelog + frontend integration → [../CASA_TIER2_FIXES.md](../CASA_TIER2_FIXES.md)
- DAST reports (ZAP baseline + authenticated active) → `security-reports/` (gitignored; regenerate per release)
- CI (gitleaks, semgrep, pnpm audit, SBOM) → [../../.github/workflows/security.yml](../../.github/workflows/security.yml)

## Operator to-dos before lab submission
1. Confirm the security contact inbox (`security@technext.it` placeholder) and publish `/.well-known/security.txt`.
2. Fill on-call/escalation contacts in the incident-response plan.
3. Flip `security.yml` CI jobs to **required status checks**.
4. Run the authenticated ZAP scan against the deployed staging/prod instance; attach SSL Labs + Trivy image-scan reports.
5. Set `JWT_SECRET_ENCRYPTION_KEY` in prod and deploy the hardening branch.
