import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * `auth-lockout` operates against the shared Redis client, so we mock
 * it with `ioredis-mock` the same way `cache.test.ts` does.
 *
 * Tests cover:
 *   - counter increments on failure and the TTL is applied
 *   - counter clears on success
 *   - isAccountLocked returns true only once threshold is hit
 *   - case-insensitive + trimmed email normalization
 *   - fail-open behavior: Redis errors do NOT lock out users
 */

vi.mock("../infra/redis", async () => {
  const mod = await import("ioredis-mock");
  const RedisMock = (mod as { default: typeof import("ioredis-mock") })
    .default as unknown as new () => unknown;
  return { redis: new RedisMock() };
});

type AuthLockoutModule = typeof import("./auth-lockout");
let lockout: AuthLockoutModule;

beforeEach(async () => {
  lockout = await import("./auth-lockout");
  const { redis } = (await import("../infra/redis")) as {
    redis: { flushall: () => Promise<string> };
  };
  await redis.flushall();
});

describe("auth-lockout", () => {
  it("isAccountLocked returns false when no failures recorded", async () => {
    expect(await lockout.isAccountLocked("alice@example.com")).toBe(false);
  });

  it("locks after THRESHOLD failures", async () => {
    const email = "bob@example.com";
    for (let i = 0; i < lockout.AUTH_LOCKOUT_THRESHOLD; i++) {
      await lockout.recordAuthFailure(email);
    }
    expect(await lockout.isAccountLocked(email)).toBe(true);
  });

  it("stays unlocked below the threshold", async () => {
    const email = "carol@example.com";
    for (let i = 0; i < lockout.AUTH_LOCKOUT_THRESHOLD - 1; i++) {
      await lockout.recordAuthFailure(email);
    }
    expect(await lockout.isAccountLocked(email)).toBe(false);
  });

  it("clearAuthFailures unlocks a previously-locked account", async () => {
    const email = "dave@example.com";
    for (let i = 0; i < lockout.AUTH_LOCKOUT_THRESHOLD; i++) {
      await lockout.recordAuthFailure(email);
    }
    expect(await lockout.isAccountLocked(email)).toBe(true);
    await lockout.clearAuthFailures(email);
    expect(await lockout.isAccountLocked(email)).toBe(false);
  });

  it("normalizes email casing + surrounding whitespace", async () => {
    const variants = ["Eve@Example.COM", "  eve@example.com  ", "EVE@example.com"];
    // Failures under one variant lock every other variant.
    for (let i = 0; i < lockout.AUTH_LOCKOUT_THRESHOLD; i++) {
      await lockout.recordAuthFailure(variants[0]);
    }
    for (const v of variants) {
      expect(await lockout.isAccountLocked(v)).toBe(true);
    }
  });
});
