import type { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { env } from "../env";
import { ForbiddenError, UnauthorizedError } from "../http/errors";

/**
 * Gate for `/api/admin/*` endpoints — creating tenants, rotating their
 * keys. The operator sets `MASTER_API_KEY` in deploy config; requests
 * carry it as `Authorization: Bearer <key>`.
 *
 * Layered defenses:
 *  1. Optional IP allowlist (`ADMIN_IP_ALLOWLIST`) checked FIRST so a
 *     leaked key alone isn't enough — the request must also come from
 *     a blessed source. Compared against `req.socket.remoteAddress`
 *     (the actual TCP peer), NOT `req.ip` — `req.ip` is derived from
 *     `X-Forwarded-For` per `trust proxy` and is therefore spoofable
 *     by any upstream hop the operator has misconfigured. Admin must
 *     be reached from an internal network where the proxy itself is
 *     the peer; document that allowlist entries should be those
 *     proxy/internal IPs.
 *  2. `timingSafeEqual` master-key compare so the bearer check doesn't
 *     leak the key prefix via response timing.
 */

function extractBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || typeof header !== "string") return null;
  const match = header.match(/^Bearer\s+(.+)$/);
  return match ? match[1] : null;
}

let allowlist: Set<string> | null = null;
function parseAllowlist(): Set<string> | null {
  if (allowlist !== null) return allowlist;
  const raw = env.ADMIN_IP_ALLOWLIST;
  if (!raw) {
    allowlist = new Set();
    return allowlist;
  }
  allowlist = new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return allowlist;
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

    const list = parseAllowlist();
    if (list && list.size > 0) {
      // Use the actual TCP peer, not req.ip — req.ip honors
      // X-Forwarded-For via `trust proxy`, which an attacker can set
      // freely. The allowlist must contain the IP(s) of the reverse
      // proxy / internal hop in front of the server.
      const ip = req.socket.remoteAddress ?? "";
      if (!list.has(ip)) {
        throw new ForbiddenError("Source IP not allowed for admin endpoints");
      }
    }

    const provided = extractBearer(req);
    if (!provided) throw new UnauthorizedError("Missing master key");

    // Hash both sides first so the constant-time compare runs over
    // fixed-length 32-byte buffers. Comparing raw strings via
    // `timingSafeEqual` requires a length pre-check, which leaks the
    // master-key length over the network. Hashing closes that gap;
    // the SHA-256 cost is negligible and identical for any input.
    const a = crypto.createHash("sha256").update(provided).digest();
    const b = crypto.createHash("sha256").update(env.MASTER_API_KEY).digest();
    if (!crypto.timingSafeEqual(a, b)) {
      throw new UnauthorizedError("Invalid master key");
    }
    next();
  } catch (err) {
    next(err);
  }
}
