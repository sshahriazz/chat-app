import type { Request, Response, NextFunction } from "express";
import { UnauthorizedError } from "../http/errors";
import { findTenantByApiKey } from "../lib/tenant";

/**
 * Bearer API-key authentication for server-to-server endpoints (webhooks,
 * admin operations called by a tenant's backend). The tenant sends
 * `Authorization: Bearer <apiKey>`; we Argon2-verify against every
 * tenant's stored hash.
 *
 * On success: `req.tenantId` is set.
 */

export interface ApiKeyAuthenticatedRequest extends Request {
  tenantId: string;
  /** The raw API key presented in `Authorization: Bearer`. Stashed on
   *  the request so downstream middleware (e.g. webhook signature
   *  verification) can HMAC request bodies with it without re-reading
   *  the header. Do not log or echo this value. */
  apiKey: string;
}

function extractBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || typeof header !== "string") return null;
  const match = header.match(/^Bearer\s+(.+)$/);
  return match ? match[1] : null;
}

export async function requireApiKey(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  try {
    const key = extractBearer(req);
    if (!key) throw new UnauthorizedError("Missing API key");
    const tenant = await findTenantByApiKey(key);
    if (!tenant) throw new UnauthorizedError("Invalid API key");
    const r = req as ApiKeyAuthenticatedRequest;
    r.tenantId = tenant.id;
    r.apiKey = key;
    next();
  } catch (err) {
    next(err);
  }
}
