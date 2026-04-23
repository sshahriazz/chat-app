# Third-Party Integration Guide

This chat backend is **user-agnostic**: your app owns its users, you mint short-lived JWTs on their behalf, and the chat server materializes them lazily. No user sync, no shadow auth system, no double-login.

Throughout this guide, the chat server lives at `https://chat.technext.it/chat-api`. Replace that with whatever host your deployment runs on.

---

## 1. How it works

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

Two secrets per tenant, both surfaced once at tenant creation:

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

## 3. Minting user JWTs (your backend)

Every request from your frontend to the chat server carries a JWT signed with your tenant's `jwtSecret`. The JWT is short-lived (≤ 1 hour is a good default). Your backend is the only party that signs them — never ship `jwtSecret` to the browser.

### Claims

| Claim | Required | Description |
|---|---|---|
| `sub` | ✅ | Your own user id. Stored on the chat server as `User.externalId`. Stable across tokens. |
| `iss` | ✅ | Your tenant id (e.g. `tnt_abc123`). Tells the chat server which `jwtSecret` to verify with. |
| `name` | ✅ | Display name. Embedded in realtime events so peers see it without extra lookups. |
| `image` | optional | Avatar URL. |
| `email` | optional | Display-only — the chat server does not use it for auth or dedup. |
| `scope` | optional | Second-level partition inside your tenant. See **Scopes** below. |
| `exp` | ✅ | Expiry timestamp (seconds). |
| `iat` | ✅ | Issued-at timestamp (seconds). |

Algorithm: **HS256**. No other algorithm is accepted.

### Scopes — partitioning inside a single tenant

Use `scope` when one tenant hosts many independent chat contexts and users in one context shouldn't discover or message users in another.

| Example | Who gets which scope |
|---|---|
| Per-project chats | project members: `scope: "project_42"`; PMs who jump between: no scope |
| Support tickets | customer: `scope: "cust_123"`; support agents: no scope |
| Deal rooms / CRM clients | external party: `scope: "deal_a"`; internal staff: no scope |
| Team-wide collaboration (Slack-style) | nobody scoped — tenant-wide is fine |

Rules the server enforces:

- A **scoped** user (`scope: "X"` in the JWT) can only find + add users whose `scope` is `"X"` or `null`.
- An **unscoped** user (no `scope` claim or `scope: null`) can find + add any user in the tenant. Use this for support agents, admins, and internal staff who span scopes.
- Scope is **only** enforced on user discovery (`/users/search`, add-member, online-users). It is **not** a per-conversation scope — once a conversation exists, its membership defines who can read it, regardless of scope. A scoped support customer and an unscoped agent can chat freely in a conversation they both belong to.
- The `User.scope` column updates on every auth when the JWT supplies a different `scope`. Omit the claim to leave the stored value untouched (useful when a webhook doesn't know the scope).

### Node.js (`jsonwebtoken`)

```ts
import jwt from "jsonwebtoken";

export function mintChatToken(
  userId: string,
  name: string,
  opts: { image?: string; scope?: string | null } = {},
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
      expiresIn: "1h",
      algorithm: "HS256",
    },
  );
}
```

### Python (`PyJWT`)

```python
import jwt, time

def mint_chat_token(user_id: str, name: str, image: str | None = None) -> str:
    now = int(time.time())
    return jwt.encode(
        {
            "sub": user_id,
            "name": name,
            "image": image,
            "iss": os.environ["CHAT_TENANT_ID"],
            "iat": now,
            "exp": now + 3600,
        },
        os.environ["CHAT_JWT_SECRET"],
        algorithm="HS256",
    )
```

### Go (`github.com/golang-jwt/jwt/v5`)

```go
func MintChatToken(userID, name string) (string, error) {
    now := time.Now()
    tok := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
        "sub":  userID,
        "name": name,
        "iss":  os.Getenv("CHAT_TENANT_ID"),
        "iat":  now.Unix(),
        "exp":  now.Add(time.Hour).Unix(),
    })
    return tok.SignedString([]byte(os.Getenv("CHAT_JWT_SECRET")))
}
```

### Expose a mint endpoint

Most integrations expose a single endpoint on their own backend:

```
GET /api/chat-token   →  { token, expiresAt }
```

Your frontend hits this on boot and on refresh. Keep the response cache-control to no-store.

---

## 4. Calling the chat API (your frontend)

Every chat-server request needs `Authorization: Bearer <jwt>`.

```ts
const res = await fetch("https://chat.technext.it/chat-api/me", {
  headers: { Authorization: `Bearer ${chatToken}` },
});
const me = await res.json();
// me.id = chat-server internal UUID — use this for senderId, channel names, etc.
```

The chat server's `GET /me` returns the **internal user id** (a UUID), not your `externalId`. Use the internal id for things the chat server emits back: `message.senderId`, Centrifugo channels, etc. Your `externalId` stays on your side; the chat server just stores it for the uniqueness constraint.

### Core endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/me` | Fetch the caller's internal id + profile |
| `GET` | `/init` | One-shot: conversation list + Centrifugo connection token |
| `GET` | `/conversations` | Paginated conversation list |
| `POST` | `/conversations` | Start a conversation (direct or group) |
| `GET` | `/conversations/:id` | Conversation details |
| `POST` | `/conversations/:id/members` | Add members |
| `DELETE` | `/conversations/:id/members/:userId` | Remove / leave |
| `GET` | `/conversations/:id/messages` | Paginated message history |
| `POST` | `/conversations/:id/messages` | Send a message |
| `PUT` | `/conversations/:id/messages/:messageId` | Edit message |
| `DELETE` | `/conversations/:id/messages/:messageId` | Soft-delete message |
| `POST` | `/conversations/:id/read` | Mark read up to message |
| `POST` | `/conversations/:id/mute` | Mute / unmute |
| `POST` | `/conversations/:id/messages/:messageId/reactions` | React |
| `POST` | `/conversations/:id/typing` | Typing indicator |
| `POST` | `/attachments/upload-url` | Presigned S3 PUT URL |
| `POST` | `/push/subscribe` | Web Push registration |
| `POST` | `/users/search?q=...` | User autocomplete (scoped to your tenant) |

Full OpenAPI spec + interactive playground: **`https://chat.technext.it/chat-api/docs`**.

### Important: tenant scoping

Every search, lookup, and write is scoped to your tenant. Users from Tenant A cannot find, message, or see users from Tenant B — even if they know the other user's id. This is enforced at the DB query level.

When you add members to a conversation, every `memberIds[]` entry must resolve to a user **in your tenant**. Pass foreign ids and the request fails with `400`.

---

## 5. Webhooks: pushing profile changes

When one of your users renames themselves or changes avatar, call the chat server so its cached copy and live peers update immediately. Without this step, the chat server would only pick up the change the next time that user authenticates.

Authenticate server-to-server calls with your `apiKey`:

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

Response: `202 Accepted`. Peers who share a conversation with `user_42` receive a `user_updated` Centrifugo event and their UI refreshes live.

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

Webhooks are authenticated by `Authorization: Bearer <apiKey>`. For extra safety, include an HMAC signature so a leaked key alone isn't enough to forge requests — the attacker also needs the ability to sign.

Compute `HMAC-SHA256(apiKey, rawRequestBody)` and send it hex-encoded in a header:

```
X-Chat-Signature: sha256=<hex>
```

The server verifies the signature whenever the header is present. If the operator sets `WEBHOOK_SIGNATURE_REQUIRED=true`, every webhook call **must** include a valid signature or it returns `401`.

#### Node.js example

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

The signature is computed over the **raw body bytes you send**, not a pretty-printed / re-serialized version — use the exact string you pass to `fetch`.

### Rate limits

- 100 req/min per tenant — blocks a compromised key from flooding events.
- 10 req/min per `(tenant, externalId)` — catches loops re-pushing the same profile.

---

## 6. Realtime (Centrifugo)

The chat server runs [Centrifugo](https://centrifugal.dev/) for WebSocket delivery. Your frontend connects once, subscribes to its own `user:{userId}` channel, and receives every message / reaction / read-receipt / typing event routed through that channel.

### Bootstrap

```ts
import { Centrifuge } from "centrifuge";

// 1. Get the connection token from GET /init (field: centrifugoToken)
const { centrifugoToken } = await fetch("https://chat.technext.it/chat-api/init", {
  headers: { Authorization: `Bearer ${chatToken}` },
}).then((r) => r.json());

// 2. Connect
const c = new Centrifuge("wss://chat.technext.it/chat-api/centrifugo/connection/websocket", {
  token: centrifugoToken,
  getToken: async () => {
    // Called when the token is about to expire; refetch /init
    const r = await fetch("https://chat.technext.it/chat-api/init", {
      headers: { Authorization: `Bearer ${chatToken}` },
    }).then((r) => r.json());
    return r.centrifugoToken;
  },
});

// 3. Listen — user:{userId} is auto-subscribed via the connection token
c.on("publication", (ctx) => {
  const event = ctx.data;
  switch (event.type) {
    case "message_added":    /* render new message */    break;
    case "message_edited":   /* patch in place */        break;
    case "message_deleted":  /* gray out */              break;
    case "read_receipt":     /* move read marker */      break;
    case "typing_started":   /* show indicator */        break;
    case "reaction_added":
    case "reaction_removed": /* refresh reaction bar */  break;
    case "user_updated":     /* bust cached avatar */    break;
    case "conversation_updated":
    case "conversation_joined":
    case "conversation_left": /* sidebar refresh */      break;
  }
});

c.connect();
```

### Presence channels

Per-conversation presence (who's online, typing) is on `presence:conv_{id}` channels. Fetch a subscription token per channel:

```ts
const { token } = await fetch("https://chat.technext.it/chat-api/centrifugo/subscription-token", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${chatToken}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ channel: `presence:conv_${conversationId}` }),
}).then((r) => r.json());

const sub = c.newSubscription(`presence:conv_${conversationId}`, { token });
sub.on("join", (ctx) => /* user joined */);
sub.on("leave", (ctx) => /* user left */);
sub.subscribe();
```

---

## 7. File attachments

Two-step upload via presigned S3:

```ts
// 1. Ask the chat server for a presigned PUT URL
const { attachmentId, uploadUrl, publicUrl } = await fetch(
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
    }),
  },
).then((r) => r.json());

// 2. PUT the bytes directly to S3
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

The chat server verifies the uploaded size matches what was presigned. Mismatches are deleted both in S3 and in the DB.

Per-user quota: 5 GB by default.

---

## 8. Security

- **Never ship `apiKey` or `jwtSecret` to the browser.** Both belong in your backend's secret manager.
- Keep user JWT TTL short (1h is a good default). Your backend re-mints on each session refresh.
- The chat server pins `HS256`. Tokens signed with any other algorithm are rejected.
- Clock skew: the server tolerates ±30s between your mint time and its verify time. If your system clocks drift more than that, fix the clock.
- Rotate credentials whenever a staff member with access leaves or you suspect compromise:
  ```bash
  # Rotate API key (old key dies instantly)
  curl -X POST https://chat.technext.it/chat-api/admin/tenants/$TENANT_ID/api-keys \
    -H "Authorization: Bearer $MASTER_API_KEY"

  # Rotate JWT secret (every live user token dies instantly)
  curl -X POST https://chat.technext.it/chat-api/admin/tenants/$TENANT_ID/jwt-secret/rotate \
    -H "Authorization: Bearer $MASTER_API_KEY"
  ```
- Cross-tenant isolation is enforced at every Prisma query. User search, add-member, message fetch, etc. all filter by `tenantId` — you cannot address, read, or message another tenant's users even if you have their id.

---

## 9. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `401 Missing user token` | No `Authorization: Bearer` header. |
| `401 Malformed user token` | Token isn't valid JWT or missing `iss`. |
| `401 Unknown tenant` | `iss` claim doesn't match any tenant. Typo in `CHAT_TENANT_ID`? |
| `401 Invalid user token` | Signature doesn't match — wrong `jwtSecret`, wrong algorithm, or expired. |
| `400 One or more userIds are invalid` on add-member | You passed a userId that belongs to a different tenant (or doesn't exist). |
| `403 Forbidden` on admin endpoint | Missing / wrong `MASTER_API_KEY`. Talk to the operator. |
| `429 Too Many Requests` on webhooks | Hit the per-tenant 100/min or per-user 10/min bucket. Debounce your updates. |
| `401 Missing X-Chat-Signature` on webhooks | The operator has set `WEBHOOK_SIGNATURE_REQUIRED=true`. Sign the body with `HMAC-SHA256(apiKey, rawBody)`. |
| `401 Invalid X-Chat-Signature` | Signature doesn't match. Common causes: signed a pretty-printed version while sending compact JSON, or hashed with the wrong key. |
| WebSocket drops every ~1 hour | Connection token expired. Wire up `getToken` to refetch `/init`. |

Full API reference + interactive playground: **`/chat-api/docs`**.
