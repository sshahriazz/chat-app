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
  const incoming =
    typeof req.headers["x-request-id"] === "string"
      ? req.headers["x-request-id"]
      : undefined;

  // Reject absurd values. A malicious client could otherwise flood logs
  // with 10 MB "request ids".
  const id =
    incoming && incoming.length > 0 && incoming.length <= 128
      ? incoming
      : crypto.randomUUID();

  res.setHeader("X-Request-Id", id);
  runWithRequestContext({ requestId: id }, () => next());
}
