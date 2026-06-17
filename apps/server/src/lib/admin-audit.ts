import type { Request } from "express";
import { prisma } from "../db";
import { logger } from "../infra/logger";

/**
 * Append-only audit trail for admin operator mutations. Every successful
 * admin mutation calls `writeAdminAudit` with a stable action key + the
 * optional subject (tenantId) + a structured detail blob. The actor IP
 * is taken from `req.socket.remoteAddress` (NOT `req.ip`) so a spoofed
 * `X-Forwarded-For` from a misconfigured proxy can't poison the trail.
 *
 * Failures are logged but do NOT block the response — the action
 * already succeeded by the time we record it; an audit-write failure
 * is an alarm, not a regression for the caller.
 */
export interface AdminAuditEntry {
  action: string;
  tenantId?: string | null;
  details?: Record<string, unknown>;
}

export async function writeAdminAudit(
  req: Request,
  entry: AdminAuditEntry,
): Promise<void> {
  try {
    const actorIp = req.socket.remoteAddress ?? null;
    const rawReqId = req.headers["x-request-id"];
    const requestId =
      typeof rawReqId === "string" ? rawReqId.slice(0, 64) : null;
    await prisma.adminAuditLog.create({
      data: {
        action: entry.action,
        tenantId: entry.tenantId ?? null,
        actorIp,
        requestId,
        details: (entry.details ?? {}) as object,
      },
    });
  } catch (err) {
    logger.error(
      { err: { message: (err as Error).message }, action: entry.action },
      "[admin-audit] write failed",
    );
  }
}
