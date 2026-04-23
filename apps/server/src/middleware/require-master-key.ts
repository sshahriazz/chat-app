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
 *     a blessed source. Compared against `req.ip`, which is the real
 *     client thanks to `trust proxy`.
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
      const ip = req.ip ?? "";
      if (!list.has(ip)) {
        throw new ForbiddenError("Source IP not allowed for admin endpoints");
      }
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
