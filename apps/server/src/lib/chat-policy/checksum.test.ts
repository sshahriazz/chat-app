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
  "8ccf26ed9917fd00064a987b82d722811ef4f96e1070b7d70cea5efca3aa7a1b";

describe("vendored chat policy", () => {
  it("matches the canonical copy", () => {
    const hash = createHash("sha256");
    for (const file of CANONICAL_FILES) {
      hash.update(readFileSync(join(__dirname, file), "utf8"));
    }
    expect(hash.digest("hex")).toBe(POLICY_CHECKSUM);
  });
});
