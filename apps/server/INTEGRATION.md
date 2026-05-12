# Third-Party Integration Guide

How to embed this chat service into your own product. Your app keeps owning its users and its UI; this server provides the messaging primitives (conversations, real-time delivery, attachments, search, push) and stays out of your way.

Throughout this guide the chat service lives at **`https://chat.technext.it`**. Swap that for your operator's host if it differs.

---

## Table of contents

1.  [Architecture overview](#1-architecture-overview)
2.  [Public surface (URLs and ports)](#2-public-surface-urls-and-ports)
3.  [Quick start — 5 minutes from zero to a working chat](#3-quick-start--5-minutes-from-zero-to-a-working-chat)
4.  [Onboarding your tenant](#4-onboarding-your-tenant)
5.  [Minting end-user JWTs](#5-minting-end-user-jwts)
6.  [Scopes — partitioning within a tenant](#6-scopes--partitioning-within-a-tenant)
7.  [Token lifecycle & refresh](#7-token-lifecycle--refresh)
8.  [Calling the chat API](#8-calling-the-chat-api)
9.  [Data shapes](#9-data-shapes)
10. [Endpoint reference](#10-endpoint-reference)
11. [Pagination](#11-pagination)
12. [Idempotency & retries](#12-idempotency--retries)
13. [Message content format (Tiptap JSON)](#13-message-content-format-tiptap-json)
14. [File attachments](#14-file-attachments)
15. [Real-time delivery (Centrifugo)](#15-real-time-delivery-centrifugo)
16. [Real-time event catalog](#16-real-time-event-catalog)
17. [Web Push notifications](#17-web-push-notifications)
18. [Webhooks (your backend → us)](#18-webhooks-your-backend--us)
19. [Rate limits](#19-rate-limits)
20. [Error responses](#20-error-responses)
21. [Security](#21-security)
22. [Production checklist](#22-production-checklist)
23. [Troubleshooting](#23-troubleshooting)
24. [End-to-end reference: a working Next.js integration](#24-end-to-end-reference-a-working-nextjs-integration)

---

## 1. Architecture overview

```
┌──────────────────┐    1. user logs into     ┌──────────────────┐
│   YOUR APP UI    │       your app           │  YOUR BACKEND    │
│ (browser/Vercel) │ ◀──────────────────────▶ │ (Next.js, Rails, │
└──────────────────┘                          │  Django, …)      │
        │                                     └──────────────────┘
        │ 2. browser asks YOUR backend                │
        │    for a chat JWT                           │ 3. signs JWT with
        │ ◀───────────────────────────────────────────┤    your tenant's
        │                                             │    jwtSecret
        │                                             │
        │ 4. REST calls with Bearer <jwt>             │ 5. (optional) you
        │    + WS open via centrifuge SDK             │    webhook user
        ▼                                             │    profile changes
┌──────────────────────────────────────────────┐      │    over to chat
│  chat.technext.it/api  (REST, Express)       │ ◀────┘
│  chat.technext.it/connection/websocket (WS)  │
│  chat.technext.it/chatapp  (S3-compatible)   │
└──────────────────────────────────────────────┘
```

**Two delivery rails:**

| | What it does | Where the connection lives |
|---|---|---|
| **REST** (`/api`) | Mutations, list calls, history, presigned URLs | Browser → Traefik → server container |
| **WebSocket** (`/connection/websocket`) | Live events: new messages, edits, reads, typing | Browser → Traefik → Centrifugo container |

**You own users, identity, and your UI.** The chat server:

- Materializes users lazily from the JWTs your backend signs (no copy-or-sync flow needed for basic identity).
- Has no concept of password / OAuth / sessions — those live in your auth system.
- Optionally accepts webhooks if you want profile updates / deletions to propagate immediately.

---

## 2. Public surface (URLs and ports)

| URL | What lives there | Notes |
|---|---|---|
| `https://chat.technext.it/` | Reference UI (chat app's own frontend) | You don't need this. Your app builds its own UI. |
| `https://chat.technext.it/api/*` | REST API | All `/api/*` paths routed direct to the server container via Traefik. JSON, Bearer auth. |
| `https://chat.technext.it/api/docs` | OpenAPI playground (Scalar) | Browse + try every endpoint live. |
| `wss://chat.technext.it/connection/websocket` | Centrifugo WebSocket | Same origin as REST; routed direct to Centrifugo. |
| `https://chat.technext.it/chatapp/*` | Object storage (S3-compatible) | Direct uploads/downloads from the browser via presigned URLs. |

**All four paths terminate at the same origin** (`chat.technext.it`). There's no Centrifugo-specific subdomain, no separate storage host. Your browser code uses one host name; Traefik routes paths to the right container internally.

If your integrating app runs on a **different origin** (e.g. `https://chamate.com` on Vercel), no proxying is required on your end. The browser opens cross-origin connections directly to `chat.technext.it`. The chat server's CORS allowlist must include your origin — that's the one knob your operator turns per new integration.

---

## 3. Quick start — 5 minutes from zero to a working chat

You'll create one tenant, federate one user, mint a JWT, and send a message — all via `curl`. Once that loop works end-to-end you've validated everything except the WebSocket.

### 3.1 Provision a tenant (operator does this once)

Operator needs `MASTER_API_KEY` from their Dokploy env panel.

```bash
curl -X POST https://chat.technext.it/api/admin/tenants \
  -H "Authorization: Bearer $MASTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "Acme App"}'
```

Response (save `id`, `apiKey`, `jwtSecret` immediately — they are returned only on create):

```json
{
  "id":        "tnt_3f9b...",
  "name":      "Acme App",
  "apiKey":    "ak_1c4f...",
  "jwtSecret": "js_a72e...",
  "createdAt": "2026-05-12T...",
  "updatedAt": "2026-05-12T..."
}
```

### 3.2 Mint a user JWT (your backend would normally do this)

For the smoke test you can hand-sign one with `node`:

```bash
node -e "
import('jose').then(async ({ SignJWT }) => {
  const secret = new TextEncoder().encode('js_a72e...');
  const token = await new SignJWT({
    sub:   'alice@acme',
    name:  'Alice Chen',
    email: 'alice@example.com',
    iss:   'tnt_3f9b...',
    scope: null,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(secret);
  console.log(token);
});
"
```

### 3.3 Call the API with the JWT

```bash
JWT="eyJhbGciOi..."

# Resolve "who am I" — also creates Alice's User row in the chat DB lazily
curl -sS https://chat.technext.it/api/me -H "Authorization: Bearer $JWT"
```

Response:
```json
{
  "id":         "u_a3b1...",      ← internal chat-side id
  "tenantId":   "tnt_3f9b...",
  "externalId": "alice@acme",     ← your app's user id (sub claim)
  "name":       "Alice Chen",
  ...
}
```

### 3.4 Create a DM and send a message

```bash
# Need a second user — repeat 3.2 with sub="bob@acme" name="Bob Park"
# Get Bob's internal id from /api/me with Bob's JWT, call it $BOB_ID.

# Create the DM:
CONV=$(curl -sS -X POST https://chat.technext.it/api/conversations \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"direct\",\"memberIds\":[\"$BOB_ID\"]}")
CONV_ID=$(echo "$CONV" | jq -r .id)

# Send a message:
curl -sS -X POST "https://chat.technext.it/api/conversations/$CONV_ID/messages" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "content": { "type": "doc", "content": [
      { "type": "paragraph", "content": [{ "type": "text", "text": "hello" }] }
    ]},
    "type": "text",
    "clientMessageId": "smoke-test-1"
  }'
```

If you got back a message with a `seq` and `id`, you're wired end-to-end. The rest of this guide is about turning that loop into a production integration.

---

## 4. Onboarding your tenant

A **Tenant** in this system is your integrating application — one tenant per app, not one tenant per user. Each tenant has:

| Field | Purpose | When to use |
|---|---|---|
| `id` | Goes in the `iss` (issuer) claim of every JWT you mint | Identifies which tenant a request belongs to |
| `apiKey` | `Authorization: Bearer <apiKey>` for server-to-server webhook calls (`/api/webhooks/*`) | Profile updates, deletions, anything from your backend → chat |
| `jwtSecret` | HMAC-SHA256 secret your backend uses to sign user JWTs | One JWT per browser session per user |

### 4.1 Store the credentials

Both `apiKey` and `jwtSecret` are surfaced **only on create** and at rotation. There is no way to read them back later. Persist immediately:

- Backend env vars (never in client bundle): `CHAT_TENANT_ID`, `CHAT_TENANT_API_KEY`, `CHAT_TENANT_JWT_SECRET`
- Treat as same sensitivity as your DB credentials — leakage allows anyone to mint JWTs impersonating any of your users.

### 4.2 Rotation

When you suspect compromise or on a regular schedule:

```bash
# Rotate API key (used by your backend → chat webhooks):
curl -X POST https://chat.technext.it/api/admin/tenants/$TENANT_ID/api-keys \
  -H "Authorization: Bearer $MASTER_API_KEY"

# Rotate JWT secret (signing key for end-user JWTs):
curl -X POST https://chat.technext.it/api/admin/tenants/$TENANT_ID/jwt-secret/rotate \
  -H "Authorization: Bearer $MASTER_API_KEY"
```

JWT secret rotation invalidates every JWT your users currently hold. Plan for re-mint on next API call — clients with a 401 should refetch their JWT.

---

## 5. Minting end-user JWTs

Every authenticated browser request from your app to the chat server carries a Bearer JWT signed with your tenant's `jwtSecret`. Your backend mints these on demand for each logged-in user.

### 5.1 Required claims

| Claim | Type | Required | Description |
|---|---|---|---|
| `sub` | string | ✅ | Your app's user id. Stable for the lifetime of the user. Maps to `User.externalId` in the chat DB. |
| `iss` | string | ✅ | Your tenant's `id` (from create response). Identifies which tenant the JWT belongs to. |
| `exp` | number | ✅ | Unix expiration timestamp. Recommended: 1 hour (`now + 3600`). |
| `iat` | number | ✅ | Unix issue timestamp. Set automatically by most libraries. |
| `name` | string | ✅ | Display name. Shown in the chat UI. |
| `email` | string | – | Optional. Display only — not unique on the chat side. |
| `image` | string \| null | – | Avatar URL. Not validated server-side. |
| `scope` | string \| null | – | See [§6 Scopes](#6-scopes--partitioning-within-a-tenant). `null` or absent = tenant-wide. |

The HMAC algorithm is **HS256** with `jwtSecret` as the secret.

### 5.2 Reference implementation — Node.js with `jose`

```ts
// your-app/lib/chat-token.ts
import { SignJWT } from "jose";

const secret = new TextEncoder().encode(process.env.CHAT_TENANT_JWT_SECRET!);

export interface ChatTokenOpts {
  userId: string;       // your app's user id → JWT sub
  name: string;
  email?: string | null;
  image?: string | null;
  scope?: string | null; // null/undefined = tenant-wide
  ttlSeconds?: number;   // default 3600
}

export async function mintChatToken(opts: ChatTokenOpts): Promise<string> {
  return new SignJWT({
    sub:   opts.userId,
    name:  opts.name,
    email: opts.email ?? undefined,
    image: opts.image ?? undefined,
    iss:   process.env.CHAT_TENANT_ID!,
    scope: opts.scope ?? null,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${opts.ttlSeconds ?? 3600}s`)
    .sign(secret);
}
```

### 5.3 Reference implementation — Python with PyJWT

```python
# your_app/chat_token.py
import jwt, time, os

def mint_chat_token(user_id, name, *, email=None, image=None, scope=None, ttl=3600):
    return jwt.encode(
        {
            "sub":   user_id,
            "name":  name,
            "email": email,
            "image": image,
            "iss":   os.environ["CHAT_TENANT_ID"],
            "scope": scope,
            "iat":   int(time.time()),
            "exp":   int(time.time()) + ttl,
        },
        os.environ["CHAT_TENANT_JWT_SECRET"],
        algorithm="HS256",
    )
```

### 5.4 Reference implementation — Go

```go
// your_app/chat_token.go
package chat

import (
    "os"
    "time"
    "github.com/golang-jwt/jwt/v5"
)

type TokenOpts struct {
    UserID, Name, Email, Image string
    Scope                       *string
    TTL                         time.Duration
}

func MintToken(opts TokenOpts) (string, error) {
    now := time.Now()
    ttl := opts.TTL
    if ttl == 0 { ttl = time.Hour }

    claims := jwt.MapClaims{
        "sub":   opts.UserID,
        "iss":   os.Getenv("CHAT_TENANT_ID"),
        "name":  opts.Name,
        "email": opts.Email,
        "image": opts.Image,
        "scope": opts.Scope,
        "iat":   now.Unix(),
        "exp":   now.Add(ttl).Unix(),
    }
    tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
    return tok.SignedString([]byte(os.Getenv("CHAT_TENANT_JWT_SECRET")))
}
```

### 5.5 Expose a mint endpoint on your backend

The browser will call this each time it needs a fresh JWT. Auth is handled by your existing session system — only signed-in users get a token:

```ts
// your-app/app/api/chat/token/route.ts  (Next.js App Router)
import { mintChatToken } from "@/lib/chat-token";
import { auth } from "@/lib/auth";  // your existing session resolver

export async function POST() {
  const session = await auth();
  if (!session?.user) return new Response("unauthorized", { status: 401 });

  const token = await mintChatToken({
    userId: session.user.id,
    name:   session.user.name,
    email:  session.user.email,
    image:  session.user.image,
    scope:  null, // or session.user.team, etc — see §6
  });

  return Response.json({ token });
}
```

> ⚠️ **Never expose `CHAT_TENANT_JWT_SECRET` to the browser.** It must stay server-side. The browser only ever sees the minted JWT.

---

## 6. Scopes — partitioning within a tenant

`scope` is an optional second-level partition inside a tenant. It lets one tenant carry many isolated contexts (projects, support tickets, deal rooms, classrooms) without spinning up a new tenant per context.

### 6.1 Two kinds of identities

| `scope` value | Identity type | Can see |
|---|---|---|
| `null` (or omitted) | **Tenant-wide** | Every user in this tenant, regardless of their scope |
| `"project_alpha"` (any string) | **Scoped** | Only same-scope users (`"project_alpha"`) + tenant-wide users (`null`) |

### 6.2 Server-enforced rules

- User search (`GET /api/users/search`) returns only same-scope + tenant-wide peers for scoped callers.
- Tenant-wide search (`GET /api/users/tenant/search`) and directory (`GET /api/users/tenant`) require `scope === null` (403 otherwise).
- Creating a DM/group across scopes (`POST /api/conversations/tenant`) requires `scope === null`.
- Adding a member with a different scope fails with 403.

### 6.3 Picking scopes

| Use case | Recommendation |
|---|---|
| Slack-style — one open chat for the whole org | Always `scope: null`. No scoping at all. |
| Project-based — each project has its own chat, admins span all | Project members: `scope: "project_<id>"`. Admins: `scope: null`. |
| Support — customer ↔ agent chats, customers can't see each other | Customers: `scope: "ticket_<id>"` (one scope per ticket). Agents: `scope: null`. |
| Classroom — students per class, teachers can DM any student | Students: `scope: "class_<id>"`. Teachers: `scope: null`. |

### 6.4 Scope transitions

If a user moves from one scope to another (project transfer, role promotion):

1. **Update the `scope` claim** on the next JWT you mint for them. The chat server re-materializes `User.scope` on every authenticated request.
2. **Existing conversation memberships are not moved.** A scoped user who was in a same-scope group keeps seeing that group even after their scope changes (the membership row predates the new scope).
3. To enforce stricter isolation, your backend should remove the user from conversations whose context no longer applies. There's a `DELETE /api/conversations/:id/members/:userId` endpoint for that.

---

## 7. Token lifecycle & refresh

JWTs are short-lived bearer tokens. Your client should be designed to **mint, use, expire, re-mint** without user friction.

### 7.1 Suggested TTL

| Context | Recommended `exp` |
|---|---|
| Production browser sessions | 1 hour |
| Long-lived background workers | 5 minutes (re-mint per task) |
| One-off scripts | 5 minutes |
| Server-side rendering with no client | 1 minute (re-mint per render) |

### 7.2 Client-side refresh strategy

```ts
// your-app/lib/chat-fetch.ts
let cachedJwt: string | null = null;
let expiresAt: number = 0;

async function getJwt(force = false): Promise<string> {
  const now = Date.now();
  // Refresh 1 minute before expiry to avoid races.
  if (!force && cachedJwt && now < expiresAt - 60_000) return cachedJwt;

  const res = await fetch("/api/chat/token", { method: "POST" });
  if (!res.ok) throw new Error("failed to mint chat token");
  const { token, expiresIn } = await res.json();
  cachedJwt = token;
  expiresAt = now + expiresIn * 1000;
  return token;
}

export async function chatFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  let jwt = await getJwt();
  const url = `${process.env.NEXT_PUBLIC_CHAT_API_URL}${path}`;
  const doFetch = (t: string) =>
    fetch(url, {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${t}`,
        "Content-Type": "application/json",
      },
    });

  let res = await doFetch(jwt);
  if (res.status === 401) {
    // JWT expired between refresh + use, or secret was rotated server-side.
    jwt = await getJwt(true);
    res = await doFetch(jwt);
  }
  if (!res.ok) throw new Error(`chat ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}
```

### 7.3 WebSocket token refresh

Centrifuge has its own connection token (different from your chat JWT — it's minted by the chat server using your JWT). The SDK calls a `getToken` callback when its current token is about to expire:

```ts
const cf = new Centrifuge(WS_URL, {
  token: initialToken,
  getToken: async () => {
    const { token } = await chatFetch<{ token: string }>(
      "/centrifugo/connection-token",
      { method: "POST" },
    );
    return token;
  },
});
```

You don't need to time anything yourself — the SDK handles its own clock.

---

## 8. Calling the chat API

### 8.1 Base URL

Production: **`https://chat.technext.it/api`**

In the integrating app, expose this as a build-time public env so the bundle ships with the right URL:

```bash
# your-app/.env.production
NEXT_PUBLIC_CHAT_API_URL=https://chat.technext.it/api
NEXT_PUBLIC_CHAT_WS_URL=wss://chat.technext.it/connection/websocket
NEXT_PUBLIC_CHAT_STORAGE_URL=https://chat.technext.it/chatapp
```

### 8.2 Headers on every request

```
Authorization: Bearer <user-jwt>
Content-Type:  application/json   (on POST/PUT)
```

### 8.3 CORS

The chat server returns `Access-Control-Allow-Origin: <your-origin>` for any origin in the operator's `CORS_ALLOWED_ORIGINS` allowlist. Operator must add your production origin (`https://chamate.com`, `https://app.acme.com`) to that list before your real users can connect.

### 8.4 Internal id vs. externalId

| Field | Where it's used | Who controls it |
|---|---|---|
| `User.externalId` | The `sub` claim of your JWT | You (your app's user id) |
| `User.id` | Chat server's internal UUID | Chat server (created on first JWT) |

When the chat API asks for `userId` (member arrays, mention payloads, etc.) it wants the **internal `id`**, not your external id. Get the internal id once via `GET /api/me` after the user's first authenticated call, and cache it on your end.

---

## 9. Data shapes

These shapes are what `/api/*` endpoints accept and return. Times are ISO-8601 UTC strings.

### User

```ts
interface User {
  id:           string;       // chat-internal UUID
  tenantId:     string;
  externalId:   string;       // your sub claim
  scope:        string | null;
  name:         string;
  email:        string | null;
  image:        string | null;
  lastActiveAt: string | null;
  createdAt:    string;
  updatedAt:    string;
}
```

### Conversation

```ts
interface Conversation {
  id:          string;
  tenantId:    string;
  type:        "direct" | "group";
  name:        string | null;       // null for direct chats
  createdBy:   string;              // creator's internal User.id
  createdAt:   string;
  updatedAt:   string;
  version:     number;              // bumped on member/meta changes
  currentSeq:  number;              // last message's seq
  members:     ConversationMember[];
  unreadCount: number;              // *for the caller*, not all members
  muted:       boolean;             // *for the caller*
  lastMessage: Message | null;
}

interface ConversationMember {
  id:                 string;
  userId:             string;
  role:               "owner" | "admin" | "member";
  joinedAt:           string;
  lastReadMessageId:  string | null;
  lastReadAt:         string | null;
  muted:              boolean;
  unreadCount:        number;
  user:               Pick<User, "id" | "name" | "email" | "image" | "lastActiveAt">;
}
```

### Message

```ts
interface Message {
  id:              string;
  tenantId:        string;
  conversationId:  string;
  senderId:        string;          // User.id
  content:         TiptapDoc;       // see §13
  plainContent:    string;          // flattened text for search/preview
  type:            "text" | "system" | "image";
  replyToId:       string | null;
  editedAt:        string | null;
  deletedAt:       string | null;
  createdAt:       string;
  seq:             number;          // per-conversation monotonic
  clientMessageId: string | null;   // your idempotency key, see §12
  sender:          Pick<User, "id" | "name">;
  attachments?:    Attachment[];
  reactions?:      Reaction[];
}
```

### Attachment

```ts
interface Attachment {
  id:          string;
  messageId:   string | null;       // null for orphaned pre-upload rows
  uploaderId:  string;
  url:         string;              // public URL — works for image/video tags
  contentType: string;
  filename:    string;
  size:        number;
  width:       number | null;
  height:      number | null;
  createdAt:   string;
}
```

---

## 10. Endpoint reference

Full interactive playground: **`https://chat.technext.it/api/docs`** (Scalar UI — also serves the raw OpenAPI spec at `/api/openapi.json`).

Paths below are relative to the API base (`https://chat.technext.it/api`).

### Identity

| Method | Path | Description |
|---|---|---|
| `GET` | `/me` | Resolve current user. Also lazily creates User row on first call. |
| `GET` | `/init` | Bootstrap: returns first page of conversations + a Centrifugo connection token in one round-trip. Recommended for app startup. |
| `POST` | `/me/active` | Heartbeat — update `lastActiveAt`. Call every ~30s while user is active. |
| `POST` | `/me/broadcast-profile` | Tell every conversation peer that your profile changed. Cheap, idempotent. |
| `DELETE` | `/me` | GDPR delete — wipes the user's messages, attachments, subscriptions. |

### Users (discovery)

| Method | Path | Description |
|---|---|---|
| `GET` | `/users/search?q=…` | Typeahead. Returns same-scope + tenant-wide peers for scoped callers; everyone in the tenant for tenant-wide. |
| `GET` | `/users/tenant?cursor=…&limit=30` | **Tenant-wide only.** Paginated directory of every user in the tenant. 403 for scoped callers. |
| `GET` | `/users/tenant/search?q=…` | **Tenant-wide only.** Cross-scope typeahead. |

### Conversations

| Method | Path | Description |
|---|---|---|
| `GET` | `/conversations?limit=50&cursor=…` | List the caller's conversations, paginated. |
| `GET` | `/conversations/:id` | Get one. |
| `POST` | `/conversations` | Create a DM or group within the caller's scope. Body: `{ type: "direct" \| "group", name?, memberIds[] }` |
| `POST` | `/conversations/tenant` | **Tenant-wide only.** Same shape, but member ids can span scopes. |
| `PUT` | `/conversations/:id` | Rename. Body: `{ name }` |
| `POST` | `/conversations/:id/members` | Add. Body: `{ memberIds[] }`. Enforces 1000-member cap. |
| `DELETE` | `/conversations/:id/members/:userId` | Remove a member. |
| `POST` | `/conversations/:id/leave` | Leave a conversation. |
| `POST` | `/conversations/:id/read` | Mark conversation read. Body: `{ upToMessageId }`. Idempotent. |
| `POST` | `/conversations/:id/mute` | Mute. Body: `{ muted: true \| false }` |
| `POST` | `/conversations/:id/typing` | Broadcast typing indicator. Fire-and-forget. |

### Messages

| Method | Path | Description |
|---|---|---|
| `GET` | `/conversations/:id/messages?limit=50&cursor=…` | History, newest-first. |
| `POST` | `/conversations/:id/messages` | Send. Body: `{ content, type, replyToId?, attachmentIds?, clientMessageId? }` |
| `PUT` | `/conversations/:id/messages/:messageId` | Edit. Body: `{ content }` |
| `DELETE` | `/conversations/:id/messages/:messageId` | Soft-delete. |
| `POST` | `/conversations/:id/messages/:messageId/reactions` | Add. Body: `{ emoji }` |
| `DELETE` | `/conversations/:id/messages/:messageId/reactions/:emoji` | Remove. |

### Search

| Method | Path | Description |
|---|---|---|
| `GET` | `/search?q=…` | Global trigram-fuzzy search across every conversation the caller is in. |
| `GET` | `/conversations/:id/search?q=…` | Same, scoped to one conversation. |

### Attachments

| Method | Path | Description |
|---|---|---|
| `POST` | `/attachments/upload-url` | Mint a presigned PUT URL. See [§14](#14-file-attachments). |
| `GET` | `/attachments/:id/download` | 302 → presigned GET URL with `Content-Disposition: attachment`. |

### Centrifugo tokens

| Method | Path | Description |
|---|---|---|
| `POST` | `/centrifugo/connection-token` | Mint a short-lived JWT for the Centrifugo WS handshake. |
| `POST` | `/centrifugo/subscription-token` | Mint a token for a specific channel (e.g. `presence:conv_<id>`). |

### Web Push

| Method | Path | Description |
|---|---|---|
| `GET` | `/push/vapid-public-key` | Returns the server's VAPID public key for `pushManager.subscribe`. |
| `POST` | `/push/subscribe` | Register a browser endpoint. Body: `{ endpoint, keys: { p256dh, auth } }` |
| `POST` | `/push/unsubscribe` | Body: `{ endpoint }` |

### Webhooks (your backend → chat)

Auth: `Authorization: Bearer <tenant.apiKey>` plus optional `X-Chat-Signature: sha256=<hex>`.

| Method | Path | Description |
|---|---|---|
| `POST` | `/webhooks/users.updated` | Upsert user profile. Idempotent. |
| `POST` | `/webhooks/users.deleted` | Delete a user (GDPR or unsubscribe path). |

### Admin (operator → chat)

Auth: `Authorization: Bearer <MASTER_API_KEY>`.

| Method | Path | Description |
|---|---|---|
| `POST` | `/admin/tenants` | Create a tenant. |
| `GET` | `/admin/tenants` | List tenants (secrets masked). |
| `POST` | `/admin/tenants/:id/api-keys` | Rotate tenant `apiKey`. |
| `POST` | `/admin/tenants/:id/jwt-secret/rotate` | Rotate tenant `jwtSecret`. |

---

## 11. Pagination

Everywhere the API paginates, it uses **opaque keyset cursors** — never offsets. Send the `cursor` you got from the previous response unchanged.

### 11.1 Conversations

```ts
const r = await chatFetch<{
  conversations: Conversation[];
  nextCursor:    string | null;
}>("/conversations?limit=50");

if (r.nextCursor) {
  const next = await chatFetch(`/conversations?limit=50&cursor=${encodeURIComponent(r.nextCursor)}`);
}
```

Ordering: most-recent-active first.

### 11.2 Messages

```ts
const r = await chatFetch<{
  messages:   Message[];
  nextCursor: string | null;
}>(`/conversations/${convId}/messages?limit=50`);
```

Ordering: newest-first within the page. When loading older history (scrollback), keep passing the previous `nextCursor`.

### 11.3 Tenant directory

```ts
const r = await chatFetch<{
  users:      User[];
  nextCursor: string | null;
}>("/users/tenant?limit=30");
```

Ordering: `(name, id) ASC`.

---

## 12. Idempotency & retries

### 12.1 Send-message idempotency: `clientMessageId`

Generate a UUID on the client, send it on every retry. The server treats `(conversationId, clientMessageId)` as unique and returns the existing row on the second send instead of creating a duplicate.

```ts
const clientMessageId = crypto.randomUUID();

await chatFetch(`/conversations/${convId}/messages`, {
  method: "POST",
  body: JSON.stringify({
    content,
    type: "text",
    clientMessageId,    // ← same value across retries
  }),
});
```

Recommended: even on first-time sends, always pass `clientMessageId`. Then a 5xx retry never doubles.

### 12.2 Webhooks (your backend → chat)

`POST /api/webhooks/users.updated` and `users.deleted` are idempotent on `externalId`. Safe to retry indefinitely.

### 12.3 Read receipts

`POST /api/conversations/:id/read` is idempotent on `(memberId, upToMessageId)` — the server uses a `WHERE seq >= currentLastRead` filter that ignores out-of-order or duplicate calls.

### 12.4 Reactions

Add (`POST /reactions`) is idempotent on `(messageId, userId, emoji)`. Remove (`DELETE /reactions/:emoji`) returns 200 whether the reaction existed or not.

### 12.5 Mute, typing

Both fire-and-forget on the client; both safe to retry on transient errors.

---

## 13. Message content format (Tiptap JSON)

The chat server stores message bodies as **[Tiptap](https://tiptap.dev/) AST JSON** (a subset of [ProseMirror](https://prosemirror.net/) document format). This avoids ever serializing HTML over the wire.

### 13.1 Minimal text message

```json
{
  "type": "doc",
  "content": [
    {
      "type": "paragraph",
      "content": [
        { "type": "text", "text": "Hello world" }
      ]
    }
  ]
}
```

### 13.2 With formatting marks

```json
{
  "type": "doc",
  "content": [
    {
      "type": "paragraph",
      "content": [
        { "type": "text", "text": "I'm " },
        { "type": "text", "text": "bold", "marks": [{ "type": "bold" }] },
        { "type": "text", "text": " and " },
        { "type": "text", "text": "italic", "marks": [{ "type": "italic" }] }
      ]
    }
  ]
}
```

Supported marks: `bold`, `italic`, `code`, `link` (`{ type: "link", attrs: { href, target } }`).

### 13.3 Mentions

```json
{
  "type": "mention",
  "attrs": {
    "id":    "u_a3b1...",
    "label": "Alice Chen"
  }
}
```

The server extracts mention ids when persisting the message and bypasses mute settings for mentioned users (they get push notifications even if they muted the conversation).

### 13.4 Limits

| Limit | Value |
|---|---|
| Max message JSON size | 32 KB |
| Max plain-text length | 8000 chars |
| Max mentions per message | 50 |

Server validates against a Zod schema and returns 400 on violation.

---

## 14. File attachments

The chat server never proxies bytes — uploads go **direct browser → object storage**. Server's job is to mint a short-lived presigned URL and record metadata.

### 14.1 Upload flow

```ts
// 1. Ask server for a presigned PUT URL
const upload = await chatFetch<{
  attachmentId: string;
  uploadUrl:    string;
  publicUrl:    string;
  key:          string;
  expiresIn:    number;
}>("/attachments/upload-url", {
  method: "POST",
  body: JSON.stringify({
    filename:    file.name,
    contentType: file.type,
    size:        file.size,
    width:       null,       // optional, for images
    height:      null,
  }),
});

// 2. Browser PUTs the file straight to object storage
await fetch(upload.uploadUrl, {
  method:  "PUT",
  body:    file,
  headers: { "Content-Type": file.type },
});

// 3. Send a message referencing the attachment
await chatFetch(`/conversations/${convId}/messages`, {
  method: "POST",
  body: JSON.stringify({
    content: { type: "doc", content: [/* … */] },
    type:    "text",
    attachmentIds:   [upload.attachmentId],
    clientMessageId: crypto.randomUUID(),
  }),
});
```

### 14.2 Limits

| Limit | Default |
|---|---|
| Single file size | 25 MB |
| User total quota | 5 GB |
| Presigned URL TTL | 5 min for upload, 1 min for download |
| Allowed `Content-Type`s | Any (no MIME validation server-side) |

### 14.3 Orphan cleanup

If your user requests an upload URL but never sends the message, the attachment row stays with `messageId = null`. A periodic job sweeps `messageId IS NULL AND createdAt < now() - 1h` and deletes both the row and the object.

### 14.4 Downloads

The `publicUrl` returned at upload time works for inline rendering (`<img>`, `<video>`) — no auth required, the URL is content-addressable.

For force-download with the original filename:

```ts
window.location.href =
  `${process.env.NEXT_PUBLIC_CHAT_API_URL}/attachments/${attachmentId}/download` +
  `?_token=${encodeURIComponent(await getJwt())}`;
```

(The endpoint accepts `Authorization: Bearer …` OR `?_token=…` so the browser can use a plain `<a href>`.)

---

## 15. Real-time delivery (Centrifugo)

The chat server uses [Centrifugo v6](https://centrifugal.dev/) for WebSocket fan-out. Your frontend opens one connection on app startup and receives every chat event for the current user through it.

### 15.1 Architecture

```
your browser ⇄ wss://chat.technext.it/connection/websocket
                              │
                              │ (Traefik routes direct to centrifugo container)
                              ▼
                  centrifugo:8000 (private)
                              │
                              │ (PostgreSQL consumer reads server's outbox table)
                              ▼
                         server inserts events
```

You never talk to Centrifugo's container directly — the public WebSocket endpoint is what your browser connects to, and Traefik handles the path-based routing.

### 15.2 Install the client

```bash
npm install centrifuge
```

### 15.3 Connect on app startup

```ts
// your-app/lib/chat-realtime.ts
"use client";
import { Centrifuge, type Subscription } from "centrifuge";
import { chatFetch } from "./chat-fetch";

let cf: Centrifuge | null = null;

export async function connectChat(opts: {
  onEvent:     (channel: string, data: unknown) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
}) {
  // /init returns conversations + a Centrifugo connection token in one
  // round-trip. Use that token to open the WS.
  const init = await chatFetch<{
    conversations:   any[];
    centrifugoToken: string;
  }>("/init");

  cf = new Centrifuge(process.env.NEXT_PUBLIC_CHAT_WS_URL!, {
    token: init.centrifugoToken,
    // Centrifuge calls this when its token approaches expiry, OR after
    // a 3500 disconnect (token expired). It's separate from your chat
    // JWT — this one is minted by /api/centrifugo/connection-token.
    getToken: async () => {
      const r = await chatFetch<{ token: string }>(
        "/centrifugo/connection-token",
        { method: "POST" },
      );
      return r.token;
    },
  });

  cf.on("connected",    () => opts.onConnected?.());
  cf.on("disconnected", () => opts.onDisconnected?.());

  // All events fan in here. The JWT's `subs` claim auto-subscribed
  // the connection to `user:<myUserId>`, so every event arrives on
  // that one channel.
  cf.on("publication", (ctx) => opts.onEvent(ctx.channel, ctx.data));

  cf.connect();
  return { centrifuge: cf, initialConversations: init.conversations };
}

export function disconnectChat() {
  cf?.disconnect();
  cf = null;
}
```

### 15.4 Channel structure

| Channel | Subscription type | What it carries |
|---|---|---|
| `user:<myUserId>` | Auto-subscribed via connection token's `subs` claim | Every event for the current user across all conversations |
| `presence:conv_<conversationId>` | Manual, per-conversation | Typing indicators, online presence for that conversation |

The `user:` channel is the workhorse. Most apps only need to subscribe to it once and route events to UI state. The `presence:` channels are for typing dots / "who's looking at this conversation" — opt-in per-conversation.

### 15.5 Subscribing to presence (optional)

```ts
async function subscribePresence(convId: string) {
  if (!cf) throw new Error("not connected");

  const { token } = await chatFetch<{ token: string }>(
    "/centrifugo/subscription-token",
    {
      method: "POST",
      body:   JSON.stringify({ channel: `presence:conv_${convId}` }),
    },
  );

  const sub = cf.newSubscription(`presence:conv_${convId}`, { token });
  sub.on("publication", (ctx) => {
    // typing indicators arrive here
  });
  sub.on("join",  (ctx) => { /* user joined this presence */ });
  sub.on("leave", (ctx) => { /* user left */ });
  sub.subscribe();
  return sub;
}
```

Unsubscribe when the user switches away from that conversation — leaving them all open wastes Centrifugo memory.

---

## 16. Real-time event catalog

Every event that lands on the `user:<id>` channel has a `type` field discriminating the shape:

| `type` | Fired when | Payload |
|---|---|---|
| `message_created` | New message in any conversation you're in | `{ type, conversationId, message: Message }` |
| `message_updated` | Edit | `{ type, conversationId, messageId, content, editedAt }` |
| `message_deleted` | Delete | `{ type, conversationId, messageId, deletedAt }` |
| `reaction_added` | Reaction added | `{ type, conversationId, messageId, reaction: Reaction }` |
| `reaction_removed` | Reaction removed | `{ type, conversationId, messageId, userId, emoji }` |
| `conversation_created` | You were added to a new conversation (DM or group) | `{ type, conversation: Conversation }` |
| `conversation_updated` | Renamed / re-ordered | `{ type, conversation: Conversation }` |
| `member_added` | Someone joined a conversation you're in | `{ type, conversationId, member: ConversationMember }` |
| `member_removed` | Someone left | `{ type, conversationId, userId }` |
| `read_receipt` | Someone marked messages read up to X | `{ type, conversationId, userId, lastReadMessageId, lastReadAt }` |
| `user_updated` | A peer's profile changed | `{ type, user: Partial<User> }` |
| `user_active` | A peer's `lastActiveAt` updated | `{ type, userId, lastActiveAt }` |

### Handling pattern

```ts
type UserChannelEvent =
  | { type: "message_created"; conversationId: string; message: Message }
  | { type: "message_updated"; conversationId: string; messageId: string; content: any; editedAt: string }
  | { type: "message_deleted"; conversationId: string; messageId: string; deletedAt: string }
  | { type: "conversation_created"; conversation: Conversation }
  | { type: "read_receipt"; conversationId: string; userId: string; lastReadMessageId: string; lastReadAt: string }
  // ... etc.
  ;

connectChat({
  onEvent: (channel, data) => {
    const event = data as UserChannelEvent;
    switch (event.type) {
      case "message_created":
        if (event.conversationId === currentlyOpenConvId) {
          appendMessage(event.message);
        } else {
          incrementUnread(event.conversationId);
        }
        break;
      case "read_receipt":
        if (event.userId === otherUserId) markMessagesAsSeen(event.lastReadMessageId);
        break;
      // ...
    }
  },
});
```

### Idempotency on receive

Each event carries an `idempotencyKey` field (server-side dedup), but **you should still dedupe on the client** — Centrifugo's at-least-once delivery means you may receive the same event twice across reconnects. Track `event.idempotencyKey` or `(event.type, event.messageId)` in a recent-events set.

---

## 17. Web Push notifications

Web Push lets your app deliver OS-level notifications even when the browser tab is closed.

### 17.1 Server setup

The operator must set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` in their Dokploy env. Without these, push endpoints return 503.

### 17.2 Browser flow

```ts
// 1. Register your service worker (must be at root scope)
const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });

// 2. Ask user for notification permission
const perm = await Notification.requestPermission();
if (perm !== "granted") return;

// 3. Fetch the server's VAPID public key
const { key } = await chatFetch<{ key: string }>("/push/vapid-public-key");

// 4. Subscribe this browser to Web Push
const sub = await reg.pushManager.subscribe({
  userVisibleOnly:      true,
  applicationServerKey: urlBase64ToUint8Array(key),
});

// 5. Send the subscription to the chat server
await chatFetch("/push/subscribe", {
  method: "POST",
  body:   JSON.stringify(sub.toJSON()),
});

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
```

### 17.3 Service worker

Save as `public/sw.js`:

```js
// public/sw.js
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : { title: "Message", body: "" };

  event.waitUntil(
    (async () => {
      // Suppress OS notification when an app tab is already focused —
      // the in-app toast covers it. Comment this out if you want both.
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (clients.some((c) => c.visibilityState === "visible" && c.focused)) return;

      await self.registration.showNotification(data.title || "New message", {
        body: data.body || "",
        tag:  data.tag,
        // Without renotify, same-tag pushes silently update Notification
        // Center instead of re-alerting. You want this true for chat.
        renotify: true,
        icon: data.icon,
        data: { url: data.url || "/" },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(event.notification.data?.url || "/"));
});
```

### 17.4 Push payload schema

The chat server emits this on every new message (for non-muted recipients):

```json
{
  "title": "Alice Chen",
  "body":  "Hey, are you available?",
  "tag":   "conv:c_a3b1f2...",
  "url":   "/"
}
```

`tag` groups notifications by conversation so a chatty conversation doesn't stack 50 banners. `renotify: true` in your SW makes each new message re-alert.

---

## 18. Webhooks (your backend → chat)

Use these to push profile updates and deletions from your auth system to the chat server immediately, instead of waiting for the lazy-create on next JWT.

### 18.1 Endpoints

| Path | When to call |
|---|---|
| `POST /api/webhooks/users.updated` | User edits profile, changes avatar, etc. |
| `POST /api/webhooks/users.deleted` | User deletes account / GDPR request. |

### 18.2 Auth

Two layers, both optional individually, mandatory together for production:

1. **Bearer token** — `Authorization: Bearer <tenant.apiKey>` proves you're the tenant.
2. **HMAC signature** — `X-Chat-Signature: sha256=<hex>`. Computed as `HMAC-SHA256(apiKey, rawBody)`. Set `WEBHOOK_SIGNATURE_REQUIRED=true` on the chat server in prod.

### 18.3 Signing in Node

```ts
import crypto from "node:crypto";

async function callChatWebhook(path: string, payload: object): Promise<void> {
  const raw = JSON.stringify(payload);
  const signature = crypto
    .createHmac("sha256", process.env.CHAT_TENANT_API_KEY!)
    .update(raw)
    .digest("hex");

  const res = await fetch(`${process.env.CHAT_API_URL}${path}`, {
    method:  "POST",
    headers: {
      "Content-Type":     "application/json",
      "Authorization":    `Bearer ${process.env.CHAT_TENANT_API_KEY}`,
      "X-Chat-Signature": `sha256=${signature}`,
    },
    body: raw,
  });
  if (!res.ok) throw new Error(`chat webhook ${path}: ${res.status} ${await res.text()}`);
}

export const upsertChatUser = (p: {
  externalId: string;
  name:       string;
  email?:     string;
  image?:     string;
  scope?:     string | null;
}) => callChatWebhook("/webhooks/users.updated", p);

export const deleteChatUser = (externalId: string) =>
  callChatWebhook("/webhooks/users.deleted", { externalId });
```

### 18.4 Rate limits

| Bucket | Limit |
|---|---|
| Per tenant | 100 requests/min |
| Per `(tenant, externalId)` | 10 requests/min |

Batch profile updates on your side and queue them, or accept that chat will re-materialize on next JWT mint anyway.

---

## 19. Rate limits

Most endpoints are rate-limited per `(user, route)` to protect against runaway clients. Limits:

| Bucket | Limit |
|---|---|
| Default authenticated endpoints | 60 req/min per user |
| `POST /conversations/:id/messages` | 60 messages/min per user |
| `POST /attachments/upload-url` | 30/min per user |
| `POST /conversations/:id/typing` | 60/min per conversation per user |
| `POST /webhooks/*` | See §18.4 |

Responses on exceeded limit:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 30
{ "error": "rate_limited", "message": "Too many requests", "retryAfter": 30 }
```

Handle 429 with exponential backoff. The `Retry-After` value is seconds.

---

## 20. Error responses

### 20.1 Shape

```json
{
  "error":   "machine_readable_code",
  "message": "human-readable explanation",
  "details": { /* optional, varies per error */ }
}
```

### 20.2 Codes you'll see

| Status | `error` | Cause |
|---|---|---|
| 400 | `validation_failed` | Body or query failed schema validation. `details.issues` has Zod issue array. |
| 401 | `unauthorized` | Missing/invalid/expired JWT. Re-mint and retry. |
| 403 | `forbidden` | Auth OK but caller not allowed for this resource (wrong scope, not a member). |
| 404 | `not_found` | Resource doesn't exist or not visible to caller (deliberately conflated to avoid information leakage). |
| 409 | `conflict` | Optimistic concurrency violation (rare). Refetch and retry. |
| 422 | `unprocessable` | Operation valid but business rule violated (e.g. 1000-member cap). |
| 429 | `rate_limited` | See §19. |
| 500 | `internal_error` | Server bug. Includes `details.requestId` — quote it to the operator. |
| 503 | `service_unavailable` | Centrifugo / push not configured, or upstream degraded. Retryable. |

### 20.3 Request IDs

Every response carries `X-Request-Id`. Log it on your side; if you need operator support, quote it — they can correlate to server logs.

---

## 21. Security

### 21.1 Things you must do

- Keep `CHAT_TENANT_JWT_SECRET` and `CHAT_TENANT_API_KEY` server-only. They must never appear in client bundles, in browser-accessible env vars, or in URLs.
- Mint JWTs short-lived (1h max). Refresh on the fly.
- Validate user identity in your own auth system before minting. The chat server trusts your JWT — anyone who can mint can impersonate.
- Enable `WEBHOOK_SIGNATURE_REQUIRED=true` on the chat server in production (operator).
- Use HTTPS only (chat server enforces this anyway).

### 21.2 Things you don't need to worry about

- Cross-tenant data leakage — every query is scoped by `tenantId` at the ORM level. A bug in one tenant's app can't read another tenant's data.
- WS authorization — Centrifugo verifies the connection token (signed by the chat server, not by you) and only delivers events for channels the user is allowed to see.
- Message content sanitization — you ship Tiptap JSON, not HTML. The chat server never round-trips HTML, so XSS via message content is impossible end-to-end.
- Push key leakage — VAPID keys aren't auth tokens. The worst case if leaked is an attacker can send push to users who already subscribed to your app, which they can also do by clicking your "Enable notifications" button.

### 21.3 Hardening recommendations

| Knob | Default | Recommended for prod |
|---|---|---|
| `CHAT_TENANT_API_KEY` rotation | manual | every 90 days |
| `CHAT_TENANT_JWT_SECRET` rotation | manual | every 90 days (invalidates active JWTs — coordinate with cache TTL) |
| User JWT TTL | – | 1 hour |
| `WEBHOOK_SIGNATURE_REQUIRED` (server-side) | `false` | `true` |
| CORS allowlist (server-side) | strict | one entry per integrating origin, no wildcards, no localhost in prod |

---

## 22. Production checklist

Before going live to real users:

### 22.1 Backend (your server)

- [ ] `CHAT_TENANT_ID`, `CHAT_TENANT_API_KEY`, `CHAT_TENANT_JWT_SECRET` set as server-only env vars
- [ ] JWT-minting endpoint (`/api/chat/token`) gated by your own auth
- [ ] JWTs have 1-hour TTL and refresh on the fly
- [ ] User webhook (`upsertChatUser`) called on signup + profile update
- [ ] User webhook called on account deletion (GDPR)
- [ ] Webhooks signed with HMAC-SHA256

### 22.2 Frontend (your browser bundle)

- [ ] `NEXT_PUBLIC_CHAT_API_URL`, `NEXT_PUBLIC_CHAT_WS_URL`, `NEXT_PUBLIC_CHAT_STORAGE_URL` set
- [ ] No secrets in any `NEXT_PUBLIC_*` env
- [ ] `chatFetch` wraps every call (no raw `fetch("/api/...")`)
- [ ] WS opens on app startup; reconnect handled by SDK
- [ ] Token refresh on 401 path tested
- [ ] Service worker registered + push subscription wired (if you want notifications)
- [ ] Idempotency keys on every send-message

### 22.3 Operator (chat-app side)

- [ ] Your production origin added to `CORS_ALLOWED_ORIGINS`
- [ ] VAPID keys generated and set (if you want push)
- [ ] `WEBHOOK_SIGNATURE_REQUIRED=true`
- [ ] `DEV_MINT_ENABLED=false` (the `/api/dev/mint-token` endpoint is dev-only)
- [ ] Database backed up regularly

### 22.4 End-to-end smoke

- [ ] Two browsers, two users from your app, sign in
- [ ] Open a DM, send messages — see them appear in real-time both sides
- [ ] Send an attachment — verify it uploads and renders
- [ ] Minimize one browser, send a message from the other — verify OS notification appears
- [ ] Drop the WS (DevTools → Offline checkbox in Service Workers tab) and bring it back — verify reconnect succeeds and missed events arrive

---

## 23. Troubleshooting

### 23.1 401 on every API call

- Check `iss` in the JWT matches your `CHAT_TENANT_ID` exactly.
- Check `exp` is in the future at the time of the call (server has 30s clock skew tolerance).
- Verify you're signing with the *current* `jwtSecret` — if the operator rotated, your old secret won't validate.
- Decode the JWT (paste into [jwt.io](https://jwt.io/)) and check the signature against `CHAT_TENANT_JWT_SECRET`.

### 23.2 WS connects then immediately disconnects

- Check DevTools → Network → WS → Messages tab. The first frame from server reveals the close reason. Common codes:
  - `109` — token expired (clock skew or TTL too short)
  - `3500` — invalid token signature (your server is using a stale Centrifugo HMAC secret)
- Confirm the connection token came from `POST /api/centrifugo/connection-token` (you've passed a valid chat JWT).

### 23.3 CORS errors in the browser

- Operator's `CORS_ALLOWED_ORIGINS` must contain your *exact* origin: scheme + host + port. No trailing slash. No path.
- Verify with `curl -I -H "Origin: https://your-origin.com" https://chat.technext.it/api/health` — expect `Access-Control-Allow-Origin: https://your-origin.com` in the response.

### 23.4 Presigned PUT returns 403

- Almost always a SigV4 host-mismatch. Verify the operator's `S3_PUBLIC_URL_BASE` matches the URL your browser is actually PUTting to.
- Don't add custom headers to the PUT beyond `Content-Type` — anything else breaks the signature.

### 23.5 Push received but no OS banner

- macOS Focus mode / Do Not Disturb silently suppresses all notifications. Toggle off.
- Browser-level: System Settings → Notifications → your browser → "Allow notifications" ON, "Alert style" not "None".
- Without `renotify: true` in your service worker, only the *first* push per conversation triggers a banner. Subsequent same-tag pushes silently update Notification Center. See [§17.3](#173-service-worker).

### 23.6 Events arrive but UI doesn't update

- Verify your `centrifuge.on("publication", ...)` handler is being called — add a console log.
- Check that you're updating React state via the proper hook — events arriving from a WS callback don't trigger re-renders unless you call `setState`.
- Track `event.idempotencyKey` — if your dedup is too aggressive you'll silently drop legit events.

---

## 24. End-to-end reference: a working Next.js integration

A complete, copy-pasteable Next.js 14+ integrator app. Drop into a project, set the env vars, and it works.

### 24.1 Project layout

```
your-app/
├─ app/
│  ├─ api/
│  │  └─ chat/
│  │     ├─ token/route.ts          ← mint JWT for current user
│  │     └─ webhook/route.ts        ← (optional) profile-sync webhook
│  └─ chat/
│     └─ page.tsx                   ← the chat UI
├─ lib/
│  ├─ chat-token.ts                 ← server-side JWT minting
│  ├─ chat-fetch.ts                 ← browser REST client
│  ├─ chat-federation.ts            ← server-side webhook caller
│  └─ chat-realtime.ts              ← browser WS client
├─ public/
│  └─ sw.js                         ← push service worker
└─ .env.local
```

### 24.2 Environment

```bash
# .env.local — your-app local dev
CHAT_API_URL=https://chat.technext.it
CHAT_TENANT_ID=tnt_3f9b...
CHAT_TENANT_API_KEY=ak_1c4f...
CHAT_TENANT_JWT_SECRET=js_a72e...

NEXT_PUBLIC_CHAT_API_URL=https://chat.technext.it/api
NEXT_PUBLIC_CHAT_WS_URL=wss://chat.technext.it/connection/websocket
NEXT_PUBLIC_CHAT_STORAGE_URL=https://chat.technext.it/chatapp
```

### 24.3 Server-side JWT mint

```ts
// app/api/chat/token/route.ts
import { SignJWT } from "jose";
import { auth } from "@/lib/auth";

const secret = new TextEncoder().encode(process.env.CHAT_TENANT_JWT_SECRET!);

export async function POST() {
  const session = await auth();
  if (!session?.user) return new Response("unauthorized", { status: 401 });

  const ttlSeconds = 3600;
  const token = await new SignJWT({
    sub:   session.user.id,
    name:  session.user.name,
    email: session.user.email,
    image: session.user.image,
    iss:   process.env.CHAT_TENANT_ID,
    scope: null,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secret);

  return Response.json({ token, expiresIn: ttlSeconds });
}
```

### 24.4 Browser REST client

```ts
// lib/chat-fetch.ts
"use client";

let cachedJwt: string | null = null;
let expiresAt = 0;

async function getJwt(force = false): Promise<string> {
  if (!force && cachedJwt && Date.now() < expiresAt - 60_000) return cachedJwt;
  const r = await fetch("/api/chat/token", { method: "POST" });
  if (!r.ok) throw new Error("jwt mint failed");
  const { token, expiresIn } = await r.json();
  cachedJwt = token;
  expiresAt = Date.now() + expiresIn * 1000;
  return token;
}

export async function chatFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  let jwt = await getJwt();
  const url = `${process.env.NEXT_PUBLIC_CHAT_API_URL}${path}`;
  const exec = (t: string) =>
    fetch(url, {
      ...init,
      headers: {
        ...init.headers,
        Authorization:  `Bearer ${t}`,
        "Content-Type": "application/json",
      },
    });

  let res = await exec(jwt);
  if (res.status === 401) {
    jwt = await getJwt(true);
    res = await exec(jwt);
  }
  if (!res.ok) throw new Error(`chat ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}
```

### 24.5 Browser realtime client

```ts
// lib/chat-realtime.ts
"use client";
import { Centrifuge } from "centrifuge";
import { chatFetch } from "./chat-fetch";

let cf: Centrifuge | null = null;

export async function connectChat(
  onEvent: (event: any) => void,
): Promise<{ initialConversations: any[] }> {
  const init = await chatFetch<{
    conversations:   any[];
    centrifugoToken: string;
  }>("/init");

  cf = new Centrifuge(process.env.NEXT_PUBLIC_CHAT_WS_URL!, {
    token: init.centrifugoToken,
    getToken: async () => {
      const r = await chatFetch<{ token: string }>(
        "/centrifugo/connection-token",
        { method: "POST" },
      );
      return r.token;
    },
  });

  cf.on("publication", (ctx) => onEvent(ctx.data));
  cf.connect();

  return { initialConversations: init.conversations };
}

export function disconnectChat() {
  cf?.disconnect();
  cf = null;
}
```

### 24.6 Server-side federation (call on signup / profile update)

```ts
// lib/chat-federation.ts  (server-only)
import crypto from "node:crypto";

async function signed(path: string, body: object): Promise<void> {
  const raw = JSON.stringify(body);
  const sig = crypto
    .createHmac("sha256", process.env.CHAT_TENANT_API_KEY!)
    .update(raw)
    .digest("hex");

  const r = await fetch(`${process.env.CHAT_API_URL}/api${path}`, {
    method:  "POST",
    headers: {
      "Content-Type":     "application/json",
      "Authorization":    `Bearer ${process.env.CHAT_TENANT_API_KEY}`,
      "X-Chat-Signature": `sha256=${sig}`,
    },
    body: raw,
  });
  if (!r.ok) throw new Error(`chat webhook ${path}: ${r.status}`);
}

export const upsertChatUser = (u: {
  externalId: string;
  name:       string;
  email?:     string;
  image?:     string;
}) => signed("/webhooks/users.updated", u);

export const deleteChatUser = (externalId: string) =>
  signed("/webhooks/users.deleted", { externalId });
```

### 24.7 Minimal UI

```tsx
// app/chat/page.tsx
"use client";
import { useEffect, useState } from "react";
import { connectChat, disconnectChat } from "@/lib/chat-realtime";
import { chatFetch } from "@/lib/chat-fetch";

export default function ChatPage() {
  const [conversations, setConversations] = useState<any[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<any[]>([]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const { initialConversations } = await connectChat((event) => {
        if (event.type === "message_created") {
          if (event.conversationId === activeId) {
            setMessages((m) => [...m, event.message]);
          }
        }
        if (event.type === "conversation_created") {
          setConversations((c) => [event.conversation, ...c]);
        }
      });
      if (mounted) setConversations(initialConversations);
    })();
    return () => {
      mounted = false;
      disconnectChat();
    };
  }, [activeId]);

  async function openConv(id: string) {
    setActiveId(id);
    const r = await chatFetch<{ messages: any[] }>(
      `/conversations/${id}/messages?limit=50`,
    );
    setMessages(r.messages.reverse());
  }

  async function send(text: string) {
    if (!activeId) return;
    await chatFetch(`/conversations/${activeId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        content: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text }] }],
        },
        type: "text",
        clientMessageId: crypto.randomUUID(),
      }),
    });
  }

  return (
    <div style={{ display: "flex", gap: 16 }}>
      <aside style={{ width: 240, borderRight: "1px solid #333" }}>
        {conversations.map((c) => (
          <button key={c.id} onClick={() => openConv(c.id)}>
            {c.name || c.members.map((m: any) => m.user.name).join(", ")}
          </button>
        ))}
      </aside>
      <main style={{ flex: 1 }}>
        {messages.map((m) => (
          <div key={m.id}>
            <strong>{m.sender.name}:</strong> {m.plainContent}
          </div>
        ))}
        {activeId && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const input = e.currentTarget.elements.namedItem(
                "text",
              ) as HTMLInputElement;
              if (input.value.trim()) send(input.value);
              input.value = "";
            }}
          >
            <input name="text" autoFocus />
          </form>
        )}
      </main>
    </div>
  );
}
```

### 24.8 Deployment

**Vercel (or any Next.js-compatible host):**

1. Push to GitHub.
2. Import in Vercel; set the env vars from §24.2.
3. Deploy. Note your production origin (e.g. `https://chamate-app.vercel.app`).
4. Email the chat operator: "Please add `https://chamate-app.vercel.app` to `CORS_ALLOWED_ORIGINS`."
5. Once they redeploy, your production app can chat.

**No reverse proxy, no WebSocket relay, no special server runtime required.** Vercel serves your Next.js bundle; the user's browser opens connections directly to `chat.technext.it`. Works the same on Netlify, Cloudflare Pages, your own VPS, anywhere.

---

## Appendix — capability lifecycle at a glance

| Capability | Who triggers | Direction | Auth |
|---|---|---|---|
| Provision tenant | Operator | → chat | `MASTER_API_KEY` |
| Rotate tenant secrets | Operator | → chat | `MASTER_API_KEY` |
| Mint user JWT | Your backend | (in-process) | `CHAT_TENANT_JWT_SECRET` |
| Sync user profile | Your backend → chat | webhook | `apiKey` + HMAC signature |
| Delete user | Your backend → chat | webhook | `apiKey` + HMAC signature |
| Chat API calls | Your frontend → chat | REST | user JWT |
| Real-time events | Chat → your frontend | WebSocket | Centrifugo connection token |
| File uploads | Your frontend → object storage | direct | presigned URL |
| Push notifications | Chat → user's browser | Web Push | VAPID-signed |

That's the whole integration surface. Everything else — chat features, search, attachments, presence — is built on top of these primitives.

If something here doesn't match what you observe in production, quote the request ID from the response header (`X-Request-Id`) and contact the operator. Most issues are environment misconfiguration (CORS allowlist, expired JWT, stale Centrifugo secret) and resolve within a redeploy.

Welcome to the chat.
