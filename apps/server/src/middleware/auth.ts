import type { Request, Response, NextFunction } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../auth";

export interface AuthenticatedRequest extends Request {
  user: { id: string; name: string; email: string; image: string | null };
  session: { id: string; token: string; userId: string; expiresAt: Date };
}

/**
 * In-process session cache. better-auth's `getSession` hits Postgres on every
 * call; for hot endpoints (sending messages, typing) that's a SELECT per
 * request. Caching the result for a short window keeps correctness acceptable
 * (max 30s window to reflect a revoked session) while cutting DB reads by
 * roughly the rps-per-user factor.
 *
 * Scaling notes:
 *  - Keyed by the raw cookie header, so per-browser. Memory is bounded by
 *    the number of active sessions × TTL.
 *  - When we run multiple server instances, each has its own cache — fine,
 *    since cache misses just cost one DB read and TTL is short.
 *  - For stricter revocation, swap the Map for Redis and publish a
 *    `session_invalidated` event from /api/auth/sign-out.
 */
interface CachedSession {
  user: AuthenticatedRequest["user"];
  session: AuthenticatedRequest["session"];
  expiresAt: number;
}

const SESSION_CACHE_TTL_MS = 30_000;
const sessionCache = new Map<string, CachedSession>();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessionCache) {
    if (v.expiresAt <= now) sessionCache.delete(k);
  }
}, 60_000).unref();

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const cookieKey = req.headers.cookie ?? "";

  if (cookieKey) {
    const hit = sessionCache.get(cookieKey);
    if (hit && hit.expiresAt > Date.now()) {
      (req as AuthenticatedRequest).user = hit.user;
      (req as AuthenticatedRequest).session = hit.session;
      next();
      return;
    }
  }

  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });

  if (!session) {
    if (cookieKey) sessionCache.delete(cookieKey);
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const user = session.user as AuthenticatedRequest["user"];
  const sessionInfo = session.session as AuthenticatedRequest["session"];

  if (cookieKey) {
    sessionCache.set(cookieKey, {
      user,
      session: sessionInfo,
      expiresAt: Date.now() + SESSION_CACHE_TTL_MS,
    });
  }

  (req as AuthenticatedRequest).user = user;
  (req as AuthenticatedRequest).session = sessionInfo;
  next();
}
