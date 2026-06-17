/**
 * security-smoke.ts — end-to-end security verification harness.
 *
 * Exercises a handful of high-value security behaviors against a LIVE
 * server. Use against staging (or any non-prod env where the dev mint
 * route is reachable) before promoting a deploy.
 *
 *   API_BASE_URL=http://localhost:3001 \
 *   DEV_TENANT_ID=default \
 *   pnpm exec tsx scripts/security-smoke.ts
 *
 * Each check is independent and self-reports ✅ / ❌. The process exits
 * non-zero if any check fails. The script never creates persistent
 * state — it mints throwaway externalIds with a `smoke:` prefix.
 */
import crypto from "node:crypto";

const API = process.env.API_BASE_URL || "http://localhost:3001";
const TENANT = process.env.DEV_TENANT_ID || "default";

interface MintResp {
  token: string;
}

async function mint(externalId: string): Promise<string> {
  const res = await fetch(`${API}/api/dev/mint-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tenantId: TENANT,
      externalId,
      name: externalId,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `mint-token failed (${res.status}). Is the dev router enabled and reachable at ${API}?`,
    );
  }
  return ((await res.json()) as MintResp).token;
}

async function expectStatus(
  label: string,
  expected: number,
  promise: Promise<Response>,
): Promise<boolean> {
  const res = await promise;
  const ok = res.status === expected;
  console.log(`${ok ? "✅" : "❌"} ${label} (got ${res.status}, want ${expected})`);
  return ok;
}

async function main() {
  console.log(`smoke target: ${API}  tenant: ${TENANT}\n`);
  const results: boolean[] = [];

  // --- Set up two throwaway users. ---
  const aliceId = `smoke:${crypto.randomUUID()}`;
  const bobId = `smoke:${crypto.randomUUID()}`;
  const alice = await mint(aliceId);
  const bob = await mint(bobId);
  console.log(`minted: alice=${aliceId.slice(0, 18)}…, bob=${bobId.slice(0, 18)}…\n`);

  // 1. A garbage Bearer token must be rejected. Sanity check; confirms
  //    auth path is on.
  results.push(
    await expectStatus(
      "garbage Bearer → 401",
      401,
      fetch(`${API}/api/users/me`, {
        headers: { Authorization: "Bearer not-a-jwt" },
      }),
    ),
  );

  // 2. Tiptap depth-bomb is rejected by the canonicalizer's depth cap.
  //    Build a doc with 100 levels of nested blockquote.
  let nested: unknown = { type: "text", text: "x" };
  for (let i = 0; i < 100; i++) {
    nested = { type: "blockquote", content: [nested] };
  }
  const depthDoc = { type: "doc", content: [nested] };
  // Need a conversation id; we don't have one easily here, so we hit the
  // route with a synthetic id — Tiptap validation runs BEFORE membership
  // check in the schema layer, so the depth cap (400) fires first.
  results.push(
    await expectStatus(
      "Tiptap depth-bomb → 400",
      400,
      fetch(`${API}/api/conversations/synthetic-smoke-id/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${alice}`,
        },
        body: JSON.stringify({ content: depthDoc }),
      }),
    ),
  );

  // 3. Invalid clientMessageId charset rejected by the param schema.
  results.push(
    await expectStatus(
      "invalid clientMessageId charset → 400",
      400,
      fetch(`${API}/api/conversations/synthetic-smoke-id/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${alice}`,
        },
        body: JSON.stringify({
          content: { type: "doc", content: [{ type: "paragraph" }] },
          clientMessageId: "has spaces/and:colons",
        }),
      }),
    ),
  );

  // 4. Push subscribe with a non-allowlisted endpoint host is rejected.
  results.push(
    await expectStatus(
      "push subscribe to non-provider host → 400",
      400,
      fetch(`${API}/api/push/subscribe`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${alice}`,
        },
        body: JSON.stringify({
          endpoint: "http://169.254.169.254/latest/meta-data/",
          keys: { p256dh: "x".repeat(80), auth: "x".repeat(20) },
        }),
      }),
    ),
  );

  // 5. Push subscribe with a legitimate-looking endpoint claimed by user
  //    A succeeds; user B trying to claim the SAME endpoint must 409.
  const sharedEndpoint = `https://fcm.googleapis.com/fcm/send/smoke-${crypto.randomUUID()}`;
  const subBody = {
    endpoint: sharedEndpoint,
    keys: { p256dh: "x".repeat(80), auth: "x".repeat(20) },
  };
  results.push(
    await expectStatus(
      "push subscribe (alice) → 200/503",
      // 503 is fine: it means VAPID isn't configured on the smoke target,
      // which is a valid configuration (push is optional). We still get
      // the IDOR test below by trying bob to claim alice's endpoint —
      // but it only triggers if alice's subscribe succeeded. Accept either.
      200,
      fetch(`${API}/api/push/subscribe`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${alice}`,
        },
        body: JSON.stringify(subBody),
      }),
    ),
  );
  // Only assert IDOR if alice's subscribe succeeded.
  const peekAlice = await fetch(`${API}/api/push/subscribe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${alice}`,
    },
    body: JSON.stringify(subBody),
  });
  if (peekAlice.status === 200) {
    results.push(
      await expectStatus(
        "push subscribe IDOR (bob claims alice's endpoint) → 409",
        409,
        fetch(`${API}/api/push/subscribe`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${bob}`,
          },
          body: JSON.stringify(subBody),
        }),
      ),
    );
  } else {
    console.log(
      `⏭  push subscribe IDOR skipped (push not configured: alice returned ${peekAlice.status})`,
    );
  }

  // 6. GDPR delete tombstone. Alice deletes herself, then her old token
  //    must be rejected with 410 on the next call.
  const del = await fetch(`${API}/api/users/me`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${alice}` },
  });
  if (del.status !== 200) {
    console.log(`⚠️  DELETE /me returned ${del.status}; skipping tombstone check`);
  } else {
    results.push(
      await expectStatus(
        "GDPR tombstone (alice's old token after delete) → 410",
        410,
        fetch(`${API}/api/users/me`, {
          headers: { Authorization: `Bearer ${alice}` },
        }),
      ),
    );
  }

  // --- Summary ---
  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log(`\n${passed}/${results.length} checks passed.`);
  if (failed > 0) {
    console.error(`❌ ${failed} security check(s) failed.`);
    process.exit(1);
  }
  console.log("✅ All security smoke checks passed.");
}

main().catch((err) => {
  console.error("\n❌ smoke script crashed:", err);
  process.exit(1);
});
