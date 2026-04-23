# Third-Party Integration Guide

This chat backend is **user-agnostic**: your app owns its users, you mint short-lived JWTs on their behalf, and the chat server materializes them lazily. No user sync, no shadow auth system, no double-login.

Throughout this guide, the chat server lives at `https://chat.technext.it/chat-api`. Replace that with whatever host your deployment runs on.

---

## Table of contents

1. [Architecture](#1-architecture)
2. [Onboarding your tenant](#2-onboarding-your-tenant)
3. [Minting user JWTs](#3-minting-user-jwts)
4. [Scopes — partitioning inside a tenant](#4-scopes--partitioning-inside-a-tenant)
5. [Token lifecycle & refresh](#5-token-lifecycle--refresh)
6. [Calling the chat API](#6-calling-the-chat-api)
7. [Data shapes](#7-data-shapes)
8. [Endpoint reference](#8-endpoint-reference)
9. [Pagination](#9-pagination)
10. [Idempotency & retries](#10-idempotency--retries)
11. [Message content format (Tiptap JSON)](#11-message-content-format-tiptap-json)
12. [File attachments](#12-file-attachments)
13. [Realtime (Centrifugo)](#13-realtime-centrifugo)
14. [Realtime event catalog](#14-realtime-event-catalog)
15. [Web Push notifications](#15-web-push-notifications)
16. [Webhooks](#16-webhooks)
17. [Rate limits](#17-rate-limits)
18. [Error responses](#18-error-responses)
19. [Security](#19-security)
20. [Troubleshooting](#20-troubleshooting)

---

## 1. Architecture

```
┌──────────────────┐   1. your user logs in  ┌──────────────────┐
│  YOUR FRONTEND   │ ──────────────────────▶ │   YOUR BACKEND   │
└──────────────────┘                         └──────────────────┘
         │                                              │
         │          2. mint a user JWT signed           │
         │            with your tenant's jwtSecret      │
         │ ◀──────────────────────────────────────────  │
         │                                              │
         │                                              │ 3. (optional) webhooks
         │                                              │    on profile change
         │  4. call chat API with                       │
         │     Authorization: Bearer <jwt>              │
         ▼                                              ▼
┌──────────────────────────────────────────────────────────────┐
│                       CHAT SERVER                            │
│  • verifies JWT with your tenant's secret                    │
│  • upserts a User row on first request (lazy)                │
│  • exposes chat + realtime APIs                              │
└──────────────────────────────────────────────────────────────┘
```

**Three layers of isolation**, each independent and composable:

| Layer | Enforced by | Controls |
|---|---|---|
| Tenant | `tenantId` on every query | One third-party can't see another's data. |
| Scope | `User.scope` on user discovery | Inside one tenant, partition users into contexts (project chats, support tickets, deal rooms). |
| Conversation | `ConversationMember` on reads/writes | Once a conversation exists, only its members see it. |

**Two secrets per tenant**, both surfaced exactly once at tenant creation:

| Secret | Owner | Used for | Renewable |
|---|---|---|---|
| `apiKey` | your backend only | server-to-server calls: webhooks, admin | yes — via rotate |
| `jwtSecret` | your backend only | signing user JWTs | yes — invalidates every live token |

Your **frontend never sees** `apiKey` or `jwtSecret`. It only sees short-lived user JWTs minted by your backend.

---

## 2. Onboarding your tenant

Ask the operator of this chat server to create a tenant for you. They will run:

```bash
curl -X POST https://chat.technext.it/chat-api/admin/tenants \
  -H "Authorization: Bearer $MASTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "Acme Corp"}'
```

Response:

```json
{
  "id": "tnt_abc123",
  "name": "Acme Corp",
  "apiKey": "k_9f8e7d6c...",
  "jwtSecret": "s_1a2b3c4d..."
}
```

**Store all three values in your backend's secret manager immediately.** `apiKey` and `jwtSecret` are shown exactly once — if you lose them, the only recovery is rotation (which invalidates the old values).

---

## 3. Minting user JWTs

Every request from your frontend to the chat server carries a JWT signed with your tenant's `jwtSecret`. The JWT is short-lived (≤ 1 hour is a good default). Your backend is the only party that signs them — never ship `jwtSecret` to the browser.

### Claims

| Claim | Required | Max length | Description |
|---|---|---|---|
| `sub` | ✅ | 256 | Your own user id. Stored on the chat server as `User.externalId`. Stable across tokens. |
| `iss` | ✅ | — | Your tenant id (e.g. `tnt_abc123`). Tells the chat server which `jwtSecret` to verify with. |
| `name` | ✅ | 128 | Display name. Embedded in realtime events so peers see it without extra lookups. |
| `image` | optional | 2048 | Avatar URL (must be a valid URL). |
| `email` | optional | 254 | Display-only — the chat server does not use it for auth or dedup. |
| `scope` | optional | 128 | Second-level partition inside your tenant. See §4. |
| `exp` | ✅ | — | Expiry timestamp (seconds since epoch). |
| `iat` | ✅ | — | Issued-at timestamp (seconds since epoch). |

Algorithm: **HS256**. No other algorithm is accepted — tokens signed with RS256, none, or anything else fail with `401 Invalid user token`.

Clock skew tolerated: **± 30 seconds** by default (configurable per deployment via `TENANT_JWT_CLOCK_SKEW_SEC`).

### Node.js (`jsonwebtoken`)

```ts
import jwt from "jsonwebtoken";

export function mintChatToken(
  userId: string,
  name: string,
  opts: { image?: string; scope?: string | null; ttlSeconds?: number } = {},
) {
  return jwt.sign(
    {
      sub: userId,
      name,
      image: opts.image,
      // Omit `scope` entirely when undefined so you don't accidentally
      // stamp `scope: undefined` onto a tenant-wide user's token.
      ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
    },
    process.env.CHAT_JWT_SECRET!,
    {
      issuer: process.env.CHAT_TENANT_ID!,
      expiresIn: opts.ttlSeconds ?? 3600,
      algorithm: "HS256",
    },
  );
}
```

### Python (`PyJWT`)

```python
import jwt, time, os

def mint_chat_token(user_id: str, name: str, *, image=None, scope=None, ttl=3600):
    now = int(time.time())
    claims = {
        "sub": user_id,
        "name": name,
        "iss": os.environ["CHAT_TENANT_ID"],
        "iat": now,
        "exp": now + ttl,
    }
    if image is not None:
        claims["image"] = image
    if scope is not None:  # pass "" to unset existing scope? No — the server ignores whitespace-only
        claims["scope"] = scope
    return jwt.encode(claims, os.environ["CHAT_JWT_SECRET"], algorithm="HS256")
```

### Go (`github.com/golang-jwt/jwt/v5`)

```go
func MintChatToken(userID, name string, opts ...TokenOpt) (string, error) {
    now := time.Now()
    claims := jwt.MapClaims{
        "sub":  userID,
        "name": name,
        "iss":  os.Getenv("CHAT_TENANT_ID"),
        "iat":  now.Unix(),
        "exp":  now.Add(time.Hour).Unix(),
    }
    for _, opt := range opts { opt(claims) }
    tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
    return tok.SignedString([]byte(os.Getenv("CHAT_JWT_SECRET")))
}
```

### Expose a mint endpoint on your backend

```
GET /api/chat-token   →  { token: string, expiresAt: number }
```

Your frontend hits this on boot and again whenever the current token is within ~5 minutes of expiry. Set `Cache-Control: no-store` on the response.

---

## 4. Scopes — partitioning inside a tenant

Use `scope` when one tenant hosts many independent chat contexts and users in one context shouldn't discover or message users in another.

| Example | Who gets which scope |
|---|---|
| Per-project chats | project members: `scope: "project_42"`; PMs who jump between: no scope |
| Support tickets | customer: `scope: "cust_123"`; support agents: no scope |
| Deal rooms / CRM clients | external party: `scope: "deal_a"`; internal staff: no scope |
| Team-wide (Slack-style) | nobody scoped — tenant-wide |

### Rules the server enforces

- A **scoped** user (`scope: "X"` in the JWT) can only find + add users whose `scope` is `"X"` or `null`.
- An **unscoped** user (no `scope` claim or `scope: null`) can find + add any user in the tenant. Use this for support agents, admins, and internal staff who span scopes.
- Scope is **only** enforced on user discovery (`/users/search`, `/users/online`, add-member, conversation-create). Once a conversation exists, membership is the only check — a scoped customer and an unscoped agent can chat freely in a conversation they both belong to.
- The `User.scope` column updates on every auth when the JWT supplies a different `scope`. **Omit the claim** to leave the stored value untouched — useful when a webhook doesn't know the scope. Setting `scope: null` explicitly re-promotes the user to tenant-wide.

### Scope transitions (a user moves from project A to project B)

Re-mint their JWT with the new scope. The very next authenticated request re-materializes `User.scope`. Any live Centrifugo subscriptions stay valid — scope only affects *future* user discovery, not existing membership.

```ts
// On your backend when assignment changes
const token = mintChatToken(user.id, user.name, { scope: "project_b" });
// Push it to the browser (e.g. via a websocket event on your own channel) and
// the next chat-server request re-materializes scope. No force-logout needed.
```

If you need a user to see **multiple scopes simultaneously** (e.g. an engineer on two projects), give them different `externalId`s per scope: `alice@acme.com__project_a` and `alice@acme.com__project_b`. They'll appear as two separate users on the chat server side with different internal UUIDs and different conversation lists. Or: mark them tenant-wide (`scope: null`) if they should span everything.

---

## 5. Token lifecycle & refresh

### Mint → use → expire

```
 t=0      t=3300s                t=3600s
  │          │                      │
  ▼          ▼                      ▼
 mint ──────────── valid ───────────┼────── rejected (401 Invalid user token)
             │                      │
             └── refetch /chat-token so the new token overlaps the old
```

### Recommended client strategy

1. On app boot, fetch `/chat-token` from your backend once.
2. Decode the `exp` claim client-side (no signature verification needed) to know when it expires.
3. When ~5 minutes from expiry, refetch `/chat-token`. Store the new token atomically.
4. For Centrifugo, wire up `getToken` so the WebSocket lib can refetch on its own schedule (Centrifugo connection tokens are separate — they come from `/chat-api/init`).

The reference web app in this repo does exactly this: see [apps/web/src/lib/auth-token.ts](../web/src/lib/auth-token.ts) and [apps/web/src/context/ChatContext.tsx](../web/src/context/ChatContext.tsx).

### What happens mid-session if a token expires?

HTTP requests: `401 Invalid user token`. The client should detect `401` on any chat-server call, refetch `/chat-token`, and retry.

WebSocket: Centrifugo calls your configured `getToken` function before the token expires. If `getToken` throws or returns an expired token, the connection drops; Centrifugo auto-reconnects on a backoff once you return a fresh token.

### JWT secret rotation

If the operator (or you) rotates the tenant's `jwtSecret` via the admin API, **every live token is invalidated instantly**. Your backend must coordinate the swap:

1. Update your secret manager to the new `jwtSecret`.
2. Existing JWTs in browsers still reference the old secret → they fail on the next request.
3. Browser retries `/chat-token` → your backend mints a new one with the new secret → requests succeed.

There's a brief window (seconds) where users see `401` and retry. The reference client handles this transparently.

---

## 6. Calling the chat API

Every chat-server request needs `Authorization: Bearer <jwt>` and (for writes) `Content-Type: application/json`.

```ts
const res = await fetch("https://chat.technext.it/chat-api/me", {
  headers: { Authorization: `Bearer ${chatToken}` },
});
const me = await res.json();
// me.id = chat-server internal UUID — use this for senderId, channel names, etc.
```

### Internal id vs externalId

The server exposes an **internal user id** (UUID) that's distinct from your `externalId`:

- `externalId` — your id. Stable, lives in the JWT `sub` claim, stored on `User.externalId`.
- `id` — chat-server UUID. Stable after first mint. Used for `senderId`, Centrifugo channels, FK references.

Your frontend stores the internal `id` after the first `GET /me` call. That's what you'll see in every event the chat server emits (`message.senderId`, channel names like `user:<id>`, `conversation.createdBy`, etc).

---

## 7. Data shapes

The canonical shapes the server returns, all typed in [apps/web/src/lib/types.ts](../web/src/lib/types.ts).

### User

```ts
interface User {
  id: string;              // chat-server internal UUID
  name: string;
  email: string;           // may be "" if no email claim
  image: string | null;
  lastActiveAt?: string | null;  // ISO timestamp, optional
}
```

### Conversation

```ts
interface Conversation {
  id: string;
  type: "direct" | "group";
  name: string | null;     // null for direct; group name for group
  createdBy: string;       // internal user id
  createdAt: string;
  updatedAt: string;
  version: number;         // bumps on member change, rename
  members: ConversationMember[];
  unreadCount?: number;    // per-caller, on list endpoints
  muted?: boolean;         // per-caller, on list endpoints
  lastMessage?: Message | null;  // most recent non-deleted
}

interface ConversationMember {
  id: string;
  conversationId: string;
  userId: string;
  role: "owner" | "admin" | "member";
  joinedAt: string;
  unreadCount: number;
  lastReadMessageId: string | null;
  lastReadAt: string | null;
  muted: boolean;
  user: User;
}
```

### Message

```ts
interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  content: MessageContent;        // Tiptap JSON — see §11
  plainContent: string;           // flat text mirror
  type: "text" | "system" | "image";
  seq: number;                    // monotonic within a conversation
  clientMessageId: string | null; // your dedup key — see §10
  replyTo: {
    id: string;
    content: MessageContent;
    plainContent: string;
    senderId: string;
    sender: { id: string; name: string };
  } | null;
  attachments: Attachment[];
  reactions: Reaction[];
  editedAt: string | null;
  deletedAt: string | null;       // soft-delete marker; UI should gray out
  createdAt: string;
  sender: { id: string; name: string; image: string | null };
}

interface Reaction {
  id: string;
  emoji: string;      // ≤16 chars (grapheme cluster)
  userId: string;
  user: { id: string; name: string };
}
```

### Attachment

```ts
interface Attachment {
  id: string;
  url: string;         // publicly accessible S3 URL
  contentType: string; // MIME type the uploader declared
  filename: string;
  size: number;        // bytes
  width: number | null;   // pixels, for images
  height: number | null;
}
```

---

## 8. Endpoint reference

Full interactive playground: **`https://chat.technext.it/chat-api/docs`**.

Every authenticated endpoint requires `Authorization: Bearer <jwt>`.

### Path conventions in this doc

Paths below are **mount-relative** — they don't include a leading `/api` or `/chat-api`. The actual base URL depends on how the operator exposed the API:

| Deploy shape | Base URL |
|---|---|
| Direct to the server container | `http://host:3001/api` |
| Same-origin Next.js proxy | `https://host/api` |
| Path-prefix ingress (Dokploy + Traefik) | `https://host/chat-api` |

Concatenate: `baseURL + /me` → `https://chat.technext.it/chat-api/me` in prod, `http://localhost:3001/api/me` locally. The OpenAPI spec's `servers[0].url` reflects the active deploy's base URL — set the operator's `OPENAPI_SERVER_URL` env to match.

### Identity

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/me` | The caller's internal id + profile |
| `POST` | `/me/active` | Bump `lastActiveAt` (call from your app on user activity; rate-limited) |
| `POST` | `/me/broadcast-profile` | Force a `user_updated` fan-out after a profile change (alternative to the webhook) |
| `DELETE` | `/me` | GDPR delete: cascade-removes the caller's rows + S3 attachments |

### Users

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/users/search?q=...` | Autocomplete. Min 2 chars, max 128. Returns ≤50 users matching name/email. Scope-filtered. |
| `POST` | `/users/online` | `{ userIds: string[] }` → `[{ id, lastActiveAt, online }]`. Batch online check. |

### Conversations

| Method | Path | Body | Purpose |
|---|---|---|---|
| `GET` | `/conversations?limit=&before=` | — | Paginated list (§9). Returns `{ conversations, nextCursor }`. |
| `POST` | `/conversations` | `{ type, name?, memberIds }` | Create. `type: "direct"` requires exactly one member. |
| `GET` | `/conversations/:id` | — | Details. 404 if you're not a member. |
| `PUT` | `/conversations/:id` | `{ name }` | Rename. Owner/admin only, group only. |
| `POST` | `/conversations/:id/members` | `{ userIds, name? }` | Add. `name` is only honored when promoting a direct chat to group. |
| `DELETE` | `/conversations/:id/members/:userId` | — | Remove someone, or leave if `userId` is your own. |
| `POST` | `/conversations/:id/mute` | `{ muted: boolean }` | Mute/unmute for the caller only. |

### Messages

| Method | Path | Body | Purpose |
|---|---|---|---|
| `GET` | `/conversations/:id/messages?before=&anchor=&limit=` | — | History. §9 for pagination. `anchor=<messageId>` centers a window. |
| `POST` | `/conversations/:id/messages` | `{ content, replyToId?, clientMessageId?, attachmentIds? }` | Send. §10 for idempotency, §11 for content shape. |
| `PUT` | `/conversations/:id/messages/:messageId` | `{ content }` | Edit. Only the sender, only text (not system). |
| `DELETE` | `/conversations/:id/messages/:messageId` | — | Soft-delete. Sender only. Content is zeroed; `deletedAt` set. |
| `POST` | `/conversations/:id/read` | `{ messageId }` | Mark read up through that message. Clears unread count, broadcasts `read_receipt`. |
| `POST` | `/conversations/:id/messages/:messageId/reactions` | `{ emoji }` | React. Grapheme cluster ≤16 chars. |
| `DELETE` | `/conversations/:id/messages/:messageId/reactions/:emoji` | — | Remove your reaction. `emoji` must be URL-encoded. |
| `POST` | `/conversations/:id/typing` | — | Broadcast typing (throttled; see §17). |

### Search

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/conversations/:id/search?q=...` | Fuzzy + substring search inside one conversation. |
| `GET` | `/search?q=...` | Global across every conversation you're a member of. |

### Attachments

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/attachments/upload-url` | Mint a presigned S3 PUT URL + create the orphan Attachment row. |
| `GET` | `/attachments/:id/download` | 302 to a short-lived signed URL with `Content-Disposition: attachment`. |

### Centrifugo

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/centrifugo/connection-token` | Mint a Centrifugo connection token (alternative to `/init`). |
| `POST` | `/centrifugo/subscription-token` | Mint a subscription token for `presence:conv_<id>` channels. |

### Push

| Method | Path | Body | Purpose |
|---|---|---|---|
| `GET` | `/push/vapid-public-key` | — | Fetch VAPID public key for `pushManager.subscribe`. |
| `POST` | `/push/subscribe` | `{ endpoint, keys: { p256dh, auth } }` | Register a Web Push subscription. |
| `POST` | `/push/unsubscribe` | `{ endpoint }` | Unregister. |

### Bootstrap

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/init?limit=` | One-shot: conversation list + Centrifugo connection token. Use on app start. |

### Webhooks (tenant backend → us, auth via `apiKey`)

| Method | Path | Body | Purpose |
|---|---|---|---|
| `POST` | `/webhooks/users.updated` | `{ externalId, name, image?, email? }` | Push a profile change. |
| `POST` | `/webhooks/users.deleted` | `{ externalId }` | Cascade-delete a user. |

### Admin (operator → us, auth via `MASTER_API_KEY`)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/admin/tenants` | Create a tenant. |
| `GET` | `/admin/tenants` | List tenants (metadata only). |
| `POST` | `/admin/tenants/:id/api-keys` | Rotate `apiKey`. |
| `POST` | `/admin/tenants/:id/jwt-secret/rotate` | Rotate `jwtSecret`. |

---

## 9. Pagination

All paginated endpoints use **cursor pagination**, not offset. Cursors are opaque strings you pass back as-is.

### Conversations

```
GET /conversations?limit=50&before=<ISO_TIMESTAMP>
```

Response:

```json
{
  "conversations": [...],
  "nextCursor": "2026-04-22T18:30:00.000Z"
}
```

When `nextCursor` is `null`, there are no more pages. Pass it as `before=` on the next request.

### Messages

```
GET /conversations/:id/messages?limit=50&before=<messageId>
```

- Default order: newest → oldest. (Reverse the array if you render top-down.)
- `before=<messageId>` returns messages created before that message.
- `anchor=<messageId>` returns a window of `limit` messages centered on that id (used by "jump to message" from search).

Response:

```json
{
  "messages": [...],
  "readPositions": [{ "userId", "name", "image", "lastReadMessageId" }, ...],
  "nextCursor": "<messageId-of-last-item>"
}
```

`readPositions` tells you who has read up to which message — use it to render read markers.

---

## 10. Idempotency & retries

### Sending messages: `clientMessageId`

Generate a UUID on the client **before** sending. Pass it as `clientMessageId`. If the network hiccups and you retry with the same value, the server returns the same stored message instead of creating a duplicate.

```ts
const clientMessageId = crypto.randomUUID();

async function send(content, attempt = 1) {
  try {
    return await api.post(`/conversations/${convId}/messages`, {
      content, clientMessageId,
    });
  } catch (e) {
    if (attempt < 3 && isTransient(e)) {
      await delay(250 * attempt);
      return send(content, attempt + 1);
    }
    throw e;
  }
}
```

The server enforces this with a unique index on `(conversationId, clientMessageId)`.

### Webhooks

Both `users.updated` and `users.deleted` are idempotent by design:

- `users.updated`: you send the full desired state; the server upserts.
- `users.deleted`: `202` if the user existed, `404` if not. Treat `404` as success for the retry.

### Other operations

| Endpoint | Retry-safe? | Why |
|---|---|---|
| `POST /conversations` direct | ✅ | Server dedups on existing direct pair. |
| `POST /conversations` group | ❌ | Creates a new group per call. |
| Add member | ✅ | Users already in the conversation are skipped. |
| Rename | ✅ | Same name = no-op. |
| Mark read | ✅ | Monotonic; idempotent. |
| Mute | ✅ | Setting same value = no-op. |
| Add reaction | ✅ | Unique on `(message, user, emoji)`. |
| Remove reaction | ✅ | Removing a non-existent reaction = `404`, treat as success. |
| Edit message | ✅ | Overwrites. |
| Delete message | ✅ | Soft-delete is idempotent. |

---

## 11. Message content format (Tiptap JSON)

Content is stored as a **Tiptap JSON AST** (the server canonicalizes it; client-supplied HTML is rejected).

### Minimal text message

```json
{
  "type": "doc",
  "content": [
    {
      "type": "paragraph",
      "content": [{ "type": "text", "text": "hello" }]
    }
  ]
}
```

### With marks (bold, italic, code)

```json
{
  "type": "doc",
  "content": [{
    "type": "paragraph",
    "content": [
      { "type": "text", "text": "hello " },
      { "type": "text", "text": "bold", "marks": [{ "type": "bold" }] }
    ]
  }]
}
```

### Mentions

```json
{
  "type": "mention",
  "attrs": { "id": "<internal-user-id>", "label": "Alice Chen" }
}
```

- `id` must be an internal user id (UUID). If it doesn't resolve to a conversation member, the mention is stripped from `mentions[]` server-side (but stays in the rendered content).
- `label` is rewritten server-side to the DB-canonical name — a client sending `label: "@alice"` pointing at Bob's id gets persisted as `"Bob"`.

### Links

```json
{ "type": "text", "text": "https://example.com", "marks": [{ "type": "link", "attrs": { "href": "https://example.com" } }] }
```

### Attachments-only message

```json
{ "type": "doc", "content": [] }
```

With `attachmentIds: ["att_xyz"]` — the server requires either non-empty content OR at least one attachment.

### Limits

| Constraint | Value |
|---|---|
| `plainContent` max | 8000 characters |
| Request body size | 512 KB (chat routes) |
| Mention ids per message | unbounded, but unresolved ones dropped |

---

## 12. File attachments

Two-step upload via presigned S3.

```ts
// 1. Ask the chat server for a presigned PUT URL + create the orphan Attachment row
const { attachmentId, uploadUrl, publicUrl, expiresIn } = await fetch(
  "https://chat.technext.it/chat-api/attachments/upload-url",
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${chatToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      filename: file.name,
      contentType: file.type,
      size: file.size,
      width: img?.naturalWidth,   // optional, for images
      height: img?.naturalHeight,
    }),
  },
).then((r) => r.json());

// 2. PUT the bytes directly to S3 within `expiresIn` seconds (default 300)
await fetch(uploadUrl, {
  method: "PUT",
  headers: { "Content-Type": file.type },
  body: file,
});

// 3. Send a message that references it
await fetch(`https://chat.technext.it/chat-api/conversations/${convId}/messages`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${chatToken}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    content: { type: "doc", content: [] },
    attachmentIds: [attachmentId],
  }),
});
```

### Limits

| Constraint | Value | Notes |
|---|---|---|
| Per-file size | 50 MB | Presigned PUT signs `Content-Length`; larger → `403` from S3. |
| Per-user quota | 5 GB | Sum of all your Attachments. Exceeding → `413 PAYLOAD_TOO_LARGE` at upload-url time. |
| Presigned URL TTL | 5 min | `expiresIn` in the response. Upload within that window. |
| Attachments per message | no hard cap | Server validates each one belongs to you and is unlinked. |

### Post-upload verification

The chat server issues a HEAD request to S3 right after linking the attachment to a message. If the actual object size differs from what was presigned, the server deletes both the S3 object and the DB row. This defends against non-strict S3 backends that don't enforce `Content-Length`.

### Orphan cleanup

If you call `/upload-url` and never link the attachment to a message (user cancelled, tab closed, error), the orphan Attachment row + S3 object are GC'd by the server's background sweep after ~24 hours.

### Downloads

`GET /attachments/:id/download` returns a 302 to a short-lived signed URL with `Content-Disposition: attachment` — the browser downloads instead of inlining. Works for any content type. Authorization: you must be the uploader OR a member of the conversation the attachment was posted in.

---

## 13. Realtime (Centrifugo)

The chat server uses [Centrifugo v6](https://centrifugal.dev/) for WebSocket delivery. Your frontend connects once, is auto-subscribed to its own `user:{internalUserId}` channel, and receives every event through that channel.

### Connection URL

```
wss://chat.technext.it/chat-api/centrifugo/connection/websocket
```

### Bootstrap

```ts
import { Centrifuge } from "centrifuge";

async function fetchInit() {
  return fetch("https://chat.technext.it/chat-api/init", {
    headers: { Authorization: `Bearer ${chatToken}` },
  }).then((r) => r.json());
}

// 1. Get conversations + connection token in one call
const { conversations, centrifugoToken } = await fetchInit();

// 2. Connect
const c = new Centrifuge(
  "wss://chat.technext.it/chat-api/centrifugo/connection/websocket",
  {
    token: centrifugoToken,
    // Called when the token is near expiry; refetch /init
    getToken: async () => (await fetchInit()).centrifugoToken,
  },
);

c.on("connected",    () => console.log("ws up"));
c.on("disconnected", (ctx) => console.log("ws down:", ctx.reason));
c.on("error",        (ctx) => console.error(ctx.error));

// 3. Listen — user:{userId} is auto-subscribed via the connection token's subs claim
c.on("publication", (ctx) => {
  const event = ctx.data;
  dispatchEvent(event);  // see §14 for types
});

c.connect();
```

### Presence (per-conversation)

Only needed when you care about join/leave of the currently-open conversation (typing indicators, active-users list). The user's own `user:{userId}` channel is auto-subscribed.

```ts
async function subscribePresence(conversationId: string) {
  const { token } = await fetch(
    "https://chat.technext.it/chat-api/centrifugo/subscription-token",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${chatToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel: `presence:conv_${conversationId}` }),
    },
  ).then((r) => r.json());

  const sub = c.newSubscription(`presence:conv_${conversationId}`, { token });
  sub.on("subscribed", async () => {
    const { clients } = await sub.presence();
    const activeUserIds = clients.map((c) => c.user);
    // ...
  });
  sub.on("join",  (ctx) => onActive(ctx.info.user));
  sub.on("leave", (ctx) => onInactive(ctx.info.user));
  sub.subscribe();
  return sub;
}
```

Unsubscribe when switching conversations or the tab becomes hidden.

### Reconnection semantics

- Centrifugo auto-reconnects with exponential backoff on network loss.
- Per `user:{id}` channel, Centrifugo's history is configured for ~30s recovery — short WS drops replay missed events automatically.
- For longer disconnects: on reconnect, refetch `/init` to reconcile state (conversation list + last-seq per conversation).

### Idempotency

Every publication carries an `idempotencyKey`. Centrifugo dedups within a short window, so a server retry of the same event is a no-op on the client. You **may still receive duplicates** across long disconnects — use `message.id` or `event.type + event.conversationId + event.messageId` as your dedup key.

---

## 14. Realtime event catalog

All events arrive on `user:{internalUserId}`. Dispatch by `event.type`.

### `message_added`

New message posted (or a system message — user added, group renamed, etc).

```ts
{
  type: "message_added",
  conversationId: string,
  message: {
    id: string,
    seq: number,
    senderId: string,
    senderName: string,
    content: MessageContent,       // Tiptap JSON
    plainContent: string,          // flat text
    msgType: "text" | "system" | "image",
    replyTo: { id, content, plainContent, senderId, sender } | null,
    createdAt: string,
    clientMessageId: string | null,
    attachments?: Attachment[],
    mentions?: string[],           // internal user ids, already validated as members
  }
}
```

### `message_edited`

```ts
{
  type: "message_edited",
  conversationId: string,
  messageId: string,
  content: MessageContent,
  editedAt: string,
}
```

### `message_deleted`

Soft-delete. Client should gray the message or replace it with a tombstone.

```ts
{
  type: "message_deleted",
  conversationId: string,
  messageId: string,
}
```

### `read_receipt`

Another member read up through `messageId`. Move their read marker.

```ts
{
  type: "read_receipt",
  conversationId: string,
  userId: string,
  userName: string,
  messageId: string,
}
```

### `reaction_added` / `reaction_removed`

```ts
{
  type: "reaction_added",
  conversationId: string,
  messageId: string,
  reaction: { id: string, emoji: string, userId: string, userName: string },
}

{
  type: "reaction_removed",
  conversationId: string,
  messageId: string,
  emoji: string,
  userId: string,
}
```

### `typing_started`

Another member started typing. No `typing_stopped` event — the client should auto-hide the indicator after ~3 seconds. Debounced server-side to 1 per 2 seconds per user per conversation.

```ts
{
  type: "typing_started",
  conversationId: string,
  userId: string,
  userName: string,
}
```

### `conversation_updated`

Membership changed, name changed, version bumped. Replace your cached copy.

```ts
{
  type: "conversation_updated",
  conversation: {
    id: string,
    type: "direct" | "group",
    name: string | null,
    createdBy: string,
    createdAt: string,
    updatedAt: string,
    version: number,
    members: ConversationMember[],
  }
}
```

### `conversation_left`

You (this user) were removed from, or left, a conversation. Drop it from the sidebar.

```ts
{
  type: "conversation_left",
  conversationId: string,
}
```

### `conversation_mute_changed`

Multi-tab sync — your own mute toggle from another tab/device.

```ts
{
  type: "conversation_mute_changed",
  conversationId: string,
  muted: boolean,
}
```

### `user_updated`

A peer (someone you share a conversation with) changed their name or avatar. Bust cached references.

```ts
{
  type: "user_updated",
  user: { id: string, name: string, image: string | null },
}
```

---

## 15. Web Push notifications

Web Push delivers notifications when the tab is closed or backgrounded.

### Setup (operator side)

Operator generates a VAPID keypair once:

```bash
npx web-push generate-vapid-keys
```

...and sets `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` env. If unset, push endpoints return `503 SERVICE_UNAVAILABLE` and the app degrades gracefully.

### Client flow

```ts
// 1. Fetch the VAPID public key
const { key } = await fetch("/chat-api/push/vapid-public-key", {
  headers: { Authorization: `Bearer ${chatToken}` },
}).then((r) => r.json());

// 2. Register a service worker + subscribe
const sw = await navigator.serviceWorker.register("/sw.js");
const sub = await sw.pushManager.subscribe({
  userVisibleOnly: true,
  applicationServerKey: urlBase64ToUint8Array(key),
});

// 3. Send the subscription to the chat server
await fetch("/chat-api/push/subscribe", {
  method: "POST",
  headers: { Authorization: `Bearer ${chatToken}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    endpoint: sub.endpoint,
    keys: {
      p256dh: arrayBufferToBase64(sub.getKey("p256dh")),
      auth:   arrayBufferToBase64(sub.getKey("auth")),
    },
  }),
});
```

### Server behaviour

On every new message, the server fans out to:

- Every non-sender, non-muted member, OR
- Any mentioned user (bypasses mute).

Payload:

```json
{
  "title": "Alice Chen",
  "body": "hey, about the deck…",
  "tag": "conv:<conversationId>",
  "url": "/"
}
```

Your service worker decides how to render it. The reference `sw.js` in this repo suppresses the notification if any of the user's tabs are visible (so active users don't get double-pinged).

---

## 16. Webhooks

When one of your users renames themselves or changes avatar, call the chat server so its cached copy and live peers update immediately. Without this, the chat server only picks up the change the next time that user authenticates.

Authenticate with your `apiKey`:

```
Authorization: Bearer <apiKey>
```

### `POST /webhooks/users.updated`

Idempotent. Send the full desired state every time.

```bash
curl -X POST https://chat.technext.it/chat-api/webhooks/users.updated \
  -H "Authorization: Bearer $CHAT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "externalId": "user_42",
    "name": "Alice Chen",
    "image": "https://cdn.acme.com/avatars/42.jpg",
    "email": "alice@acme.com"
  }'
```

Response: `202 Accepted`. Peers who share a conversation receive a `user_updated` Centrifugo event and their UI refreshes live.

### `POST /webhooks/users.deleted`

Cascade-deletes the user + every conversation membership, message, and reaction they own. S3 attachment objects are GC'd asynchronously.

```bash
curl -X POST https://chat.technext.it/chat-api/webhooks/users.deleted \
  -H "Authorization: Bearer $CHAT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"externalId": "user_42"}'
```

Response: `202` if the user existed, `404` if not. Both are safe to retry.

### Request signing (recommended)

Include an HMAC so a leaked key alone isn't enough to forge requests:

```
X-Chat-Signature: sha256=<hex>
```

```ts
import crypto from "node:crypto";

const body = JSON.stringify({ externalId: "user_42", name: "Alice" });
const signature = crypto
  .createHmac("sha256", process.env.CHAT_API_KEY!)
  .update(body)
  .digest("hex");

await fetch("https://chat.technext.it/chat-api/webhooks/users.updated", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.CHAT_API_KEY}`,
    "Content-Type": "application/json",
    "X-Chat-Signature": `sha256=${signature}`,
  },
  body,
});
```

Sign the **exact raw bytes** you send — not a pretty-printed version. If the operator sets `WEBHOOK_SIGNATURE_REQUIRED=true`, unsigned requests return `401`.

---

## 17. Rate limits

All user-facing routes are per-user (keyed on internal user id + IP). Webhooks are per-tenant + per-`(tenant, externalId)`.

| Endpoint | Limit | Window |
|---|---|---|
| `POST /conversations/:id/messages` | 30 | per minute |
| `POST /conversations/:id/typing` | 20 | per **second** (server throttles 1/2s idempotency) |
| `POST /attachments/upload-url` | 30 | per minute |
| `GET /users/search`, `/search`, `/conversations/:id/search` | 10 | per second |
| everything else authenticated | 300 | per minute |
| `POST /webhooks/*` per tenant | 100 | per minute |
| `POST /webhooks/*` per `(tenant, externalId)` | 10 | per minute |

On limit: `429 TOO_MANY_REQUESTS` with `Retry-After` header. Back off and retry.

---

## 18. Error responses

Every error is a JSON envelope with an HTTP status and a stable `code`:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "body.memberIds: must not be empty",
    "fields": [
      { "path": ["body", "memberIds"], "message": "must not be empty" }
    ]
  }
}
```

### Codes

| Code | HTTP | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Body/query didn't match the Zod schema. `fields[]` is populated. |
| `BAD_REQUEST` | 400 | Logical pre-condition failed (e.g. direct chat with 3 members). |
| `UNAUTHORIZED` | 401 | Missing / malformed / expired / wrong-tenant JWT. |
| `FORBIDDEN` | 403 | Authenticated but not allowed (non-member, non-owner rename, admin IP denied). |
| `NOT_FOUND` | 404 | Resource doesn't exist or isn't visible to you. |
| `CONFLICT` | 409 | Unique constraint violation (e.g. duplicate `clientMessageId` concurrent insert). |
| `PAYLOAD_TOO_LARGE` | 413 | Message body / attachment size / quota exceeded. |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | Wrong `Content-Type`. |
| `TOO_MANY_REQUESTS` | 429 | Rate limit. Check `Retry-After`. |
| `INTERNAL_ERROR` | 500 | Server bug. Safe to retry once. |
| `SERVICE_UNAVAILABLE` | 503 | Dependency unhealthy (DB, Redis, S3, VAPID unset for push). |

### Retry policy

- **Transient** (`INTERNAL_ERROR`, `SERVICE_UNAVAILABLE`, `TOO_MANY_REQUESTS`, network-level): retry with backoff + jitter.
- **Permanent** (`UNAUTHORIZED` except expired-token, `FORBIDDEN`, `VALIDATION_ERROR`, `NOT_FOUND`, `CONFLICT` on non-idempotent ops): don't retry.
- **Expired token** (`UNAUTHORIZED` with message `Invalid user token`): refetch `/chat-token`, then retry once.

---

## 19. Security

- **Never ship `apiKey` or `jwtSecret` to the browser.** Both belong in your backend's secret manager.
- Keep user JWT TTL short (1h is a good default). Your backend re-mints on each session refresh.
- The chat server pins `HS256`. Tokens signed with any other algorithm are rejected.
- Clock skew: the server tolerates ±30s between your mint time and its verify time.
- Rotate credentials whenever a staff member with access leaves or you suspect compromise:
  ```bash
  # Rotate API key (old key dies instantly)
  curl -X POST https://chat.technext.it/chat-api/admin/tenants/$TENANT_ID/api-keys \
    -H "Authorization: Bearer $MASTER_API_KEY"

  # Rotate JWT secret (every live user token dies instantly)
  curl -X POST https://chat.technext.it/chat-api/admin/tenants/$TENANT_ID/jwt-secret/rotate \
    -H "Authorization: Bearer $MASTER_API_KEY"
  ```
- **Tenant isolation**: enforced at every Prisma query. Foreign tenant ids in your input return `400` (invalid member) or `404` (not visible).
- **Scope isolation**: enforced on user discovery within a tenant (§4).
- **Conversation isolation**: non-members can't read, write, or even see a conversation's existence.
- Web Push payloads include the conversation id (`tag: conv:<id>`) but not message content — the service worker fetches fresh state before showing the notification so permissions-revoked endpoints don't leak content.

---

## 20. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `401 Missing user token` | No `Authorization: Bearer` header. |
| `401 Malformed user token` | Token isn't valid JWT or missing `iss`. |
| `401 Unknown tenant` | `iss` claim doesn't match any tenant. Typo in `CHAT_TENANT_ID`? |
| `401 Invalid user token` | Signature mismatch — wrong `jwtSecret`, wrong algorithm, or expired. |
| `400 One or more memberIds are invalid` on create/add-member | You passed a userId from a different tenant, different scope, or one that doesn't exist. |
| `400 One or more userIds are invalid` on add-member | Same as above. Scoped users can only add same-scope + tenant-wide. |
| `403 Forbidden` on admin endpoint | Missing / wrong `MASTER_API_KEY`, or your IP isn't in the admin allowlist. Talk to the operator. |
| `403 Not a member` on message send/read | You were removed from the conversation or never joined. |
| `413 PAYLOAD_TOO_LARGE` on message send | `plainContent > 8000` chars or total body > 512 KB. |
| `413 PAYLOAD_TOO_LARGE` on upload-url | 5 GB per-user quota exceeded. |
| `429 Too Many Requests` on webhooks | Hit the 100/min per-tenant or 10/min per-user bucket. Debounce. |
| `429 Too Many Requests` on messages | 30/min per user. |
| `401 Missing X-Chat-Signature` on webhooks | Operator set `WEBHOOK_SIGNATURE_REQUIRED=true`. Sign with `HMAC-SHA256(apiKey, rawBody)`. |
| `401 Invalid X-Chat-Signature` | Signed a pretty-printed version while sending compact JSON, or used the wrong key. |
| `503 Push not configured` | Operator hasn't set VAPID env. Push endpoints will keep 503ing until they do. |
| WebSocket drops every ~1 hour | Centrifugo connection token expired. Wire up `getToken` to refetch `/init`. |
| Duplicate `message_added` events | Long disconnect + Centrifugo replay. Dedup by `message.id`. |
| Mentions aren't notifying | The mentioned userId didn't resolve to a member of the conversation. Server drops unresolved ids from `mentions[]`. |

Full API reference + interactive playground: **`/chat-api/docs`**.
