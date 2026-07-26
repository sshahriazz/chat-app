import crypto from "node:crypto";
import type { Request } from "express";
import { prisma } from "../db";
import { logger } from "../infra/logger";

/**
 * Append-only, TAMPER-EVIDENT audit trail for admin operator mutations.
 *
 * Every successful admin mutation calls `writeAdminAudit`. The actor IP is
 * taken from `req.socket.remoteAddress` (NOT `req.ip`) so a spoofed
 * `X-Forwarded-For` can't poison the trail.
 *
 * Tamper-evidence: each row stores `hash = SHA-256(prev_hash || canonical
 * content)`, chaining to the previous row. Editing or deleting any
 * historical row breaks every subsequent hash, which `verifyAuditChain`
 * detects by re-walking the chain from genesis. Writes are serialized with
 * a transaction-scoped advisory lock so concurrent admin actions can't
 * fork the chain.
 *
 * Failures are logged but do NOT block the response — the action already
 * succeeded; an audit-write failure is an alarm, not a caller regression.
 */
export interface AdminAuditEntry {
  action: string;
  tenantId?: string | null;
  details?: Record<string, unknown>;
}

// Fixed advisory-lock key that serializes audit-chain appends.
const AUDIT_CHAIN_LOCK = 0x41554449n; // "AUDI"

/** Deterministic JSON: object keys sorted recursively so the hash of the
 *  same logical content is stable regardless of key insertion order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const body = Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",");
  return `{${body}}`;
}

export interface AuditHashInput {
  action: string;
  tenantId: string | null;
  actorIp: string | null;
  requestId: string | null;
  details: Record<string, unknown>;
  createdAt: Date;
}

/**
 * Pure, deterministic chain-hash of one row given the previous row's hash.
 * Exported for unit testing and for `verifyAuditChain`.
 */
export function computeAuditHash(
  prevHash: string | null,
  input: AuditHashInput,
): string {
  const canonical = [
    prevHash ?? "GENESIS",
    input.action,
    input.tenantId ?? "",
    input.actorIp ?? "",
    input.requestId ?? "",
    stableStringify(input.details),
    input.createdAt.toISOString(),
  ].join("\n");
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
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
    const details = entry.details ?? {};
    const tenantId = entry.tenantId ?? null;
    // Stamp createdAt in-app so it's part of the hashed content (and thus
    // verifiable) rather than a DB-side default we couldn't hash at write
    // time.
    const createdAt = new Date();

    await prisma.$transaction(async (tx) => {
      // Serialize chain appends: two concurrent admin mutations must not
      // both read the same "previous" head and fork the chain.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK})`;
      const prev = await tx.adminAuditLog.findFirst({
        where: { hash: { not: null } },
        orderBy: { createdAt: "desc" },
        select: { hash: true },
      });
      const prevHash = prev?.hash ?? null;
      const hash = computeAuditHash(prevHash, {
        action: entry.action,
        tenantId,
        actorIp,
        requestId,
        details,
        createdAt,
      });
      await tx.adminAuditLog.create({
        data: {
          action: entry.action,
          tenantId,
          actorIp,
          requestId,
          details: details as object,
          createdAt,
          prevHash,
          hash,
        },
      });
    });
  } catch (err) {
    logger.error(
      { err: { message: (err as Error).message }, action: entry.action },
      "[admin-audit] write failed",
    );
  }
}

export interface AuditChainVerification {
  ok: boolean;
  checked: number;
  /** id of the first row whose stored hash didn't match the recomputation. */
  brokenAtId?: string;
}

/**
 * Re-walk the hash chain in insertion order and confirm every row's stored
 * hash equals the recomputation from the previous row + its content. A
 * mismatch means a row was edited, deleted, or reordered. Run periodically
 * (cron/alert) and on demand during incident response.
 */
export async function verifyAuditChain(): Promise<AuditChainVerification> {
  const rows = await prisma.adminAuditLog.findMany({
    where: { hash: { not: null } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      action: true,
      tenantId: true,
      actorIp: true,
      requestId: true,
      details: true,
      createdAt: true,
      prevHash: true,
      hash: true,
    },
  });

  let prevHash: string | null = null;
  let checked = 0;
  for (const r of rows) {
    // The stored link must match the running head...
    if ((r.prevHash ?? null) !== prevHash) {
      return { ok: false, checked, brokenAtId: r.id };
    }
    // ...and the stored hash must match a recomputation of the content.
    const expected = computeAuditHash(prevHash, {
      action: r.action,
      tenantId: r.tenantId ?? null,
      actorIp: r.actorIp ?? null,
      requestId: r.requestId ?? null,
      details: (r.details ?? {}) as Record<string, unknown>,
      createdAt: r.createdAt,
    });
    if (expected !== r.hash) {
      return { ok: false, checked, brokenAtId: r.id };
    }
    prevHash = r.hash;
    checked += 1;
  }
  return { ok: true, checked };
}
