# End-to-End Flow: How a Third-Party Service Uses This Chat Backend

A worked scenario — **Acme Inc. adds chat to their SaaS** — so you can see every actor and every hop without wading through route code.

For the reference API + code samples, see [INTEGRATION.md](./INTEGRATION.md).
This doc is the narrative companion: **how it works**, not **how to call it**.

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
GET /chat-api/me              → { id: "uuid-a", name: "Alice Chen", email: … }
GET /chat-api/init            → { conversations: […], centrifugoToken: "…" }
```

**What happens server-side on the first `/me` call:**

```
requireUserJwt middleware:
  1. Extract Bearer token
  2. Decode iss (unverified) → "tnt_abc123"
  3. Look up Tenant("tnt_abc123") → get jwtSecret from DB
     (unwrap via JWT_SECRET_ENCRYPTION_KEY if at-rest encryption is on)
  4. Verify JWT signature + expiry with jwtSecret
  5. upsertFederatedUser(tenantId, claims):
       - Is there a User row where (tenantId, externalId) = ("tnt_abc123", "alice_42")?
       - No → INSERT row with a fresh UUID (id = "uuid-a")
       - Yes → skip the write if name/image/email unchanged
  6. req.user.id = "uuid-a"
```

**The dual-identity** is key:
- **externalId** (`"alice_42"`) — Acme's id, stable, in the JWT.
- **id** (`"uuid-a"`) — chat server's internal UUID, stable, used for `senderId`, Centrifugo channels, FK references.

Alice's frontend stores `"uuid-a"` — that's what it uses to identify "me" in message lists.

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

Alice types "hi" in the message box.

```
POST /chat-api/conversations/<id>/messages
Authorization: Bearer <jwt>
Body: { content: <tiptap-json>, clientMessageId: "c_xyz" }
```

Server-side in one DB transaction:

```
1. Verify Alice is a member of the conversation (and the conversation
   belongs to tenant tnt_abc123 — post-tenancy-audit filter).
2. INCR conversation.currentSeq → seq = 42
3. INSERT message { tenantId, conversationId, senderId="uuid-a", content,
                    seq: 42, clientMessageId: "c_xyz" }
4. UPDATE conversationMember unreadCount += 1 for every non-sender
5. INSERT outbox { method: "broadcast",
                   payload: { channels: [user:uuid-a, user:uuid-b], data: {…} }}
6. COMMIT
```

Then the outbox drainer forwards to Centrifugo. Centrifugo fans out over WebSocket:

```
  Alice's tab:  sees message_added on user:uuid-a  → renders her own bubble
  Bob's tab:    sees message_added on user:uuid-b  → renders new message + sidebar badge
  Bob's phone:  same event (same user channel)     → native push too, via /api/push
```

Total latency: DB write → outbox → Centrifugo → WS → browsers. Typically < 100ms.

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
