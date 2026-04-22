import type { Request, Response, NextFunction } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../auth";
import { env } from "../env";
import { CACHE_NS, cacheGet, cacheSet, cacheDel } from "../lib/cache";
import { UnauthorizedError } from "../http/errors";
import { requireUserJwt } from "./require-user-jwt";

export interface AuthenticatedRequest extends Request {
  user: { id: string; name: string; email: string; image: string | null };
  session: { id: string; token: string; userId: string; expiresAt: Date };
}

/**
 * Unified auth middleware — dispatches to either the legacy cookie-based
 * better-auth path or the new tenant-federated JWT path based on:
 *
 *   1. Request shape: a `Authorization: Bearer …` header means JWT; a
 *      `Cookie: better-auth.session_token=…` header means session.
 *   2. Operator-set `AUTH_MODE` env:
 *        - `both` (default)  — accept either; prefer JWT when both present
 *        - `session`         — cookie-only, 401 on Bearer
 *        - `jwt`             — JWT-only, 401 on cookie (used for cutover)
 *
 * The downstream `req.user` / `req.session` shape is identical across
 * both paths so every route handler stays agnostic. PR 3 collapses this
 * to just the JWT path; PR 4 removes the cookie branch entirely.
 */


interface CachedSession {
  user: AuthenticatedRequest["user"];
  session: AuthenticatedRequest["session"];
}

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

function hasBearer(req: Request): boolean {
  const h = req.headers.authorization;
  return typeof h === "string" && /^Bearer\s+.+/.test(h);
}

async function requireCookieSession(
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
      await cacheSet(CACHE_NS.session, cookieKey, {
        user,
        session: sessionInfo,
      });
    }

    (req as AuthenticatedRequest).user = user;
    (req as AuthenticatedRequest).session = sessionInfo;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const mode = env.AUTH_MODE;
  const bearer = hasBearer(req);

  if (mode === "jwt") {
    // Cutover mode: reject cookie-only requests outright.
    if (!bearer) {
      next(new UnauthorizedError("Bearer token required (AUTH_MODE=jwt)"));
      return;
    }
    void requireUserJwt(req, res, next);
    return;
  }

  if (mode === "session") {
    if (bearer) {
      next(new UnauthorizedError("Cookie session required (AUTH_MODE=session)"));
      return;
    }
    void requireCookieSession(req, res, next);
    return;
  }

  // `both` — JWT wins when present, cookie otherwise.
  if (bearer) {
    void requireUserJwt(req, res, next);
  } else {
    void requireCookieSession(req, res, next);
  }
}
