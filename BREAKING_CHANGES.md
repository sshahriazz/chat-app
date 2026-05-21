# Breaking Changes — Security Hardening (Phases 1–6)

This release hardens the chat server (`apps/server`) following a security
review. Several changes alter the API/deploy contract. Read this before
upgrading a running deployment or a tenant integration.

Audience legend:
- 🛠 **Operator** — whoever deploys the stack (Dokploy / docker-compose).
- 🔌 **Tenant** — a third-party backend that mints user JWTs / calls webhooks.
- 💻 **Client** — the web app (`apps/web`) or any custom frontend.

---

## 1. 🛠 Operator — deploy & environment

### 1.1 New required environment variables
The stack now fails to boot if these are unset (no silent dev fallback):

| Var | Why | How to generate |
|-----|-----|-----------------|
| `REDIS_PASSWORD` | Redis now runs with `--requirepass`; every consumer URL embeds it. | `openssl rand -base64 24` |
| `CORS_ALLOWED_ORIGINS` | Now also consumed by the MinIO service (`MINIO_API_CORS_ALLOW_ORIGIN`). Must be your real app origin(s), comma-separated. | e.g. `https://chat.example.com` |

`POSTGRES_PASSWORD` was already required for the `postgres` service; it is
now also `:?required` in the `migrate`, `server`, and Centrifugo consumer
DSNs (previously fell back to `chatapp`). Make sure it is set.

### 1.2 Changed defaults
- `WEBHOOK_SIGNATURE_REQUIRED` now defaults to **`true`** (was `false`).
  See §2.3 — tenants must send a signature, or you must explicitly set this
  to `false` during a migration window.
- `TENANT_JWT_CLOCK_SKEW_SEC` default lowered to `5` (was `30`), capped at `60`.

### 1.3 Stricter validation (boot will fail fast)
- `MASTER_API_KEY`, if set, must be ≥ 43 chars of base64url/hex with ≥ 16
  unique chars. Short/low-entropy keys are rejected at boot.
- `JWT_SECRET_ENCRYPTION_KEY`, if set, must base64-decode to exactly 32
  bytes. Previously a malformed key was logged and ignored (silently
  storing tenant secrets in plaintext); now it aborts startup.

### 1.4 Database migrations (run before/with deploy)
Two new migrations must be applied (`prisma migrate deploy` runs them):
- `20260519100000_tokens_valid_after_and_deleted_externals`
  — `User.tokensValidAfter`, new `DeletedExternalId` table.
- `20260520100000_attachment_object_key`
  — `Attachment.objectKey`.

### 1.5 Object storage is now PRIVATE
- The MinIO bucket is no longer anonymously readable
  (`mc anonymous set none`). The init container no longer makes it public.
- All reads go through server-minted, membership-checked signed URLs.
- **Existing deployments**: if your bucket was already public, run
  `mc anonymous set none local/<bucket>` once after deploying, and ensure
  `Attachment.objectKey` is backfilled for old rows (new rows set it
  automatically; legacy rows fall back to deriving the key from the URL).

### 1.6 Centrifugo
- Admin UI is **disabled** in `centrifugo.json` (`admin.enabled: false`).
  Re-enable per-environment only behind an internal network if you need it.
- The `user:*` namespace is locked to server-side (token `subs`)
  subscriptions; clients can no longer self-subscribe to it.
- The Redis engine address is injected with credentials via
  `CENTRIFUGO_ENGINE_REDIS_ADDRESS`.

### 1.7 Secrets hygiene
`.env.example` no longer ships real-looking secrets — every secret slot is
a `__REPLACE_WITH__…__` placeholder. **Rotate any secret that previously
matched the committed example values** (Centrifugo token/api/admin, VAPID
keypair) if they were ever deployed verbatim.

---

## 2. 🔌 Tenant — integration contract

### 2.1 User JWTs must carry `aud: "chat-app"`  ⚠️ breaking
The server now requires the `audience` claim on every user token.

```diff
  jwt.sign(payload, tenantJwtSecret, {
    issuer: tenantId,
+   audience: "chat-app",
    algorithm: "HS256",
    expiresIn: 3600,
  });
```

Tokens without this claim are rejected with `401`.

### 2.2 Max token lifetime is 1 hour  ⚠️ breaking
Tokens whose `exp - iat` exceeds **3600s** are rejected (regardless of the
signature). Mint short-lived tokens and refresh; do not issue multi-hour
or multi-day tokens.

Other verify-time tightening (reject with 401 if violated):
- `iss` must equal the tenant id the token routes to.
- `sub`, `name`, `image`, `email`, `scope` are length-capped server-side
  (256 / 128 / 2048 / 254 / 128 chars). Overlong values are truncated for
  `name/image/email/scope`; a missing `sub` or `name` is rejected.

### 2.3 Webhooks require a signature by default  ⚠️ breaking
`POST /api/webhooks/*` now requires a valid `X-Chat-Signature`
(HMAC-SHA256 of the raw request body, keyed with the tenant API key)
unless the operator sets `WEBHOOK_SIGNATURE_REQUIRED=false`.

```
X-Chat-Signature: sha256=<hex(hmac_sha256(apiKey, rawBody))>
```

### 2.4 Account deletion is now sticky (GDPR)
After `DELETE /api/users/me`, the `(tenantId, externalId)` pair is
tombstoned for **30 days**. Tokens for that user are rejected with `410
Gone` during that window — the account will not be silently recreated by
the next authenticated request. Re-registration with the same `externalId`
is possible after the tombstone expires.

### 2.5 New endpoint: `POST /api/users/me/revoke`
"Log out everywhere." Bumps the user's token-revocation horizon; all
existing tokens (any device) are rejected until a fresh token (`iat` after
the call) is issued.

### 2.6 Rate limiting before auth
`/api/webhooks`, `/api/admin`, `/api/dev`, `/api/centrifugo` are now behind
a per-IP limiter (60 req/min/IP) that runs *before* credential
verification. Distribute webhook traffic accordingly.

---

## 3. 💻 Client — frontend contract

### 3.1 Attachments: fetch a signed URL, don't use `attachment.url`  ⚠️ breaking
Because the bucket is private and the server is bearer-auth only, you can
**no longer** put `attachment.url` directly into `<img src>` / `<a href>`,
and the download endpoint no longer 302-redirects.

**Old (broken now):**
```tsx
<img src={attachment.url} />
<a href={`${API}/api/attachments/${id}/download`}>Download</a>
```

**New:** both endpoints return JSON `{ url, expiresIn }` and must be called
through the authenticated API client; point the element at the returned
signed URL.

```ts
// inline render (image/video/audio)
const { url } = await api.get(`/api/attachments/${id}/view`);
img.src = url; // signed, needs no auth header, expires in ~300s

// download (any type; forces Content-Disposition: attachment)
const { url } = await api.get(`/api/attachments/${id}/download`);
// navigate / anchor-click to `url`
```

The reference web app implements this in
[`apps/web/src/lib/attachment-url.ts`](apps/web/src/lib/attachment-url.ts)
(with per-id caching + expiry refresh) and
[`MessageBubble.tsx`](apps/web/src/components/chat/MessageBubble.tsx)
(`AttachmentImage` component + `downloadAttachment`). For compose-time
previews use a local `URL.createObjectURL(file)` blob — only
`attachmentIds` are sent on submit, so the preview never needs the remote
URL.

Endpoint behavior notes:
- `/view` returns an **inline** signed URL only for image/video/audio.
  Non-inline-safe types (PDF, zip, text) and SVG/XML get a forced-download
  URL instead — they are never served inline (XSS prevention).
- `/view` and `/download` both return **404** for "not found", "wrong
  tenant", and "not authorized" alike (no existence oracle).
- Both are rate-limited (general limiter).

### 3.2 Avatars (demo limitation)  ⚠️ note
Avatar uploads via the Settings page write to the now-private bucket, so a
MinIO-hosted avatar URL will not render across users. In production the
avatar is supplied by the **tenant JWT `image` claim** (an externally
hosted URL). The Settings page shows a local blob preview of a freshly
picked image for feedback, but the saved URL only renders if it is
publicly reachable.

To keep demo avatar uploads working, expose a public read prefix for
avatars only (keeping message attachments private). Example MinIO policy
applied in `minio-init` (anonymous `GetObject` on `avatars/*` only):
```sh
mc anonymous set-json /tmp/avatars-policy.json local/<bucket>
# where the policy grants s3:GetObject on arn:aws:s3:::<bucket>/avatars/*
```
…and route avatar uploads under an `avatars/` key prefix. (Not implemented
here; message-attachment privacy is the priority.)

### 3.3 Push subscriptions: provider hosts only
`POST /api/push/subscribe` now rejects endpoints whose host isn't a known
push provider (`fcm.googleapis.com`, `updates.push.services.mozilla.com`,
`*.notify.windows.com`, `*.push.apple.com`) and requires `https`. Browser
`PushSubscription.endpoint` values already satisfy this; custom clients
must use a real provider endpoint. Subscribe/unsubscribe are also scoped
to the authenticated user (you can no longer unsubscribe another user's
endpoint).

### 3.4 Pagination cursors are signed (still opaque)
User-list cursors (`/api/users/tenant`) are now HMAC-signed. They remain
opaque strings — keep passing them back verbatim. Forged/tampered cursors
are ignored (treated as "no cursor"). No client change needed unless you
were synthesizing cursors yourself (don't).

### 3.5 Other limits that can surface as 4xx
- Max **50 mentions** per message → `400`.
- Reaction add/remove and `POST /me/broadcast-profile` are rate-limited
  (429 on abuse). Reactions: 30/min/user. Broadcast-profile: 5/min/user.
- Mention notifications to a muted user are throttled to 5/min per
  sender→recipient pair (silent; no error).

---

## 3a. 🛠 Operator — headers, infra & transport (Phase 6)

- **Strict CSP**: API responses now send `Content-Security-Policy:
  default-src 'none'`. `/docs` gets a Scalar-scoped policy (jsdelivr +
  api.scalar.com) instead of having CSP stripped. HSTS bumped to 2y +
  `includeSubDomains; preload`; `Permissions-Policy` denies
  camera/mic/geolocation. If you embed the API in an iframe or load
  cross-origin assets, review these.
- **CORS**: `credentials` is now `false` (no cookies are used). In
  production, boot **fails** if `CORS_ALLOWED_ORIGINS` contains a
  non-https or localhost/loopback origin — clean dev values out of the
  prod allowlist.
- **trust proxy**: prefer the new `TRUST_PROXY_CIDRS` (comma-separated
  proxy IPs/CIDRs) over the numeric `TRUST_PROXY` hop count — it stops
  X-Forwarded-For spoofing (rate-limit / admin-IP-allowlist bypass).
- **`/metrics`**: set `METRICS_TOKEN` to require `Authorization: Bearer
  <token>` on the Prometheus endpoint (returns 404 otherwise). Update
  your scraper config. If unset, keep it firewalled to an internal net.
- **Health probes**: `/livez` now returns `{ status: "ok" }` only and
  `/readyz` returns `{ status }` only (no per-dependency `db`/`redis`
  fields). Monitors parsing those fields should read the HTTP status
  code (readyz) or `/metrics` instead.
- **OpenAPI**: the public `/openapi.json` + `/docs` omit `/admin` and
  `/dev` routes.
- **Containers**: `docker-compose.yml` now drops all Linux capabilities
  (`cap_drop: ALL`, postgres re-adds initdb caps) + `no-new-privileges`,
  pins MinIO/mc to image digests, and removes the `web` host port
  binding (Traefik handles ingress). The server image runs as the
  non-root `node` user. Dev overlay ports bind to `127.0.0.1` only.
- New env vars: `TRUST_PROXY_CIDRS` (optional), `METRICS_TOKEN`
  (optional).

## 4. Upgrade checklist

- [ ] Set `REDIS_PASSWORD`, confirm `POSTGRES_PASSWORD` + `CORS_ALLOWED_ORIGINS`.
- [ ] Rotate any secret that matched the old `.env.example`.
- [ ] Run DB migrations (`prisma migrate deploy`).
- [ ] Make the bucket private; confirm `Attachment.objectKey` backfill plan.
- [ ] Tenants: add `aud: "chat-app"`, keep token TTL ≤ 1h, ship the webhook
      HMAC signer (or set `WEBHOOK_SIGNATURE_REQUIRED=false` temporarily).
- [ ] Clients: switch attachment rendering/downloads to the `/view` and
      `/download` JSON endpoints.
- [ ] Verify Centrifugo admin is disabled / internal-only.
