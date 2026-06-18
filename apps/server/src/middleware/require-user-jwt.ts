import type { Request, Response, NextFunction } from "express";
import { GoneError, UnauthorizedError } from "../http/errors";
import { peekTokenIssuer, verifyUserToken } from "../http/jwt-tenant";
import { getTenantById } from "../lib/tenant";
import { upsertFederatedUser } from "../lib/user-federation";
import { prisma } from "../db";
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
      claims = verifyUserToken(token, tenant.jwtSecret, tenant.id);
    } catch {
      throw new UnauthorizedError("Invalid user token");
    }

    // GDPR-delete tombstone check. If the user previously called
    // `DELETE /me`, refuse to re-materialize them until the
    // (tenantId, externalId) tombstone expires. This is the
    // "right to be forgotten" enforcement primitive: without it,
    // the next authenticated request would silently recreate the
    // User row from the JWT claims.
    const tombstoneExternalId = String(claims.sub).slice(0, 256);
    if (tombstoneExternalId.length > 0) {
      const tombstone = await prisma.deletedExternalId.findUnique({
        where: {
          tenantId_externalId: {
            tenantId: tenant.id,
            externalId: tombstoneExternalId,
          },
        },
        select: { expiresAt: true },
      });
      if (tombstone && tombstone.expiresAt > new Date()) {
        throw new GoneError("Account has been deleted");
      }
    }

    // Cap string-claim lengths server-side. A tenant minting a name
    // of 100 KB would otherwise inflate every realtime broadcast,
    // every push payload, and every User row. The tenant is supposed
    // to bound these, but we don't trust them on the verify path.
    const name = typeof claims.name === "string" ? claims.name.slice(0, 128) : "";
    if (name.length === 0) {
      throw new UnauthorizedError("Token missing display name");
    }
    const image =
      typeof claims.image === "string" && claims.image.length > 0
        ? claims.image.slice(0, 2048)
        : null;
    const email =
      typeof claims.email === "string" && claims.email.length > 0
        ? claims.email.slice(0, 254)
        : null;
    const externalId = String(claims.sub).slice(0, 256);
    if (externalId.length === 0) {
      throw new UnauthorizedError("Token missing subject");
    }

    // Normalize scope: treat empty string / whitespace as unscoped.
    // The tenant should be deliberate about null-vs-value; a stray
    // empty string from a buggy signer shouldn't carve a phantom
    // partition.
    const rawScope = claims.scope;
    const scope =
      typeof rawScope === "string" && rawScope.trim().length > 0
        ? rawScope.slice(0, 128)
        : null;

    const user = await upsertFederatedUser(tenant.id, {
      externalId,
      name,
      image,
      email,
      scope,
    });

    // Token revocation horizon. Tokens whose `iat` predates
    // `user.tokensValidAfter` are rejected even if signature, audience,
    // and expiry pass. Bumped by GDPR-delete + `POST /me/revoke`.
    if (user.tokensValidAfter && typeof claims.iat === "number") {
      const iatMs = claims.iat * 1000;
      if (iatMs < user.tokensValidAfter.getTime()) {
        throw new UnauthorizedError("Token revoked");
      }
    }

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
