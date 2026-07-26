# Data Retention & Deletion Policy — chat-app

**Owner:** Engineering / Data Protection · **Last reviewed:** 2026-07-26 · **Cadence:** annual.

Supports CASA Tier 2 / OWASP ASVS V8 (data protection) and GDPR right-to-erasure. Companion: [THREAT_MODEL.md](./THREAT_MODEL.md).

---

## 1. Data inventory & retention

| Data | Store | Contains PII? | Retention | Deletion mechanism |
|---|---|---|---|---|
| User profile (`name`, `email?`, `image?`, `externalId`, `scope`, `lastActiveAt`) | postgres `user` | Yes | Life of the account; removed on user deletion | Hard delete on `DELETE /api/users/me` |
| Messages (`content`, `plainContent`) | postgres `messages` | User-generated | Until message soft-delete or account/conversation deletion | Soft-delete (`deletedAt`) hides content; cascade on account delete |
| Attachment metadata | postgres `attachments` | User files | Tied to message; orphans GC'd | Cascade on message/account delete |
| Attachment bytes | S3 (private) | User files | Same as metadata | Deleted on message/account delete; orphan GC every 6h; infected uploads purged (ClamAV) |
| Tenant records (`jwtSecret` wrapped, `apiKeyHash`) | postgres `tenant` | No (secrets) | Life of tenant | Admin tenant delete (cascades all tenant data) |
| Deletion tombstones (`deleted_external_id`) | postgres | tenant+externalId | **30 days**, then purged | Honored at read (410 Gone); **nightly GC** removes expired rows |
| Admin audit log | postgres `admin_audit_log` | actor IP, action | Retained for compliance/forensics (append-only; survives tenant deletion) | Manual/archival only — intentionally not auto-purged |
| Push subscriptions (`endpoint`, `p256dh`, `auth`) | postgres | Device keys | Life of subscription | Cascade on account delete; unsubscribe endpoint |
| Rate-limit counters / caches | redis | No (or wrapped) | Ephemeral (short TTL) | TTL expiry; caches busted on revoke/delete |
| Application logs | stdout / log sink | Redacted (no secrets/PII; query strings stripped) | Per log-sink policy (recommend ≤ 90 days) | Log-sink rotation |

## 2. User deletion (GDPR right-to-erasure)
`DELETE /api/users/me`:
1. Enumerates the user's S3 object keys.
2. **Hard-deletes** the `user` row; cascade removes members, messages, reactions, attachments (meta), push subs.
3. Writes a **30-day tombstone** (`deleted_external_id`) so a still-valid tenant JWT cannot silently re-materialize the user — `require-user-jwt` returns **410 Gone** while the tombstone is live.
4. Fire-and-forget purge of S3 bytes; any stragglers are swept by the orphan GC.
5. Emits a compliance audit log (`userId` + attachment count; **no email/PII**).

After 30 days the tombstone is GC'd and the `(tenantId, externalId)` pair is free to re-register.

## 3. Automated garbage collection (jobs in `apps/server`)
| Job | Schedule | Purpose |
|---|---|---|
| Orphan-attachment GC | every 6h (`5 */6 * * *`) | Delete uploaded-but-never-sent attachments + S3 bytes |
| Tombstone GC | nightly (`20 3 * * *`) | Purge expired `deleted_external_id` rows |
| ClamAV scan (optional) | on upload | Delete infected uploads + purge row |

## 4. Token & session lifetime
- Tenant user JWTs: server-enforced **max TTL 1 hour** (`exp - iat ≤ 3600`).
- Revocation horizon (`tokensValidAfter`): `/me/revoke` and account delete invalidate all outstanding tokens immediately (caches busted).
- Attachment signed URLs: view 300s / download 120s. Centrifugo connection token: 30s.

## 5. Data minimization
- JWTs exclude internal user ids; `email` is optional/display-only and dropped from member/sender payloads (`publicUserSchema`).
- Logs redact secrets/PII and strip query strings.
- Email in directory search is a deliberate, access-controlled in-tenant feature (documented in the ASVS checklist, V8.2).

## 6. Operator responsibilities
- Configure the log sink's retention (recommend ≤ 90 days) and access controls.
- Back up postgres; ensure backups are encrypted and access-controlled (backups contain wrapped secrets + user data).
- Periodically review the audit log retention/archival approach.
