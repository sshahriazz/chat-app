# End-to-End Flow: How a Third-Party Service Uses This Chat Backend

A worked scenario — **Acme Inc. adds chat to their SaaS** — so you can see every actor and every hop without wading through route code.

For the reference API + code samples, see [INTEGRATION.md](./INTEGRATION.md).
This doc is the narrative companion: **how it works**, not **how to call it**.

## Contents

- [Cast](#cast)
- [Stage 1 — One-time onboarding](#stage-1--one-time-onboarding)
- [Stage 2 — Acme wires up their backend](#stage-2--acme-wires-up-their-backend)
- [Stage 3 — Alice opens Acme's app](#stage-3--alice-opens-acmes-app)
- [Stage 4 — Alice bootstraps the chat UI](#stage-4--alice-bootstraps-the-chat-ui)
- [Stage 5 — Alice connects to Centrifugo](#stage-5--alice-connects-to-centrifugo)
- [Stage 6 — Alice sends "hi" to Bob](#stage-6--alice-sends-hi-to-bob)
- [Stage 7 — Bob replies](#stage-7--bob-replies)
- [Stage 8 — Alice renames herself on Acme's side](#stage-8--alice-renames-herself-on-acmes-side)
- [Stage 9 — Alice deletes her Acme account](#stage-9--alice-deletes-her-acme-account)
- [Stage 10 — Alice's token expires mid-session](#stage-10--alices-token-expires-mid-session)
- [Stage 11 — Alice closes her laptop; Bob keeps writing](#stage-11--alice-closes-her-laptop-bob-keeps-writing)
- [Stage 12 — Alice has two tabs open](#stage-12--alice-has-two-tabs-open)
- [Stage 13 — Alice moves from Project A to Project B](#stage-13--alice-moves-from-project-a-to-project-b)
- [The mental model](#the-mental-model)
- [What's different for multiple tenants](#whats-different-for-multiple-tenants)
- [What if Acme itself hosts many isolated chats?](#what-if-acme-itself-hosts-many-isolated-chats)
- [Where to go next](#where-to-go-next)

---

## Cast

| Actor | Role |
|---|---|
| **Operator** | You. Run the chat server (this repo), hold `MASTER_API_KEY`. |
| **Acme Inc.** | The third-party. Owns its users (Alice, Bob). Has a backend + frontend. |
| **Acme Backend** | Acme's own API server. Holds the tenant `apiKey` + `jwtSecret`. |
| **Acme Frontend** | Acme's web/mobile app that users see. |
| **Chat Server** | What you deploy. Scopes everything per tenant. |
| **Centrifugo** | WebSocket bus, behind chat server. |

---

## Stage 1 — One-time onboarding

Acme emails you: "we want chat." You run:

```
POST https://chat.technext.it/chat-api/admin/tenants
Authorization: Bearer <MASTER_API_KEY>
Body: { "name": "Acme Inc." }

→ {
    "id":        "tnt_abc123",
    "name":      "Acme Inc.",
    "apiKey":    "k_9f8e…43chars",
    "jwtSecret": "s_1a2b…43chars"
  }
```

You paste those three values to Acme over a secure channel. **They appear exactly once** — lose them and rotation is the only recovery.

Acme stores all three in their secret manager (Vault, AWS Secrets Manager, whatever). From now on, **Acme's frontend never sees `apiKey` or `jwtSecret`** — only Acme's backend touches them.

---

## Stage 2 — Acme wires up their backend

Acme adds **two pieces** to their backend:

**(a) A mint endpoint** — for their frontend to get a chat token:

```ts
// Acme's backend: GET /api/chat-token
app.get("/api/chat-token", requireAcmeLogin, (req, res) => {
  const token = jwt.sign(
    { sub: req.user.id, name: req.user.name, image: req.user.avatarUrl },
    process.env.CHAT_JWT_SECRET,  // the jwtSecret from onboarding
    { issuer: process.env.CHAT_TENANT_ID, expiresIn: "1h", algorithm: "HS256" },
  );
  res.json({ token });
});
```

**(b) Webhook senders** — for profile changes:

```ts
// Called whenever an Acme user edits their profile
async function onAcmeUserUpdate(user) {
  const body = JSON.stringify({
    externalId: user.id,
    name: user.name,
    image: user.avatarUrl,
  });
  const signature = crypto
    .createHmac("sha256", process.env.CHAT_API_KEY)
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
}
```

That's it. **Acme doesn't operate a chat user table. Acme doesn't sync users. Acme just mints tokens and pushes updates.**

---

## Stage 3 — Alice opens Acme's app

```
┌─ Alice's browser ─────────────────────────────────────────────────┐
│                                                                   │
│ 1. Logs in to Acme normally (Acme's own auth, unrelated to chat)  │
│                                                                   │
│ 2. Navigates to the "Messages" tab                                │
│                                                                   │
│ 3. Acme's frontend calls acme.com/api/chat-token  ────────────┐   │
└───────────────────────────────────────────────────────────────┼───┘
                                                                │
                                                                ▼
┌─ Acme Backend ─────────────────────────────────────────────┐
│ Signs a JWT:                                               │
│   sub   = "alice_42"  (Acme's own user id)                 │
│   iss   = "tnt_abc123"                                     │
│   name  = "Alice Chen"                                     │
│   exp   = now + 1h                                         │
│ Returns { token } to Alice's browser                       │
└────────────────────────────────────────────────────────────┘
```

Alice's browser now has a short-lived JWT in memory (stored in `localStorage` via our reference client). From now on, every request to the chat server carries `Authorization: Bearer <jwt>`.

---

## Stage 4 — Alice bootstraps the chat UI

Two calls in parallel:

```
GET /chat-api/me              → { id: "uuid-a", name: "Alice Chen", email: "alice@acme.com", image: "…" }
GET /chat-api/init?limit=50   → { conversations: [...], nextCursor: "...", centrifugoToken: "..." }
```

`/me` exists precisely so the client can resolve its internal id before it needs to render anything. `/init` is the bulk bootstrap — first page of conversations + the Centrifugo connection token in one round-trip.

**Under the hood of the very first request** (server-side):

```
┌─ requireUserJwt middleware ────────────────────────────────┐
│                                                            │
│ 1. Extract `Authorization: Bearer <jwt>`                   │
│                                                            │
│ 2. Decode iss UNVERIFIED → "tnt_abc123"                    │
│    (we don't trust this yet, just use it to route)         │
│                                                            │
│ 3. getTenantById("tnt_abc123")                             │
│    - SELECT from Tenant                                    │
│    - Unwrap jwtSecret (AES-GCM) if JWT_SECRET_ENCRYPTION_   │
│      KEY is set; otherwise return as-is                    │
│                                                            │
│ 4. jwt.verify(token, jwtSecret, { algorithms: ["HS256"] })│
│    Fails → 401 Invalid user token                          │
│                                                            │
│ 5. Normalize claims.scope (trim; empty string → null)      │
│                                                            │
│ 6. upsertFederatedUser("tnt_abc123", {                     │
│      externalId: "alice_42",                               │
│      name: "Alice Chen",                                   │
│      image: "...",                                         │
│      email: "alice@acme.com",                              │
│      scope: null                                           │
│    })                                                      │
│    → Hot path: find by (tenantId, externalId) composite    │
│      unique. Nothing changed? Return cached row.           │
│    → First auth: `INSERT INTO user ... ON CONFLICT DO      │
│      UPDATE SET updatedAt = now()`. Race-safe via Postgres │
│      atomic upsert (two browser tabs booting concurrently  │
│      both succeed).                                        │
│                                                            │
│ 7. req.user      = { id: "uuid-a", name, email, image }    │
│    req.session   = { id: "jwt_uuid-a", userId, expiresAt } │
│    req.tenantId  = "tnt_abc123"                            │
│    req.scope     = null                                    │
└────────────────────────────────────────────────────────────┘
```

**The dual-identity** is central:

- **externalId** (`"alice_42"`) — Acme's id. Stable. Lives in the JWT `sub` claim. Stored as `User.externalId`. The `(tenantId, externalId)` pair is the unique key.
- **id** (`"uuid-a"`) — chat-server UUID. Stable after the very first auth. Used for `senderId`, Centrifugo channels (`user:uuid-a`), foreign keys, client-visible references.

Alice's frontend stores `"uuid-a"` — that's what shows up in every message, every event, every presence check.

The response from `/init` looks like:

```json
{
  "conversations": [
    {
      "id": "conv_1",
      "type": "group",
      "name": "design review",
      "createdBy": "uuid-c",
      "createdAt": "...",
      "updatedAt": "...",
      "version": 7,
      "members": [ /* each member with user { id, name, image, lastActiveAt } */ ],
      "unreadCount": 3,
      "muted": false,
      "lastMessage": { "id": "msg_42", "senderId": "uuid-b", "plainContent": "ship it", "createdAt": "..." }
    }
    /* ... up to 50 more */
  ],
  "nextCursor": "2026-04-23T10:15:00.000Z",
  "centrifugoToken": "eyJhbGc..."
}
```

`nextCursor` is the `updatedAt` of the last returned conversation. Pass it as `?before=` on the next `GET /conversations` call to paginate backwards.

---

## Stage 5 — Alice connects to Centrifugo

```
                                       WebSocket
Browser ───────────────────────────────────────────► wss://chat.technext.it/chat-api/centrifugo/connection/websocket
          token = centrifugoToken from /init

Centrifugo validates token, auto-subscribes Alice to:
  user:uuid-a   ← all her personal events arrive here
```

From here, every event Alice needs to know about (new message, someone typing, someone reacted, a peer's avatar changed) lands on `user:uuid-a`.

---

## Stage 6 — Alice sends "hi" to Bob

Alice types "hi" in the message box. Her client generates a `clientMessageId` up front so retries are safe:

```
POST /chat-api/conversations/conv_1/messages
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "content": {
    "type": "doc",
    "content": [{
      "type": "paragraph",
      "content": [{ "type": "text", "text": "hi" }]
    }]
  },
  "clientMessageId": "c_a8f9e1b2"
}
```

**What happens in one Postgres transaction** (inside `withRealtime`):

```
BEGIN;

-- 1. Membership + tenant + scope check (one row roundtrip)
SELECT 1 FROM conversation_members cm
  JOIN conversations c ON c.id = cm.conversation_id
  WHERE cm.conversation_id = 'conv_1'
    AND cm.user_id = 'uuid-a'
    AND c.tenant_id = 'tnt_abc123';
-- → missing? throw 403 Not a member

-- 2. Atomic sequence: row-locked increment
UPDATE conversations
  SET current_seq = current_seq + 1, updated_at = now()
  WHERE id = 'conv_1'
  RETURNING current_seq AS seq;
-- → seq = 42

-- 3. Idempotency check (iff clientMessageId provided)
SELECT id FROM messages
  WHERE conversation_id = 'conv_1' AND client_message_id = 'c_a8f9e1b2';
-- → already exists? return 200 with that row. Done.

-- 4. Validate + canonicalize mentions, rewrite labels to DB-canonical names,
--    strip mentions that aren't conversation members.

-- 5. Insert
INSERT INTO messages (
  id, tenant_id, conversation_id, sender_id, content, plain_content,
  type, seq, client_message_id, created_at
) VALUES (
  'msg_99', 'tnt_abc123', 'conv_1', 'uuid-a',
  '<tiptap json>', 'hi', 'text', 42, 'c_a8f9e1b2', now()
);

-- 6. Link attachments if any (UPDATE attachments SET message_id = 'msg_99'
--    WHERE id IN (...) AND uploader_id = 'uuid-a' AND message_id IS NULL)

-- 7. Bump unread counts for everyone except the sender
UPDATE conversation_members
  SET unread_count = unread_count + 1
  WHERE conversation_id = 'conv_1' AND user_id <> 'uuid-a';

-- 8. Touch sender's lastActiveAt
UPDATE "user" SET last_active_at = now() WHERE id = 'uuid-a';

-- 9. Enqueue a realtime event in the same tx (outbox pattern)
INSERT INTO chat_outbox (method, payload, partition) VALUES (
  'broadcast',
  '{"channels":["user:uuid-a","user:uuid-b"],"data":{...},"idempotency_key":"message_msg_99"}',
  0
);

COMMIT;
```

**HTTP response** (201 Created):

```json
{
  "id": "msg_99",
  "seq": 42,
  "senderId": "uuid-a",
  "content": { "type": "doc", "content": [...] },
  "plainContent": "hi",
  "type": "text",
  "clientMessageId": "c_a8f9e1b2",
  "replyTo": null,
  "attachments": [],
  "reactions": [],
  "createdAt": "...",
  "sender": { "id": "uuid-a", "name": "Alice Chen", "image": "..." }
}
```

**Realtime path** (post-commit):

```
┌─ chat_outbox drainer (running continuously) ──────────────┐
│  SELECT * FROM chat_outbox ORDER BY id LIMIT N;           │
│  For each row → POST to Centrifugo publish API.           │
│  DELETE on success.                                       │
└───────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─ Centrifugo v6 ─────────────────────────────────────────┐
│  Broadcasts to the listed channels.                     │
│  Dedup by idempotency_key in a 30s window.              │
└──────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─ Subscribers on user:uuid-a, user:uuid-b ───────────────┐
│  Alice's tab:                                           │
│    sees message_added                                   │
│    already has an optimistic bubble with matching       │
│    clientMessageId → replace-in-place with canonical    │
│    server row (id, seq, etc).                           │
│                                                          │
│  Bob's tab:                                             │
│    sees message_added                                   │
│    no optimistic bubble → render fresh                  │
│    bump sidebar unread badge                            │
│                                                          │
│  Bob's phone (if push registered):                      │
│    in parallel, a Web Push delivery is attempted        │
│    (only if Bob is not muted or Alice mentioned him).   │
│    Service worker suppresses if any Bob tab is visible. │
└──────────────────────────────────────────────────────────┘
```

**Total latency**: write → outbox drainer → Centrifugo publish → WebSocket frame → browser render. On a warm system, **~50–100 ms end-to-end**. The outbox pattern guarantees the event is delivered exactly-once with respect to the DB commit: if the process dies after `COMMIT` but before the Centrifugo POST, the next drainer iteration picks it up from the `chat_outbox` table.

**Optimistic UI** in the reference client:

1. User hits send. Client mints `clientMessageId`, inserts an optimistic bubble with `status: "sending"`.
2. HTTP POST fires.
3. On 201, replace optimistic bubble with the canonical server row (matching by `clientMessageId`).
4. On network failure, bubble stays `status: "failed"` with a retry button. Retry reuses the same `clientMessageId` — server dedup returns the stored row if the original commit actually succeeded.
5. When the Centrifugo `message_added` arrives (possibly before the HTTP response, since Centrifugo and HTTP race), dedup by either `id` (if the HTTP response landed first) or `clientMessageId` (if Centrifugo beat it). Either way, one bubble.

---

## Stage 7 — Bob replies

Bob types "hey." His tab does the same `POST …/messages`. Same server path. Same events. Alice's tab patches the new bubble in.

Typing indicators, reactions, read receipts, edits, deletes — all follow the same pattern:

```
  Client → POST /chat-api/<whatever>       ← write
  Server → Centrifugo broadcast            ← fan-out
  Every member's tab → receives event      ← incremental UI update
```

---

## Stage 8 — Alice renames herself on Acme's side

Alice opens Acme's profile page and changes her name from "Alice Chen" to "Alice Smith." Acme's backend saves it, **then** fires the webhook:

```
POST https://chat.technext.it/chat-api/webhooks/users.updated
Authorization: Bearer <apiKey>
X-Chat-Signature: sha256=<hmac(apiKey, body)>
Body: { externalId: "alice_42", name: "Alice Smith", image: "…" }
```

Chat server:
1. `requireApiKey` looks up tenant by `apiKeyPrefix` (indexed, O(1)), then `argon2.verify` the one match.
2. `requireWebhookSignature` recomputes the HMAC over the raw body, timing-safe compares.
3. Rate-limit buckets: 100/min per tenant, 10/min per `(tenant, externalId)`.
4. `applyTenantUserUpdate`: UPDATE User row, invalidate profile cache.
5. Broadcast `{ type: "user_updated", user: {…} }` to every peer who shares a conversation with Alice.

Bob's open tab sees the event and re-renders every cached "Alice Chen" label as "Alice Smith" — sidebar, header, every message bubble — in real time. No page refresh.

---

## Stage 9 — Alice deletes her Acme account

Acme's backend fires:

```
POST https://chat.technext.it/chat-api/webhooks/users.deleted
Body: { externalId: "alice_42" }
```

Chat server cascade-deletes the User row. Postgres FKs wipe: conversation memberships, messages she sent (soft-delete — content is zeroed), reactions, attachments, push subscriptions. S3 objects get GC'd asynchronously by the orphan attachment sweep.

Acme doesn't have to care about any of that.

---

## Stage 10 — Alice's token expires mid-session

Alice has been chatting for an hour. Her JWT's `exp` is now in the past. The very next API call returns:

```
HTTP/1.1 401 Unauthorized
Content-Type: application/json

{ "error": { "code": "UNAUTHORIZED", "message": "Invalid user token" } }
```

The reference client handles this transparently:

```
┌──────── Browser ─────────────────────┐
│                                      │
│ 1. POST /chat-api/conversations/.../ │
│    messages   →  401                 │
│                                      │
│ 2. GET acme.com/api/chat-token  ──┐  │
│                                   │  │
└───────────────────────────────────┼──┘
                                    ▼
                ┌─ Acme Backend ─────────────┐
                │  Alice is still logged in  │
                │  to Acme → mint new JWT    │
                │  return { token }          │
                └────────────────────────────┘
                                    │
┌──────── Browser ──────────────────┼──┐
│                                   │  │
│ 3. Replace chatToken in memory  ◀─┘  │
│ 4. Retry POST /messages  → 201       │
│                                      │
└──────────────────────────────────────┘
```

Proactive refresh: the client decodes `exp` and refetches when it has ~5 minutes left, so Alice rarely hits the 401 path in practice.

**Centrifugo connection token** expires on its own schedule (separate from the user JWT). The `getToken` callback wired into the `Centrifuge` constructor handles this — when Centrifugo asks, the client refetches `/chat-api/init` and returns the new `centrifugoToken`. The WebSocket stays up across the swap.

**JWT secret rotation by the operator** (admin `POST /tenants/:id/jwt-secret/rotate`): every live token invalidates simultaneously. Every browser sees a 401 on its next call, refetches `/chat-token` from Acme, gets a fresh one signed with the new secret, and recovers within seconds. No user-visible logout.

---

## Stage 11 — Alice closes her laptop; Bob keeps writing

Alice's tab is closed. Bob types "meeting at 3?" and hits send. The chat server still broadcasts `message_added` to `user:uuid-a` — there's no one connected to receive it.

Two fallbacks kick in:

**(a) Web Push** (if Alice registered earlier via `/chat-api/push/subscribe`):

```
┌─ Chat Server ─────────────────────────────────────────┐
│  Post-message hook: fan out to non-muted, non-sender │
│  members who have a PushSubscription row.            │
│                                                       │
│  For Alice: POST to her push endpoint with payload   │
│    { title: "Bob", body: "meeting at 3?",            │
│      tag: "conv:<id>", url: "/" }                    │
└───────────────────────────────────────────────────────┘
                         │
                         ▼
┌─ Push service (FCM/APNs/Mozilla) ────────────────────┐
│  Delivers to Alice's device even if the tab is       │
│  closed.                                              │
└──────────────────────────────────────────────────────┘
                         │
                         ▼
┌─ Alice's device service worker ─────────────────────┐
│  Wakes up, shows a system notification. If any of    │
│  Alice's tabs are visible, suppresses (so active     │
│  users don't get double-pinged).                     │
└──────────────────────────────────────────────────────┘
```

**(b) Replay on reconnect**: Alice reopens her laptop. The browser restores the tab. The chat client:

1. Refetches `/chat-api/init` → fresh conversation list + `centrifugoToken`. Unread counts + `lastMessage.seq` reveal that Bob's message exists.
2. Reconnects to Centrifugo. For short disconnects (<30s), Centrifugo replays missed publications from its ring buffer. For longer ones, `/init` is the source of truth.
3. The client reconciles: anything the server says is newer than the local `seq` high-water gets fetched via `GET /conversations/:id/messages`.

The `clientMessageId` guarantees no duplicates — even if Centrifugo and HTTP both deliver the same message (during the overlap window), the client dedups by `id`.

---

## Stage 12 — Alice has two tabs open

Tab A and Tab B are both logged in as Alice. Each holds its own `chatToken` (same JWT, copied from `/chat-token`), each has its own Centrifugo connection, each subscribes to `user:uuid-a`.

Centrifugo treats them as two clients of the same user. Every `message_added` / `message_edited` / etc. is delivered to both — the server doesn't care; it publishes once to the channel, Centrifugo fans out to every connected subscriber.

Where this matters:

- **Mute state**: Alice mutes a conversation in Tab A. Server broadcasts `conversation_mute_changed` on `user:uuid-a`. Tab B receives it and updates its UI. Multi-tab sync, for free.
- **Read markers**: Alice reads a message in Tab A → `POST /read`. The `read_receipt` is broadcast to every other member (not to Alice's own channel — the server excludes the sender), so Tab B doesn't auto-advance Alice's read marker. That's intentional: each tab has its own scroll position and can show its own unread indicator until the user actually looks at them.
- **Typing**: Alice types in Tab A. Server broadcasts `typing_started` to other members. Tab B doesn't see it — Alice's own channel is excluded. If you want Tab B to know, add client-side same-user echo; the server won't.

Presence on `presence:conv_<id>` reports each client separately. So if Alice has two tabs in a conversation, the presence member list shows her once (Centrifugo dedupes by `user:`, not by client), but she registers as "online" across both.

---

## Stage 13 — Alice moves from Project A to Project B

Alice's role changes on Acme's side — she's reassigned from `project_a` to `project_b`. Acme's backend updates its own DB. Next time Alice refreshes her chat token:

```ts
// Acme backend /api/chat-token
const token = mintChatToken(alice.id, alice.name, {
  scope: "project_b",  // was "project_a" an hour ago
});
```

Her next chat-server request ships this new JWT. `requireUserJwt`:

1. Verifies the JWT.
2. `upsertFederatedUser` sees `claims.scope = "project_b"` and the stored `User.scope = "project_a"` — they differ.
3. UPDATE `User SET scope = 'project_b' WHERE id = 'uuid-a'`.
4. Cache invalidated.

What this means for Alice's view:

- **Existing conversations stay.** She's still a member of every conversation she was a member of. Project A's conversation she was in? Still in her sidebar. Centrifugo subscriptions unchanged.
- **Future user searches are re-scoped.** She can now find Project B users, no longer sees most Project A users (unless they were tenant-wide admins — those she still sees).
- **Future add-member calls** can only pull in Project B peers.

If Acme wants to strip Alice from Project A conversations at the same time, they'd call `DELETE /conversations/:id/members/uuid-a` for each — orthogonal to the scope change.

If Alice needs to see **both projects** at once (she joins both teams), Acme has two options:

1. Mint her with `scope: null` (tenant-wide). She sees every user Acme has.
2. Keep `scope` as a single string but give Alice different `externalId`s per project (`alice@acme.com__proj_a`, `alice@acme.com__proj_b`) — the server treats them as separate users with separate internal UUIDs. The downside is two sidebars with no cross-visibility.

Most integrations pick option 1 for admins/PMs and option 2 for strict-tenancy scenarios like deal rooms.

---

## The mental model

```
Acme owns identity.   Chat server owns conversations.
       │                        │
       └────── JWT bridge ──────┘
       └────── Webhooks ────────┘  (only for propagating changes)
```

Acme's user id is a **claim** (`externalId`). The chat server stores a row keyed `(tenantId, externalId)`, mints an internal UUID for its own FK graph, and looks up / creates that row on every authenticated request (cheap because it's a no-op when nothing changed).

**No user sync job, no shadow auth system, no "who's the source of truth" debate.** Acme's backend is always the source of truth. The chat server's User row is a materialized view of the current JWT claims.

---

## What's different for multiple tenants

Say BetaCorp signs up too. They get their own `tnt_def456` / `apiKey` / `jwtSecret`. Their users have their own UUIDs. Every query is scoped by `tenantId` at the Prisma layer — BetaCorp users can't find, message, or even see that Acme users exist. One Postgres instance, one chat server, one Centrifugo — fully isolated.

---

## What if Acme itself hosts many isolated chats?

Common B2B2C pattern: Acme's platform hosts **projects**, **support tickets**, **deal rooms**, or **per-client CRM spaces**, and users in one context shouldn't discover users from another — even though they all live under the same Acme tenant.

The primitive is an optional `scope` claim on the JWT. Acme stamps it at mint time:

```ts
// Alice belongs to project 42; Bob belongs to project 99.
mintChatToken(alice.id, alice.name, { scope: "project_42" });
mintChatToken(bob.id,   bob.name,   { scope: "project_99" });

// Priya is a project manager who should see both.
mintChatToken(priya.id, priya.name, { /* no scope — tenant-wide */ });
```

What the server enforces:

- Alice searching `/users/search` sees only **project_42 users + tenant-wide users** (so she finds Priya but not Bob).
- Bob searching sees only **project_99 users + tenant-wide users**.
- Priya (unscoped) sees everyone — Acme admin-style.
- Alice cannot add Bob to a conversation even if she somehow knows his internal UUID; `POST /conversations/:id/members` rejects him with `400`.

**Conversations themselves aren't scope-filtered** — membership is still the security boundary. Once Alice and Priya are both members of a conversation, they chat normally. Scope only controls **who can discover whom**, not **what a member can do once they're in**.

**Changing scope over time:** Alice's next JWT carrying `scope: "project_99"` re-scopes her User row on next auth. Acme handles this by re-minting when assignments change. Omitting the `scope` claim (vs. setting it to `null`) leaves the stored value alone — useful when a webhook doesn't know the scope.

```
tenant isolation    — enforced by tenantId in every query
scope isolation     — enforced by User.scope on user discovery + add-member
conversation access — enforced by ConversationMember membership
```

Three layers, independent, composable. Each added one at a time for incrementally stricter isolation.

---

## Where to go next

- [INTEGRATION.md](./INTEGRATION.md) — endpoint reference, code samples in Node / Python / Go, troubleshooting.
- `/chat-api/docs` — interactive OpenAPI playground against the live server.
- [prisma/schema.prisma](./prisma/schema.prisma) — Tenant + User + Conversation data model.
- [src/middleware/require-user-jwt.ts](./src/middleware/require-user-jwt.ts) — the JWT verification chain, line by line.
