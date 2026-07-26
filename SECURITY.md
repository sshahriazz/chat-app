# Security Policy

## Reporting a vulnerability
Please report security issues privately to **security@technext.it** *(confirm/replace with your monitored inbox)*.

Do **not** open a public issue for security reports. Our full policy — scope, safe harbor, and response targets — is in [docs/security/VULNERABILITY_DISCLOSURE_POLICY.md](docs/security/VULNERABILITY_DISCLOSURE_POLICY.md).

## Security documentation
This project maintains a CASA Tier 2 / OWASP ASVS-aligned security program:

- [Threat Model + Data-Flow Diagram](docs/security/THREAT_MODEL.md)
- [Secure SDLC](docs/security/SECURE_SDLC.md)
- [Data Retention & Deletion Policy](docs/security/DATA_RETENTION_POLICY.md)
- [Incident Response Plan](docs/security/INCIDENT_RESPONSE_PLAN.md)
- [Vulnerability Disclosure Policy](docs/security/VULNERABILITY_DISCLOSURE_POLICY.md)
- [CASA ASVS Gap Checklist](docs/CASA_ASVS_GAP_CHECKLIST.md) · [Remediation & Frontend Integration](docs/CASA_TIER2_FIXES.md)

Automated checks (secret scanning, SAST, dependency audit, SBOM, tests) run in [`.github/workflows/security.yml`](.github/workflows/security.yml).
