import type { Request, Response, NextFunction } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../auth";
import { CACHE_NS, cacheGet, cacheSet, cacheDel } from "../lib/cache";
import { UnauthorizedError } from "../http/errors";

export interface AuthenticatedRequest extends Request {
  user: { id: string; name: string; email: string; image: string | null };
  session: { id: string; token: string; userId: string; expiresAt: Date };
}

/**
 * Redis-backed session cache. better-auth's `getSession` hits Postgres
 * on every call; for hot endpoints (sending messages, typing) that's a
 * SELECT per request. Caching the validated session for a short window
 * cuts DB reads by roughly the rps-per-user factor while keeping the
 * revocation delay bounded to `CACHE_NS.session.ttlSec`.
 *
 * Scaling notes:
 *  - Shared across replicas: a revocation happening on one instance
 *    expires for everyone once Redis TTL elapses; no per-instance drift.
 *  - Key is the raw cookie value, so the same user logging in from two
 *    browsers keeps two separate cache entries (as expected).
 *  - For stricter revocation, `cacheDel(CACHE_NS.session, cookieKey)`
 *    from /api/auth/sign-out as a follow-up.
 */

interface CachedSession {
  user: AuthenticatedRequest["user"];
  session: AuthenticatedRequest["session"];
}

/**
 * Extract better-auth's session-token cookie value from the Cookie header.
 * Keying the cache on this narrower value — rather than the whole header —
 * means unrelated cookie changes (e.g. a CSRF header being added by a
 * proxy) don't thrash the cache, and two users whose browsers happen to
 * emit the same ancillary cookies can't collide on the key.
 *
 * Supports both the plain and `__Secure-` prefixed cookie names that
 * better-auth uses depending on whether the request is HTTPS.
 */
function extractSessionCookie(cookieHeader: string): string | null {
  const names = [
    "better-auth.session_token",
    "__Secure-better-auth.session_token",
  ];
  for (const name of names) {
    const re = new RegExp(
      `(?:^|;\\s*)${name.replace(/\./g, "\\.")}=([^;]+)`,
    );
    const match = cookieHeader.match(re);
    if (match) return `${name}=${match[1]}`;
  }
  return null;
}

export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  try {
    const cookieKey = extractSessionCookie(req.headers.cookie ?? "");

    if (cookieKey) {
      const hit = await cacheGet<CachedSession>(CACHE_NS.session, cookieKey);
      if (hit) {
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
      if (cookieKey) await cacheDel(CACHE_NS.session, cookieKey);
      throw new UnauthorizedError();
    }

    const user = session.user as AuthenticatedRequest["user"];
    const sessionInfo = session.session as AuthenticatedRequest["session"];

    if (cookieKey) {
      await cacheSet(CACHE_NS.session, cookieKey, { user, session: sessionInfo });
    }

    (req as AuthenticatedRequest).user = user;
    (req as AuthenticatedRequest).session = sessionInfo;
    next();
  } catch (err) {
    next(err);
  }
}
