import type { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { env } from "../env";
import { ForbiddenError, UnauthorizedError } from "../http/errors";

/**
 * Gate for `/api/admin/*` endpoints — creating tenants, rotating their
 * keys. The operator sets `MASTER_API_KEY` in deploy config; requests
 * carry it as `Authorization: Bearer <key>`.
 *
 * Uses `timingSafeEqual` to avoid leaking the prefix of the configured
 * key via response-time side channels.
 */

function extractBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || typeof header !== "string") return null;
  const match = header.match(/^Bearer\s+(.+)$/);
  return match ? match[1] : null;
}

export function requireMasterKey(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  try {
    if (!env.MASTER_API_KEY) {
      throw new ForbiddenError(
        "Admin endpoints disabled: set MASTER_API_KEY to enable.",
      );
    }
    const provided = extractBearer(req);
    if (!provided) throw new UnauthorizedError("Missing master key");
    const a = Buffer.from(provided);
    const b = Buffer.from(env.MASTER_API_KEY);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new UnauthorizedError("Invalid master key");
    }
    next();
  } catch (err) {
    next(err);
  }
}
