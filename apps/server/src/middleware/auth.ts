/**
 * Post-cutover auth. Every authenticated endpoint uses the tenant-
 * federated JWT flow via `requireUserJwt`. The legacy cookie-session
 * dispatcher and its dual-auth mode live on only in git history.
 *
 * Kept as a thin re-export so route handlers that already imported
 * `requireAuth` don't need to churn. PR 4 will fold it away entirely.
 */
import type { Request } from "express";

export { requireUserJwt as requireAuth } from "./require-user-jwt";

export interface AuthenticatedRequest extends Request {
  user: { id: string; name: string; email: string; image: string | null };
  session: { id: string; token: string; userId: string; expiresAt: Date };
  // Tenant the JWT was issued under. Route handlers MUST use this in
  // every Prisma `where` touching a tenant-scoped table so a leaked
  // or guessed id from another tenant can't be read or mutated.
  tenantId: string;
  // Second-level partition *within* the tenant (from the JWT's `scope`
  // claim). NULL = tenant-wide requester; sees everyone. Non-null =
  // scoped requester; sees only same-scope + unscoped users. See
  // `scopeFilter` in lib/scope-filter for the canonical predicate.
  scope: string | null;
}
