import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { UnauthorizedError } from "../http/errors";
import { findTenantByApiKey } from "../lib/tenant";

/**
 * Bearer API-key authentication for server-to-server endpoints (webhooks,
 * admin operations called by a tenant's backend). The tenant sends
 * `Authorization: Bearer <apiKey>`; we Argon2-verify against every
 * tenant's stored hash.
 *
 * On success: `req.tenantId` is set. We deliberately do NOT keep the raw
 * API key on the request — instead, when a raw body was captured
 * (webhook routes use `express.json({ verify })`), we compute the
 * HMAC-SHA256 of the body with the key here, while the key is still a
 * local variable, and stash only that digest. The webhook signature
 * middleware compares against it. This means the raw key never lives
 * past this function and can't leak through an accidental `req` log.
 */

export interface ApiKeyAuthenticatedRequest extends Request {
  tenantId: string;
  /** HMAC-SHA256(apiKey, rawBody) hex digest, computed in requireApiKey
   *  for routes that captured a raw body. The signature middleware
   *  compares the client's X-Chat-Signature against this — the raw key
   *  is never exposed on the request object. */
  webhookBodyHmac?: string;
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
    const r = req as ApiKeyAuthenticatedRequest & { rawBody?: Buffer };
    r.tenantId = tenant.id;
    // Pre-compute the body HMAC while the key is in local scope. Only on
    // routes that captured the raw body (webhooks); admin routes don't,
    // and don't need it.
    if (r.rawBody) {
      r.webhookBodyHmac = crypto
        .createHmac("sha256", key)
        .update(r.rawBody)
        .digest("hex");
    }
    next();
  } catch (err) {
    next(err);
  }
}
