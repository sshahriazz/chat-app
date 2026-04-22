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
}
