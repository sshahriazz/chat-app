import { redis } from "../infra/redis";
import { logger } from "../infra/logger";
import { recordCacheOp } from "../infra/metrics";

/** Namespace prefix → short label for Prometheus cardinality hygiene. */
function nsLabel(prefix: string): string {
  // "cache:session:" → "session", "cache:conv:members:" → "convMembers"
  return prefix.replace(/^cache:/, "").replace(/:/g, "").replace(/s$/, "") || "unknown";
}

/**
 * Typed Redis cache layer.
 *
 * Why Redis (vs. the in-process Maps we had before):
 *   - Survives multi-instance deploys: every app replica sees the same
 *     cached value and the same invalidation.
 *   - Survives rolling restarts — a redeploy doesn't cold-start every
 *     cache from scratch.
 *   - Centralized TTL + memory pressure handled by Redis rather than
 *     hand-rolled LRUs in each module.
 *
 * Fail-open policy: Redis is an optional hot path — if it's unreachable
 * or misbehaving, every helper here swallows the error and falls back to
 * "cache miss" so the caller loads from the source of truth. The
 * alternative (fail-closed) would take the whole app down with Redis.
 *
 * Namespaces carry the TTL contract for each entity. Co-locating them
 * here (rather than sprinkling magic strings) prevents two callers from
 * picking incompatible keys for the same data.
 */

export const CACHE_NS = {
  /** Better-auth session → user + session info. Short TTL bounds the
   *  revocation window. Keyed on the raw cookie value, not the user id,
   *  so a stale session cookie doesn't masquerade as a valid one. */
  session: { prefix: "cache:session:", ttlSec: 30 },

  /** conversationId → userId[] for realtime fan-out. Invalidated
   *  transactionally when members change. */
  convMembers: { prefix: "cache:conv:members:", ttlSec: 300 },

  /** userId → { id, name, email, image }. Invalidated when the user
   *  updates their profile — fired from the users.updated webhook and
   *  from the JWT middleware when claims differ from the cached row. */
  userProfile: { prefix: "cache:user:", ttlSec: 600 },

  /** conversationId → { id, type, name, version, createdBy }.
   *  Invalidated on rename / member change / any version bump. */
  convMeta: { prefix: "cache:conv:meta:", ttlSec: 600 },
} as const;

export type CacheNamespace = typeof CACHE_NS[keyof typeof CACHE_NS];

/** `Date`s survive JSON round-trip as ISO strings; this reviver puts
 *  them back so downstream code can call `.getTime()` without blowing up. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
function reviveDates(_key: string, value: unknown): unknown {
  if (typeof value === "string" && ISO_DATE.test(value)) return new Date(value);
  return value;
}

function key(ns: CacheNamespace, id: string): string {
  return ns.prefix + id;
}

export async function cacheGet<T>(
  ns: CacheNamespace,
  id: string,
): Promise<T | null> {
  const label = nsLabel(ns.prefix);
  try {
    const raw = await redis.get(key(ns, id));
    if (raw === null) {
      recordCacheOp(label, "get", "miss");
      return null;
    }
    recordCacheOp(label, "get", "hit");
    return JSON.parse(raw, reviveDates) as T;
  } catch (err) {
    recordCacheOp(label, "get", "error");
    logger.warn(
      { err: { message: (err as Error).message }, ns: ns.prefix, id },
      "[cache] get failed",
    );
    return null;
  }
}

export async function cacheSet<T>(
  ns: CacheNamespace,
  id: string,
  value: T,
): Promise<void> {
  const label = nsLabel(ns.prefix);
  try {
    await redis.set(key(ns, id), JSON.stringify(value), "EX", ns.ttlSec);
    recordCacheOp(label, "set", "ok");
  } catch (err) {
    recordCacheOp(label, "set", "error");
    logger.warn(
      { err: { message: (err as Error).message }, ns: ns.prefix, id },
      "[cache] set failed",
    );
  }
}

export async function cacheDel(
  ns: CacheNamespace,
  ...ids: string[]
): Promise<void> {
  if (ids.length === 0) return;
  const label = nsLabel(ns.prefix);
  try {
    await redis.del(...ids.map((id) => key(ns, id)));
    recordCacheOp(label, "del", "ok");
  } catch (err) {
    recordCacheOp(label, "del", "error");
    logger.warn(
      { err: { message: (err as Error).message }, ns: ns.prefix },
      "[cache] del failed",
    );
  }
}

/**
 * Read-through helper. On miss, invokes `loader`, stores the result,
 * and returns it. On Redis failure we still run `loader` — the cache is
 * a performance optimization, not a correctness dependency.
 *
 * No stampede protection: chat workloads rarely see thousands of parallel
 * cache-miss requests on the same key. If that changes we can add a
 * Redis `SET NX` lock here without touching callers.
 */
export async function cacheGetOrSet<T>(
  ns: CacheNamespace,
  id: string,
  loader: () => Promise<T>,
): Promise<T> {
  const hit = await cacheGet<T>(ns, id);
  if (hit !== null) return hit;
  const value = await loader();
  // Don't cache `null` — we use null to signal "not in cache". Callers
  // that want to memoize a negative result should cache a sentinel shape.
  if (value !== null && value !== undefined) {
    await cacheSet(ns, id, value);
  }
  return value;
}

/**
 * Batched read. Fetches every requested id in one Redis `MGET` and
 * invokes `loader` for just the misses. The loader receives only the
 * ids that weren't cached and returns a map keyed by id; missing-from-
 * loader entries are treated as "doesn't exist".
 *
 * Used for fan-out hot paths like resolving senderName for a batch of
 * message events or `/api/users/online` presence checks.
 */
export async function cacheBatchGetOrSet<T>(
  ns: CacheNamespace,
  ids: string[],
  loader: (misses: string[]) => Promise<Map<string, T>>,
): Promise<Map<string, T>> {
  const result = new Map<string, T>();
  if (ids.length === 0) return result;

  let cached: (string | null)[] = [];
  try {
    cached = await redis.mget(...ids.map((id) => key(ns, id)));
  } catch (err) {
    logger.warn(
      { err: { message: (err as Error).message }, ns: ns.prefix },
      "[cache] mget failed",
    );
    cached = ids.map(() => null);
  }

  const misses: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    const raw = cached[i];
    if (raw === null) {
      misses.push(ids[i]);
      continue;
    }
    try {
      result.set(ids[i], JSON.parse(raw, reviveDates) as T);
    } catch {
      misses.push(ids[i]);
    }
  }

  if (misses.length > 0) {
    const loaded = await loader(misses);
    // Pipeline the individual SETs so we don't pay one RTT per entry.
    try {
      const pipeline = redis.pipeline();
      for (const [id, value] of loaded) {
        pipeline.set(key(ns, id), JSON.stringify(value), "EX", ns.ttlSec);
        result.set(id, value);
      }
      if (loaded.size > 0) await pipeline.exec();
    } catch (err) {
      logger.warn(
        { err: { message: (err as Error).message }, ns: ns.prefix },
        "[cache] pipeline set failed",
      );
      // Still populate the result map even if the write to Redis failed.
      for (const [id, value] of loaded) result.set(id, value);
    }
  }

  return result;
}
