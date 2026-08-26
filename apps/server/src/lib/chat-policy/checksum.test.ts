import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * This directory is vendored from `app.onesuite.io/services/chat/policy`.
 *
 * A red test here means this copy is stale — the rules changed upstream and
 * were not propagated. It never means the canonical copy is wrong.
 *
 * Re-vendor with `scripts/vendor-chat-policy.sh` in the app repo.
 */
const CANONICAL_FILES = ["types.ts", "capabilities.ts", "can.ts"] as const;

const POLICY_CHECKSUM =
  "c34de991e2a1de5b259f652702e11bfc175360e983fc9a940f1ecf01b6c90191";

describe("vendored chat policy", () => {
  it("matches the canonical copy", () => {
    const hash = createHash("sha256");
    for (const file of CANONICAL_FILES) {
      hash.update(readFileSync(join(__dirname, file), "utf8"));
    }
    expect(hash.digest("hex")).toBe(POLICY_CHECKSUM);
  });
});
