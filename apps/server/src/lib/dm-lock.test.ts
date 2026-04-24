import { describe, it, expect, vi } from "vitest";
import type { Prisma } from "../generated/prisma/client";
import { acquireDmLock } from "./dm-lock";

/**
 * `acquireDmLock` is the race guard for concurrent direct-chat creates.
 * Integration behavior (actual serialization) needs a live Postgres, so
 * these are contract tests:
 *   1. The advisory-lock SQL is what lands on the wire.
 *   2. The lock key encodes tenantId + BOTH users.
 *   3. The key is order-invariant — (A, B) and (B, A) hash to the same
 *      slot, otherwise no dedup would catch the reverse-order race.
 *
 * Each test uses a fresh mock so call state doesn't leak.
 */

function makeTx() {
  const $queryRaw = vi.fn().mockResolvedValue([]);
  const tx = { $queryRaw } as unknown as Prisma.TransactionClient;
  return { tx, $queryRaw };
}

describe("acquireDmLock", () => {
  it("calls $queryRaw with a pg_advisory_xact_lock over hashtextextended", async () => {
    const { tx, $queryRaw } = makeTx();
    await acquireDmLock(tx, "T1", "u1", "u2");
    expect($queryRaw).toHaveBeenCalledOnce();
    // Prisma $queryRaw is a tagged template: mock.calls[0] ==
    //   [templateStrings, ...interpolatedValues]
    const [strings] = $queryRaw.mock.calls[0];
    const sql = (strings as TemplateStringsArray).join("?");
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("hashtextextended");
  });

  it("encodes tenantId + sorted user pair in the key", async () => {
    const { tx, $queryRaw } = makeTx();
    await acquireDmLock(tx, "tenant-abc", "userZ", "userA");
    const [, keyValue] = $queryRaw.mock.calls[0];
    expect(keyValue).toBe("dm:tenant-abc:userA:userZ");
  });

  it("is order-invariant for the same pair", async () => {
    const a = makeTx();
    await acquireDmLock(a.tx, "T", "alice", "bob");
    const b = makeTx();
    await acquireDmLock(b.tx, "T", "bob", "alice");
    expect(a.$queryRaw.mock.calls[0][1]).toBe(b.$queryRaw.mock.calls[0][1]);
  });

  it("produces distinct keys across tenants for the same pair", async () => {
    const a = makeTx();
    await acquireDmLock(a.tx, "tenant-1", "u1", "u2");
    const b = makeTx();
    await acquireDmLock(b.tx, "tenant-2", "u1", "u2");
    expect(a.$queryRaw.mock.calls[0][1]).not.toBe(
      b.$queryRaw.mock.calls[0][1],
    );
  });
});
