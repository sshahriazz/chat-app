import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Cache tests run against an in-memory ioredis-mock so they don't
 * require a live Redis. The `vi.mock` has to be hoisted above any
 * import of `./cache` (which transitively imports `infra/redis`), so
 * we keep the imports dynamic inside `beforeEach`.
 */
vi.mock("../infra/redis", async () => {
  const mod = await import("ioredis-mock");
  const RedisMock = (mod as { default: typeof import("ioredis-mock") })
    .default as unknown as new () => unknown;
  const client = new RedisMock();
  return { redis: client };
});

type CacheModule = typeof import("./cache");

let cache: CacheModule;

beforeEach(async () => {
  cache = await import("./cache");
  // Flush the mock between tests to keep them independent.
  const { redis } = (await import("../infra/redis")) as {
    redis: { flushall: () => Promise<string> };
  };
  await redis.flushall();
});

describe("cache.ts", () => {
  it("returns null on a miss", async () => {
    const hit = await cache.cacheGet<string>(cache.CACHE_NS.userProfile, "nope");
    expect(hit).toBeNull();
  });

  it("sets and gets a JSON value", async () => {
    await cache.cacheSet(cache.CACHE_NS.userProfile, "u1", {
      id: "u1",
      name: "Alice",
    });
    const hit = await cache.cacheGet<{ id: string; name: string }>(
      cache.CACHE_NS.userProfile,
      "u1",
    );
    expect(hit).toEqual({ id: "u1", name: "Alice" });
  });

  it("revives ISO date strings back into Date instances", async () => {
    const now = new Date();
    await cache.cacheSet(cache.CACHE_NS.userProfile, "u2", { at: now });
    const hit = await cache.cacheGet<{ at: Date }>(
      cache.CACHE_NS.userProfile,
      "u2",
    );
    expect(hit?.at).toBeInstanceOf(Date);
    expect(hit?.at.getTime()).toBe(now.getTime());
  });

  it("cacheDel removes entries", async () => {
    await cache.cacheSet(cache.CACHE_NS.userProfile, "u3", { id: "u3" });
    await cache.cacheDel(cache.CACHE_NS.userProfile, "u3");
    expect(
      await cache.cacheGet(cache.CACHE_NS.userProfile, "u3"),
    ).toBeNull();
  });

  it("cacheGetOrSet caches the loader result on first call", async () => {
    const loader = vi.fn(async () => ({ id: "u4", name: "Bob" }));
    const first = await cache.cacheGetOrSet(
      cache.CACHE_NS.userProfile,
      "u4",
      loader,
    );
    const second = await cache.cacheGetOrSet(
      cache.CACHE_NS.userProfile,
      "u4",
      loader,
    );
    expect(first).toEqual({ id: "u4", name: "Bob" });
    expect(second).toEqual({ id: "u4", name: "Bob" });
    // Second call is a hit — loader must not run twice.
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("cacheBatchGetOrSet uses loader only for misses", async () => {
    await cache.cacheSet(cache.CACHE_NS.userProfile, "a", { id: "a" });
    const loader = vi.fn(async (misses: string[]) => {
      const out = new Map<string, { id: string }>();
      for (const id of misses) out.set(id, { id });
      return out;
    });
    const result = await cache.cacheBatchGetOrSet(
      cache.CACHE_NS.userProfile,
      ["a", "b", "c"],
      loader,
    );
    expect(result.size).toBe(3);
    expect(result.get("a")).toEqual({ id: "a" });
    expect(result.get("b")).toEqual({ id: "b" });
    expect(result.get("c")).toEqual({ id: "c" });
    // Loader only asked about the two misses.
    expect(loader).toHaveBeenCalledWith(["b", "c"]);
  });
});
