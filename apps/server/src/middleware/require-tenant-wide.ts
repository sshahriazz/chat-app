import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "./auth";
import { ForbiddenError } from "../http/errors";

/**
 * Gate for tenant-wide (cross-scope) endpoints.
 *
 * Only requesters whose JWT carries `scope: null` — i.e. tenant-wide
 * identities not bound to a sub-partition — are allowed past. Scoped
 * users are rejected with 403.
 *
 * Preserves scope as a real isolation boundary: a scoped user cannot
 * escape their partition by initiating a tenant-wide chat that reaches
 * across scopes. They can still fully participate in tenant-wide
 * conversations they've been *added* to — membership remains the authz
 * primitive for everything downstream (read, write, presence, typing).
 *
 * MUST come after `requireAuth` in the chain so `req.scope` is populated.
 */
export function requireTenantWide(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const scope = (req as AuthenticatedRequest).scope;
  if (scope !== null) {
    next(
      new ForbiddenError("tenant-wide access requires an unscoped identity"),
    );
    return;
  }
  next();
}
