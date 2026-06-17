# Frontend Integration — Breaking Changes

A focused upgrade guide for anyone building a **frontend / client** against the chat-app API (the reference web app in `apps/web`, a mobile/native client, or a third-party SPA). Server-only / operator concerns are in [`BREAKING_CHANGES.md`](./BREAKING_CHANGES.md); this file is just the code you write.

> **TL;DR for the impatient.** The bucket went private, the upload flow switched from PUT to multipart POST, the attachment URL in your message payload no longer renders directly, JWTs need an `aud` claim, max token TTL is 1h, and a few input shapes got tighter. Everything else is additive.

---

## Table of contents

1. [Auth / JWT](#1-auth--jwt)
2. [Attachment upload flow (PUT → POST)](#2-attachment-upload-flow-put--post)
3. [Attachment rendering (private bucket)](#3-attachment-rendering-private-bucket)
4. [Sending messages (constraints)](#4-sending-messages-constraints)
5. [Push notifications](#5-push-notifications)
6. [Pagination cursors](#6-pagination-cursors)
7. [Avatars](#7-avatars)
8. [New endpoints](#8-new-endpoints)
9. [Account deletion (410 Gone)](#9-account-deletion-410-gone)
10. [CORS / cookies](#10-cors--cookies)
11. [Other status codes you'll start seeing](#11-other-status-codes-youll-start-seeing)
12. [Migration checklist](#12-migration-checklist)

---

## 1. Auth / JWT

### What changed
Tokens minted by your tenant backend **must** now carry the `aud` claim and **cannot** exceed a 1-hour lifetime. Both are enforced at verify time — non-conformant tokens get rejected with `401`.

The tenant backend mints the token; the **frontend never mints**, but it does need to know:
- a token's max useful life is 1h (so refresh more often),
- the **audience** the backend stamps is fixed.

### Required tenant-side mint change
```diff
  jwt.sign(payload, tenantJwtSecret, {
    issuer: tenantId,
+   audience: "chat-app",          // ⚠️ required
    algorithm: "HS256",
-   expiresIn: 86400,
+   expiresIn: 3600,               // max 1h; refresh from your backend
  });
```

### Frontend implications
- Cache the token's `exp` and re-fetch from your auth endpoint when within ~5 min of expiry.
- Treat **401** on any authenticated request as "stale token, re-fetch and retry".
- Treat **410** (new) as "this account was deleted — redirect to a goodbye / re-signup screen" (see §9).

### Other JWT-layer tightening (no frontend change needed, just FYI)
- `iss` is re-asserted to match the tenant the request routes to.
- String claims are length-capped (`name` ≤ 128, `image` ≤ 2048, `email` ≤ 254, `sub` ≤ 256, `scope` ≤ 128) and silently truncated above that.

---

## 2. Attachment upload flow (PUT → POST)

### What changed
`POST /api/attachments/upload-url` no longer returns a single presigned `uploadUrl` for an HTTP PUT. It now returns a **presigned POST policy** with conditions that enforce the exact `Content-Type` and a `content-length-range` cap **at the S3 layer**. You upload via multipart/form-data.

### Old response shape (⚠️ gone)
```json
{
  "attachmentId": "...",
  "uploadUrl": "https://.../bucket/key?X-Amz-Signature=...",
  "publicUrl": "...",
  "expiresIn": 90
}
```

### New response shape
```json
{
  "attachmentId": "...",
  "upload": {
    "url": "https://.../bucket/",
    "fields": {
      "key": "...",
      "Content-Type": "...",
      "Policy": "...",
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": "...",
      "X-Amz-Date": "...",
      "X-Amz-Signature": "..."
    }
  },
  "publicUrl": "...",
  "expiresIn": 90
}
```

### Old client code (⚠️ broken)
```ts
const presign = await api.post("/api/attachments/upload-url", { filename, contentType, size });
await fetch(presign.uploadUrl, {
  method: "PUT",
  headers: { "Content-Type": contentType },
  body: file,
});
```

### New client code
```ts
const presign = await api.post("/api/attachments/upload-url", { filename, contentType, size });

// Build a multipart/form-data body. The order of `fields` doesn't matter,
// but `file` MUST be appended LAST — S3 requires it.
const form = new FormData();
for (const [k, v] of Object.entries(presign.upload.fields)) {
  form.append(k, v);
}
form.append("file", file);

// Do NOT set Content-Type manually — the browser sets the multipart
// boundary. The "Content-Type" form FIELD (from `fields`) is what S3
// stores + enforces against the signed policy.
const res = await fetch(presign.upload.url, { method: "POST", body: form });
// S3 returns 204 (or 201 if success_action_status is set in fields).
if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
```

### What you'll see if you forget
- Bytes larger than `size` → S3 rejects with `EntityTooLarge`.
- A different `Content-Type` than what you declared → S3 rejects with `PolicyConditionFailed`.
- `file` not appended last → S3 rejects.

The reference implementation lives in [`apps/web/src/lib/upload.ts`](apps/web/src/lib/upload.ts).

---

## 3. Attachment rendering (private bucket)

### What changed
The object-storage bucket is now **private** (no anonymous read). The `attachment.url` field in every message payload now points at a URL that requires authentication — you can **no longer** put it directly in `<img src>` / `<a href>` / `<video src>`.

Two new endpoints replace direct URL use:

| Endpoint | Purpose | Returns |
|---|---|---|
| `GET /api/attachments/:id/view`     | Inline render (image / video / audio) | `{ url, expiresIn }` JSON |
| `GET /api/attachments/:id/download` | Force-download with `Content-Disposition: attachment` | `{ url, expiresIn }` JSON |

Both endpoints return **JSON, not a 302 redirect**, because a `<img src>` / `<a href>` cannot send your `Authorization: Bearer` header. Your authenticated API client fetches the JSON; you point the element at `res.url`.

### Important inline-safety rule
`/view` only returns an **inline** signed URL for `image/*`, `video/*`, `audio/*` (and explicitly never for SVG/XML — they can execute script). For anything else (PDF, zip, text), `/view` falls back to a forced-download URL.

### Both endpoints
- 404 on missing AND on "not authorized" alike (no existence oracle).
- Are rate-limited.
- Signed URL TTLs: view ~300s, download ~120s. Long enough for one render; bounded for leak exposure.

### Recommended client pattern
A small per-id cache so re-renders of the same message don't re-fetch:

```ts
// lib/attachment-url.ts
const cache = new Map<string, { url: string; staleAt: number }>();
const REFRESH_SKEW_MS = 30_000; // re-fetch a little before expiry

export async function getAttachmentViewUrl(id: string) {
  const hit = cache.get(id);
  if (hit && Date.now() < hit.staleAt) return hit.url;
  const res = await api.get(`/api/attachments/${encodeURIComponent(id)}/view`);
  cache.set(id, {
    url: res.url,
    staleAt: Date.now() + res.expiresIn * 1000 - REFRESH_SKEW_MS,
  });
  return res.url;
}

export function invalidateAttachmentViewUrl(id: string) {
  cache.delete(id);
}

export async function downloadAttachment(id: string, filename: string) {
  const res = await api.get(`/api/attachments/${encodeURIComponent(id)}/download`);
  const a = document.createElement("a");
  a.href = res.url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
```

### Rendering pattern
```tsx
function AttachmentImage({ attachment }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const triedRefresh = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setSrc(null); setFailed(false); triedRefresh.current = false;
    getAttachmentViewUrl(attachment.id)
      .then(u => !cancelled && setSrc(u))
      .catch(() => !cancelled && setFailed(true));
    return () => { cancelled = true; };
  }, [attachment.id]);

  const onError = () => {
    if (triedRefresh.current) { setFailed(true); return; }
    triedRefresh.current = true;
    invalidateAttachmentViewUrl(attachment.id);
    getAttachmentViewUrl(attachment.id).then(setSrc).catch(() => setFailed(true));
  };

  if (failed) return <BrokenAttachmentFallback name={attachment.filename} />;
  if (!src) return <AttachmentSkeleton w={attachment.width} h={attachment.height} />;
  return <img src={src} onError={onError} alt={attachment.filename} />;
}
```

### Compose-time previews
While the user is still composing a message, **don't** wait for the view URL. Use a local `URL.createObjectURL(file)` blob (only `attachmentIds` are sent on submit, so the `url` field in your compose state is preview-only):

```ts
const att = await uploadFile(file);
const previewUrl = file.type.startsWith("image/")
  ? URL.createObjectURL(file)
  : att.url;
setAttachments(prev => [...prev, { ...att, url: previewUrl }]);
// remember to URL.revokeObjectURL(previewUrl) on remove/send
```

Reference: [`apps/web/src/lib/attachment-url.ts`](apps/web/src/lib/attachment-url.ts) and the `AttachmentImage` component in [`apps/web/src/components/chat/MessageBubble.tsx`](apps/web/src/components/chat/MessageBubble.tsx).

---

## 4. Sending messages (constraints)

A handful of new server-side validations make malformed payloads `400` early.

| Constraint | New behavior |
|---|---|
| Tiptap nesting depth ≤ **32** | Deeper docs → `400` |
| Tiptap total node count ≤ **5000** | Bigger trees → `400` |
| ≤ **50** mention nodes per message | More → `400` |
| `clientMessageId`: `[A-Za-z0-9_-]+`, 1–256 chars | Spaces, `:`, `/`, etc. → `400` |
| Search `q`: `%` and `_` are now literal | Wildcards no longer work — strip them client-side if your UX promised wildcards |

UUIDs and nanoids already satisfy the `clientMessageId` rule. Don't construct your own values with colons / slashes / spaces.

---

## 5. Push notifications

### Endpoint host allowlist
`POST /api/push/subscribe` and `POST /api/push/unsubscribe` now reject any `endpoint` whose host isn't one of the known browser-push providers, and require `https`:

- `fcm.googleapis.com`
- `updates.push.services.mozilla.com`
- `*.notify.windows.com`
- `*.push.apple.com`

Browser `PushSubscription.endpoint` values already satisfy this. Custom / native clients must use a real push provider.

### Per-user scoping
- Subscribe with an `endpoint` that's already registered to **another user** → **409 Conflict**.
- Unsubscribe an `endpoint` you don't own → silently does nothing (you can't kill someone else's subscription).

Body shape (unchanged):
```json
{
  "endpoint": "https://fcm.googleapis.com/fcm/send/...",
  "keys": { "p256dh": "...", "auth": "..." }
}
```

---

## 6. Pagination cursors

The user-list cursor format (`/api/users/tenant`) is now **HMAC-signed**. Cursors remain **opaque strings** — keep passing them back verbatim. **Forged/tampered cursors are silently treated as "no cursor"**, so if you were constructing your own cursors (you shouldn't have been), stop.

```ts
// ✅ correct — always
const next = await api.get(`/api/users/tenant?cursor=${encodeURIComponent(cursor)}`);

// ❌ never construct cursors yourself
```

Message and conversation cursors (`before=<id>`) are unchanged — they're message ids and you pass them through as before.

---

## 7. Avatars

Avatars come from the **tenant JWT `image` claim** (an externally hosted URL). The legacy demo flow (settings page uploads a file to the now-private MinIO bucket and uses that URL as the avatar) renders only locally.

### Production: put a real CDN URL in the JWT
```ts
// in your tenant's mint-token call
jwt.sign({ sub, name, image: "https://cdn.example.com/avatars/u123.jpg", ... }, secret, opts);
```

The JWT `image` claim is length-capped to 2048 chars and is **not** scheme-validated server-side — your client renders it as an `<img src>`, so only send `https://` URLs.

### If you really need uploaded-via-MinIO demo avatars to work
Expose a public read prefix for avatars only (keep message attachments private). Apply a MinIO bucket policy in `minio-init` that grants anonymous `s3:GetObject` on `arn:aws:s3:::<bucket>/avatars/*`, and route avatar uploads under an `avatars/` key prefix.

---

## 8. New endpoints

| Method + path | What it does |
|---|---|
| `GET /api/attachments/:id/view` | Returns `{ url, expiresIn }` for inline rendering (image/video/audio); falls back to download URL for other types. |
| `GET /api/attachments/:id/download` | Returns `{ url, expiresIn }` for forced download. |
| `POST /api/users/me/revoke` | "Log out everywhere." Bumps the user's token-revocation horizon; every existing token (any device) is rejected until a fresh token is minted with `iat` after the call. Wire this to your "Sign out of all sessions" UI. |

---

## 9. Account deletion (410 Gone)

`DELETE /api/users/me` is now sticky. After the call, the `(tenantId, externalId)` is tombstoned for **30 days**; any authenticated request with a token for that user (even a freshly-minted one) is rejected with **410 Gone**.

### Client handling
```ts
try {
  const res = await api.get("/api/users/me");
  return res;
} catch (err) {
  if (err.status === 410) {
    // Account was deleted. Don't auto-retry, don't refresh the token.
    // Take the user to a "this account was deleted" screen.
    return navigate("/account-deleted");
  }
  throw err;
}
```

After 30 days the tombstone expires and the same `externalId` is free to re-register (e.g. the user signs up again).

---

## 10. CORS / cookies

The server now sends `Access-Control-Allow-Credentials: false` and expects **bearer-only** auth. If your client was using `credentials: "include"` to send cookies, **drop it** — there are no cookies to send.

```diff
  fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
-   credentials: "include",
+   // credentials default ("same-origin") is fine
  });
```

In production, the server's CORS allowlist also rejects non-https or localhost origins at boot — your prod origin must be `https://...`.

---

## 11. Other status codes you'll start seeing

| Code | Endpoint(s) | Meaning |
|---|---|---|
| **401** | any auth'd endpoint | Token invalid / expired / missing `aud` / TTL > 1h. Re-fetch and retry. |
| **404** | `/api/attachments/:id/view` and `/download` | Not found OR not authorized — both look the same now. Render a fallback; do not retry. |
| **409** | `POST /api/push/subscribe` | The endpoint is already registered to a different user. |
| **410** | any auth'd endpoint | Account was deleted (§9). |
| **413** | `POST /api/attachments/upload-url` | Per-user or per-tenant storage quota exceeded. |
| **429** | many | New rate limits (reactions 30/min/user, broadcast-profile 5/min/user, attachments + chat already existed). |

---

## 12. Migration checklist

- [ ] Tenant backend mints JWTs with `audience: "chat-app"` and `expiresIn: 3600` (or less).
- [ ] Refresh tokens proactively (under ~5 min before `exp`).
- [ ] Treat **401** as "re-fetch token and retry", **410** as "account deleted".
- [ ] Switch attachment uploads from `PUT` to multipart `POST` with `FormData` (fields first, `file` last); don't set `Content-Type` manually.
- [ ] Stop using `attachment.url` directly in `<img src>` / `<a href>` for rendered messages.
- [ ] Add the `/view` JSON fetch + signed-URL caching (§3 sample code).
- [ ] Use `URL.createObjectURL(file)` for compose-time previews; revoke on remove/send.
- [ ] Route downloads through `GET /api/attachments/:id/download` (JSON → click an anchor).
- [ ] Use only real push-provider endpoints; handle **409** on subscribe.
- [ ] Strip search `%` / `_` if your UI promised wildcards.
- [ ] Make sure `clientMessageId` (if you send one) is url-safe `[A-Za-z0-9_-]+`.
- [ ] Cap mentions per message at 50 (UX guard in addition to server enforcement).
- [ ] If you have a "Sign out of all sessions" UX, wire it to `POST /api/users/me/revoke`.
- [ ] If you have an avatar-upload UX, switch to tenant-provided external URLs in the JWT `image` claim (or set up the public `avatars/` prefix yourself).
- [ ] Drop `credentials: "include"` from your `fetch` options.
- [ ] Make sure your prod app origin is `https://` (the server now rejects non-https / localhost origins in its CORS allowlist).

---

## Reference implementation

The reference web client in `apps/web/` has all of these changes wired up. Pull patterns from:

| Concern | File |
|---|---|
| Auth-bearer API client | [`apps/web/src/lib/api.ts`](apps/web/src/lib/api.ts) |
| Attachment upload (presigned POST) | [`apps/web/src/lib/upload.ts`](apps/web/src/lib/upload.ts) |
| Signed view/download URL helpers | [`apps/web/src/lib/attachment-url.ts`](apps/web/src/lib/attachment-url.ts) |
| Inline image component | [`apps/web/src/components/chat/MessageBubble.tsx`](apps/web/src/components/chat/MessageBubble.tsx) |
| Compose-time blob previews | [`apps/web/src/components/chat/MessageInput.tsx`](apps/web/src/components/chat/MessageInput.tsx) |
| Push subscribe flow | [`apps/web/src/lib/notify.ts`](apps/web/src/lib/notify.ts) |

For full server-side / operator-facing changes, see [`BREAKING_CHANGES.md`](./BREAKING_CHANGES.md).
