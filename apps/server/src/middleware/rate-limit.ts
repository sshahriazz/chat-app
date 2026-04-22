import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import RedisStore from "rate-limit-redis";
import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "./auth";
import { redis } from "../infra/redis";

/**
 * Redis-backed rate limiters.
 *
 * Using a shared Redis store means per-user (and per-IP) quotas are
 * enforced globally across all app instances — a user can't bypass the
 * limit by landing on a different pod. Local memory store would let
 * each pod serve its own N requests, multiplying the effective cap.
 *
 * Keys are user ids when an authenticated session is present (after
 * `requireAuth` has run), falling back to IP otherwise. IP alone is a
 * blunt instrument — NAT means many users share IPs — so the user-id
 * path is preferred.
 */

// Keyspace prefix per limiter so counters from different endpoints
// don't collide in Redis.
function makeStore(prefix: string) {
  return new RedisStore({
    prefix: `rl:${prefix}:`,
    // ioredis v5 exposes `call` directly; rate-limit-redis expects a
    // function returning the Redis reply. We lose a little type fidelity
    // here but the library only cares about shape, not precise nullability.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendCommand: ((...args: string[]) =>
      redis.call(args[0] as string, ...args.slice(1))) as any,
  });
}
function userKey(req: Request, _res: Response): string {
  const userId = (req as AuthenticatedRequest).user?.id;
  if (userId) return `u:${userId}`;
  // Fall back to the IP-based key. `ipKeyGenerator` collapses IPv6
  // addresses to their /64 prefix so multiple addresses in the same
  // subnet share one bucket (otherwise IPv6 users could trivially
  // bypass the limit by rotating addresses). Returning the helper's
  // value also satisfies the library's startup validator.
  return ipKeyGenerator(req.ip ?? "");
}

const json413 = (res: Response, retryAfterMs: number) => {
  res.status(429).json({
    error: "Too many requests",
    retryAfterMs,
  });
};

/** ~30 msgs/min/user. Blocks paste-storms and runaway retry loops. */
export const sendMessageLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: userKey,
  store: makeStore("send"),
  handler: (req, res, _next, options) =>
    json413(res, options.windowMs),
});

/** Typing indicator is high-volume by design; cap at 20/s (one per 50ms). */
export const typingLimiter = rateLimit({
  windowMs: 1_000,
  limit: 20,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: userKey,
  store: makeStore("typing"),
  handler: (req, res, _next, options) =>
    json413(res, options.windowMs),
});

/** Presign endpoint gates object-storage churn; avatar + attachment flows. */
export const uploadUrlLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: userKey,
  store: makeStore("upload"),
  handler: (req, res, _next, options) =>
    json413(res, options.windowMs),
});

/** Search is read-only but expensive (similarity + scan). 10/s/user. */
export const searchLimiter = rateLimit({
  windowMs: 1_000,
  limit: 10,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: userKey,
  store: makeStore("search"),
  handler: (req, res, _next, options) =>
    json413(res, options.windowMs),
});

/** Default catch-all for any endpoint worth loosely guarding. */
export const generalLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: userKey,
  store: makeStore("gen"),
  handler: (req, res, _next, options) =>
    json413(res, options.windowMs),
});

/**
 * Brute-force protection for the unauthenticated auth endpoints. Keyed by
 * IP (no user yet) via `ipKeyGenerator` so IPv6 callers can't rotate
 * addresses to bypass.
 *
 * PR 3: removed. Tenants handle password auth in their own backend;
 * the chat server never sees credentials. If abuse on the webhook
 * endpoints becomes a concern, add a dedicated tenant-keyed limiter
 * there — the webhook routes already have that (webhooks.ts).
 */

/** Re-export so routes can apply it only when a user is authenticated. */
export type Limiter = (req: Request, res: Response, next: NextFunction) => void;
