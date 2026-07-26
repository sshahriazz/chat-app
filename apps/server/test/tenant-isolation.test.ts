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
import { describe, it, expect, beforeAll } from "vitest";

const SERVER = process.env.TEST_SERVER_URL ?? "http://localhost:3001";

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
    headers: { "content-type": "application/json" },
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
    await fetch(`${SERVER}/api/dev/seed-demo`, { method: "POST" });
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
});
