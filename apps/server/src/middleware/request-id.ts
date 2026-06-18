import type { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { runWithRequestContext } from "../infra/request-context";

/**
 * Attach a unique request id to each request and make it available to
 * downstream async work via AsyncLocalStorage. Accepts an incoming
 * X-Request-Id if the edge/LB already generated one — this lets us
 * correlate logs across tiers without minting a new id.
 *
 * Must be registered BEFORE pino-http + all routes so every log line
 * gets the correlated `reqId`.
 */
export function requestId(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const rawIncoming =
    typeof req.headers["x-request-id"] === "string"
      ? req.headers["x-request-id"]
      : undefined;

  // Sanitize: strip anything outside a safe id charset. The value is
  // echoed back in a response header AND logged + returned in error
  // envelopes, so an unsanitized value could carry control chars /
  // markup that render in a log viewer or admin UI. Length-cap too, so
  // a malicious client can't flood logs with a 10 MB "request id".
  const incoming = rawIncoming
    ? rawIncoming.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 128)
    : undefined;

  const id = incoming && incoming.length > 0 ? incoming : crypto.randomUUID();

  res.setHeader("X-Request-Id", id);
  runWithRequestContext({ requestId: id }, () => next());
}
