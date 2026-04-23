import type { Request, Response, NextFunction } from "express";
import { UnauthorizedError } from "../http/errors";
import { peekTokenIssuer, verifyUserToken } from "../http/jwt-tenant";
import { getTenantById } from "../lib/tenant";
import { upsertFederatedUser } from "../lib/user-federation";
import type { AuthenticatedRequest } from "./auth";

/**
 * JWT federation middleware. Accepts a tenant-signed user token in
 * `Authorization: Bearer <jwt>`, verifies against the issuing tenant's
 * `jwtSecret`, upserts a `User` row from the claims, and populates
 * `req.user` with the SAME shape the existing `requireAuth` produced.
 *
 * Route handlers reading `req.user.id / name / email / image` need zero
 * code changes — this is a drop-in replacement for cookie sessions.
 *
 * Dormant in PR 1 (not mounted by any route). PR 2 wires it into the
 * dual-auth path inside `requireAuth`.
 */

function extractBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || typeof header !== "string") return null;
  const match = header.match(/^Bearer\s+(.+)$/);
  return match ? match[1] : null;
}

export async function requireUserJwt(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  try {
    const token = extractBearer(req);
    if (!token) throw new UnauthorizedError("Missing user token");

    const issuer = peekTokenIssuer(token);
    if (!issuer) throw new UnauthorizedError("Malformed user token");

    const tenant = await getTenantById(issuer);
    if (!tenant) throw new UnauthorizedError("Unknown tenant");

    let claims;
    try {
      claims = verifyUserToken(token, tenant.jwtSecret);
    } catch {
      throw new UnauthorizedError("Invalid user token");
    }

    // Normalize scope: treat empty string / whitespace as unscoped.
    // The tenant should be deliberate about null-vs-value; a stray
    // empty string from a buggy signer shouldn't carve a phantom
    // partition.
    const rawScope = claims.scope;
    const scope =
      typeof rawScope === "string" && rawScope.trim().length > 0
        ? rawScope
        : null;

    const user = await upsertFederatedUser(tenant.id, {
      externalId: claims.sub,
      name: claims.name,
      image: claims.image ?? null,
      email: claims.email ?? null,
      scope,
    });

    const r = req as AuthenticatedRequest;
    r.user = {
      id: user.id,
      name: user.name,
      email: user.email ?? "",
      image: user.image,
    };
    r.session = {
      id: `jwt_${user.id}`,
      token: "",
      userId: user.id,
      expiresAt: new Date(claims.exp * 1000),
    };
    r.tenantId = tenant.id;
    r.scope = scope;
    next();
  } catch (err) {
    next(err);
  }
}
