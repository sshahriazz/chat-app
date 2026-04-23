import type { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { env } from "../env";
import { UnauthorizedError } from "../http/errors";
import type { ApiKeyAuthenticatedRequest } from "./require-api-key";

/**
 * Optional body-signature verification for `POST /api/webhooks/*`.
 *
 * Tenants compute `HMAC-SHA256(apiKey, rawRequestBody)` hex-encoded,
 * and send it as `X-Chat-Signature: sha256=<hex>`. Without this the
 * only webhook defense is the bearer key — a leaked key is enough to
 * forge a request. With it, an attacker needs both the key AND the
 * ability to sign, which means the key's at-rest store is no longer
 * the single point of compromise.
 *
 * Modes:
 *   - If the header is present: always verify. Bad signature → 401.
 *   - If the header is absent:
 *       * `WEBHOOK_SIGNATURE_REQUIRED=true` → reject with 401
 *       * otherwise → allow (backwards-compat)
 *
 * Depends on `requireApiKey` running first (it stashes `req.apiKey`)
 * and on `express.json({ verify })` having captured the raw bytes.
 */

export function requireWebhookSignature(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  try {
    const header = req.headers["x-chat-signature"];
    const signature = Array.isArray(header) ? header[0] : header;

    if (!signature) {
      if (env.WEBHOOK_SIGNATURE_REQUIRED) {
        throw new UnauthorizedError("Missing X-Chat-Signature");
      }
      next();
      return;
    }

    const match = signature.match(/^sha256=([0-9a-fA-F]{64})$/);
    if (!match) {
      throw new UnauthorizedError("Malformed X-Chat-Signature");
    }

    const r = req as ApiKeyAuthenticatedRequest & { rawBody?: Buffer };
    if (!r.apiKey || !r.rawBody) {
      // Either the route is mounted without the raw-body parser, or
      // requireApiKey didn't run first. Fail closed.
      throw new UnauthorizedError("Signature verification unavailable");
    }

    const expected = crypto
      .createHmac("sha256", r.apiKey)
      .update(r.rawBody)
      .digest("hex");

    const a = Buffer.from(match[1], "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new UnauthorizedError("Invalid X-Chat-Signature");
    }

    next();
  } catch (err) {
    next(err);
  }
}
