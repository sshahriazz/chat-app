import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "./auth";

/**
 * In-process rate limiters. Good enough for single-instance deployment;
 * once we run N app instances, swap the store for Redis via
 * `rate-limit-redis` so the per-user quota is shared.
 *
 * Keys are user ids when an authenticated session is present (after
 * `requireAuth` has run), falling back to IP otherwise. IP alone is a
 * blunt instrument — NAT means many users share IPs — so the user-id
 * path is preferred.
 */
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
  handler: (req, res, _next, options) =>
    json413(res, options.windowMs),
});

/** Re-export so routes can apply it only when a user is authenticated. */
export type Limiter = (req: Request, res: Response, next: NextFunction) => void;
