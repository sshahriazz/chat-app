/**
 * Cross-tenant + cross-scope isolation suite (integration).
 *
 * This is the single most important security property of a multi-tenant
 * system: a token issued for tenant/scope A must NEVER be able to read,
 * list, or mutate tenant/scope B's data. App-layer `WHERE tenant_id = ?`
 * filtering enforces it today; this suite proves it and guards against
 * regressions (and is the safety net for adding Postgres RLS underneath).
 *
 * It drives a REAL, fully-wired server over HTTP (not a stubbed app), so
 * it exercises the deployed artifact end-to-end. It needs the dev stack
 * running (Postgres + Redis + server) with dev routes enabled:
 *
 *   make dev            # brings up the stack on http://localhost:3001
 *   pnpm --filter @chat-app/server test tenant-isolation
 *
 * When the server is unreachable the whole suite SKIPS (so plain `pnpm
 * test` in CI without a stack stays green); wire a stack in CI to make it
 * run. Override the target with TEST_SERVER_URL.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll } from "vitest";

const SERVER = process.env.TEST_SERVER_URL ?? "http://localhost:3001";

/**
 * Dev-route credential.
 *
 * `/api/dev/*` is master-key gated whenever `MASTER_API_KEY` is set (see
 * routes/dev.ts). The local stack loads one from the repo-root `.env`, but
 * vitest runs on the host and does not read that file — so every dev-route
 * call 401'd and the whole suite failed at `beforeAll` with a bare
 * "mint failed: 401". Read the key the same way the stack does, so
 * `make dev && pnpm test tenant-isolation` works with no extra step.
 *
 * An explicit `MASTER_API_KEY` in the environment wins, so CI can inject it
 * without a file.
 */
function readMasterKey(): string | undefined {
  if (process.env.MASTER_API_KEY) return process.env.MASTER_API_KEY;
  try {
    const here = path.dirname(new URL(import.meta.url).pathname);
    const envFile = readFileSync(path.resolve(here, "../../../.env"), "utf8");
    const match = envFile.match(/^\s*MASTER_API_KEY\s*=\s*(.*)$/m);
    const value = match?.[1]?.trim().replace(/^["']|["']$/g, "");
    return value || undefined;
  } catch {
    return undefined;
  }
}

const MASTER_KEY = readMasterKey();

/** Headers for `/api/dev/*`. Empty when the gate is not configured. */
const devHeaders: Record<string, string> = MASTER_KEY
  ? { Authorization: `Bearer ${MASTER_KEY}` }
  : {};

// Reachability probe at collection time -> skip cleanly if no stack.
const reachable = await fetch(`${SERVER}/api/livez`)
  .then((r) => r.ok)
  .catch(() => false);

// Demo identities seeded by POST /api/dev/seed-demo (lib/demo-personas.ts).
const ACME = "demo_acme";
const BETA = "demo_beta";
const PERSONAS = {
  eli: { tenant: ACME, externalId: "eli@acme", name: "Eli Osei", scope: null }, // tenant-wide
  bob: { tenant: ACME, externalId: "bob@acme", name: "Bob Park", scope: "project_alpha" },
  alice: { tenant: ACME, externalId: "alice@acme", name: "Alice Chen", scope: "project_alpha" },
  carlos: { tenant: ACME, externalId: "carlos@acme", name: "Carlos Ruiz", scope: "project_beta" },
  greta: { tenant: BETA, externalId: "greta@beta", name: "Greta Larsen", scope: null }, // beta tenant-wide
} as const;

type Persona = (typeof PERSONAS)[keyof typeof PERSONAS];

async function mint(p: Persona): Promise<string> {
  const res = await fetch(`${SERVER}/api/dev/mint-token`, {
    method: "POST",
    headers: { "content-type": "application/json", ...devHeaders },
    body: JSON.stringify({
      tenantId: p.tenant,
      externalId: p.externalId,
      name: p.name,
      scope: p.scope,
      ttlSeconds: 3600,
    }),
  });
  if (!res.ok) throw new Error(`mint ${p.externalId} failed: ${res.status}`);
  return (await res.json()).token as string;
}

function api(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${SERVER}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

/** Materialize a persona's User row (federated upsert on first auth) so
 *  they become discoverable by search + usable as conversation members. */
async function activate(token: string): Promise<void> {
  const res = await api(token, "GET", "/api/init");
  if (!res.ok) throw new Error(`activate failed: ${res.status}`);
}

async function searchUsers(token: string, q: string): Promise<Array<{ id: string; name: string }>> {
  const res = await api(token, "GET", `/api/users/search?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error(`search failed: ${res.status}`);
  return res.json();
}

const tokens: Record<string, string> = {};

const d = reachable ? describe : describe.skip;
if (!reachable) {
  // eslint-disable-next-line no-console
  console.warn(`[tenant-isolation] ${SERVER} unreachable — skipping. Run \`make dev\` to enable.`);
}

d("cross-tenant / cross-scope isolation", () => {
  beforeAll(async () => {
    // Seed the demo tenants, then mint + activate every persona used below.
    const seeded = await fetch(`${SERVER}/api/dev/seed-demo`, {
      method: "POST",
      headers: devHeaders,
    });
    // Fail loudly and specifically: a 401 here means MASTER_API_KEY is set
    // on the server but not readable by the test, which is a setup problem,
    // not an isolation failure.
    if (!seeded.ok) {
      throw new Error(
        `seed-demo failed: ${seeded.status}` +
          (seeded.status === 401
            ? " — /api/dev is master-key gated. Export MASTER_API_KEY or keep it in the repo-root .env."
            : ""),
      );
    }
    for (const [key, p] of Object.entries(PERSONAS)) {
      tokens[key] = await mint(p);
      await activate(tokens[key]);
    }
  });

  it("requires authentication (no token -> 401)", async () => {
    const res = await fetch(`${SERVER}/api/conversations`);
    expect(res.status).toBe(401);
  });

  it("user search is tenant-scoped: Acme user cannot find a BetaCorp user", async () => {
    const results = await searchUsers(tokens.eli, "Greta");
    expect(results.some((u) => u.name === "Greta Larsen")).toBe(false);
  });

  it("user search is tenant-scoped: BetaCorp user cannot find an Acme user", async () => {
    const results = await searchUsers(tokens.greta, "Eli");
    expect(results.some((u) => u.name === "Eli Osei")).toBe(false);
  });

  it("scope isolation: a project_alpha user cannot discover a project_beta user", async () => {
    // Alice (project_alpha) must NOT see Carlos (project_beta)...
    const carlos = await searchUsers(tokens.alice, "Carlos");
    expect(carlos.some((u) => u.name === "Carlos Ruiz")).toBe(false);
    // ...but MUST see a same-scope peer (Bob) and the tenant-wide admin (Eli).
    const bob = await searchUsers(tokens.alice, "Bob");
    expect(bob.some((u) => u.name === "Bob Park")).toBe(true);
    const eli = await searchUsers(tokens.alice, "Eli");
    expect(eli.some((u) => u.name === "Eli Osei")).toBe(true);
  });

  it("cross-tenant object access: BetaCorp cannot read/list/mutate an Acme conversation", async () => {
    // Eli (Acme, tenant-wide) creates a group conversation with Bob.
    const [bob] = await searchUsers(tokens.eli, "Bob");
    expect(bob?.name).toBe("Bob Park");
    const created = await api(tokens.eli, "POST", "/api/conversations", {
      type: "group",
      name: "acme-isolation-probe",
      memberIds: [bob.id],
    });
    expect(created.ok).toBe(true);
    const convId = (await created.json()).id as string;
    expect(convId).toBeTruthy();

    // Sanity: Eli (owner) CAN read it.
    expect((await api(tokens.eli, "GET", `/api/conversations/${convId}`)).status).toBe(200);

    // Greta (BetaCorp) must be denied on every access path -> 403/404,
    // and must never receive the conversation payload.
    const get = await api(tokens.greta, "GET", `/api/conversations/${convId}`);
    expect([403, 404]).toContain(get.status);

    const msgs = await api(tokens.greta, "GET", `/api/conversations/${convId}/messages`);
    expect([403, 404]).toContain(msgs.status);

    const send = await api(tokens.greta, "POST", `/api/conversations/${convId}/messages`, {
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "intrusion" }] }] },
    });
    expect([403, 404]).toContain(send.status);

    // Conversation-list isolation: it must not appear in Greta's list.
    const list = await api(tokens.greta, "GET", "/api/conversations");
    const listed = (await list.json()) as Array<{ id: string }>;
    expect(Array.isArray(listed) ? listed.some((c) => c.id === convId) : false).toBe(false);
  });

  it("scope isolation on conversations: a project_beta user cannot read a project_alpha conversation", async () => {
    // Alice + Bob are both project_alpha; Carlos is project_beta.
    const [bob] = await searchUsers(tokens.alice, "Bob");
    const created = await api(tokens.alice, "POST", "/api/conversations", {
      type: "group",
      name: "alpha-only-probe",
      memberIds: [bob.id],
    });
    expect(created.ok).toBe(true);
    const convId = (await created.json()).id as string;

    // Carlos (project_beta, same tenant) must still be denied.
    const get = await api(tokens.carlos, "GET", `/api/conversations/${convId}`);
    expect([403, 404]).toContain(get.status);
  });

  /**
   * History fence (H-5).
   *
   * A member added to an existing conversation must not be able to read what
   * was said before they joined. `GET /conversations/:id/messages` fences on
   * `member.joinedAt` and was the ONLY path that did — both search endpoints
   * checked membership and nothing else, so search returned the fenced
   * content verbatim, with sender and timestamp. That made the fence on
   * /messages decorative.
   *
   * This asserts all three read paths agree, and that the fence is not
   * over-broad: a message sent AFTER the join must still be visible.
   */
  it("history fence: a late-added member cannot read pre-join messages via messages OR search", async () => {
    const BEFORE = "fencecanary-before-join-xyzzy";
    const AFTER = "fencecanary-after-join-plugh";

    // Eli (tenant-wide) starts a conversation with Alice only.
    const [alice] = await searchUsers(tokens.eli, "Alice");
    expect(alice?.name).toBe("Alice Chen");
    const created = await api(tokens.eli, "POST", "/api/conversations", {
      type: "group",
      name: "history-fence-probe",
      memberIds: [alice.id],
    });
    expect(created.ok).toBe(true);
    const convId = (await created.json()).id as string;

    // Something secret is said while Bob is NOT a member.
    const said = await api(tokens.eli, "POST", `/api/conversations/${convId}/messages`, {
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: BEFORE }] }],
      },
    });
    expect(said.ok).toBe(true);

    // Bob (same scope as Alice, so addable) joins afterwards.
    const [bob] = await searchUsers(tokens.eli, "Bob");
    const added = await api(tokens.eli, "POST", `/api/conversations/${convId}/members`, {
      userIds: [bob.id],
    });
    expect(added.ok).toBe(true);

    // ...and something else is said now that he IS a member.
    const said2 = await api(tokens.eli, "POST", `/api/conversations/${convId}/messages`, {
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: AFTER }] }],
      },
    });
    expect(said2.ok).toBe(true);

    const bodyOf = async (res: Response) => JSON.stringify(await res.json());

    // 1. Paginated read — already fenced before this change.
    const msgs = await api(tokens.bob, "GET", `/api/conversations/${convId}/messages`);
    expect(msgs.status).toBe(200);
    const msgBody = await bodyOf(msgs);
    expect(msgBody).not.toContain(BEFORE);
    expect(msgBody).toContain(AFTER);

    // 2. In-conversation search — leaked BEFORE this change.
    const inConv = await api(
      tokens.bob,
      "GET",
      `/api/conversations/${convId}/search?q=${encodeURIComponent("fencecanary")}`,
    );
    expect(inConv.status).toBe(200);
    const inConvBody = await bodyOf(inConv);
    expect(inConvBody).not.toContain(BEFORE);
    expect(inConvBody).toContain(AFTER);

    // 3. Global search — leaked BEFORE this change, across every
    //    conversation the searcher had ever been added to.
    const global = await api(
      tokens.bob,
      "GET",
      `/api/search?q=${encodeURIComponent("fencecanary")}`,
    );
    expect(global.status).toBe(200);
    const globalBody = await bodyOf(global);
    expect(globalBody).not.toContain(BEFORE);
    expect(globalBody).toContain(AFTER);

    // Sanity: the message really is there — Eli, a member since creation,
    // must still see it. Otherwise the assertions above would pass against
    // a conversation where nothing was ever written.
    const eliSees = await bodyOf(
      await api(tokens.eli, "GET", `/api/conversations/${convId}/messages`),
    );
    expect(eliSees).toContain(BEFORE);
  });
});
