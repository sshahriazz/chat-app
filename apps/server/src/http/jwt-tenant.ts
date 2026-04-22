import jwt from "jsonwebtoken";
import { env } from "../env";

/**
 * Tenant-issued user JWTs.
 *
 * The tenant's backend signs these with their `jwtSecret` when their
 * end-user needs to talk to the chat server. We verify on every
 * request — no DB lookup for the token itself, just the tenant (cached
 * by `requireUserJwt`'s code path).
 *
 * Claims:
 *   sub         — the tenant's own user id (our `User.externalId`)
 *   name        — display name (embedded in realtime events)
 *   image       — avatar URL (embedded in events)
 *   email       — optional, display-only
 *   iss         — tenant id; picks which secret to verify with
 *   exp         — enforced; tenants should mint short (≤ 24h) tokens
 *
 * We deliberately DON'T put internal chat-server user ids in here —
 * the `externalId` round-trips to/from the tenant naturally, and the
 * middleware resolves it to an internal id via `upsertFederatedUser`.
 */

export interface TenantUserClaims {
  sub: string; // externalId
  name: string;
  image?: string | null;
  email?: string | null;
  iss: string; // tenantId
  iat: number;
  exp: number;
}

/** Mint a token. Used in dev by the reference client's
 *  `/api/dev/mint-token` route; tenants mint their own in production. */
export function mintUserToken(
  tenantId: string,
  jwtSecret: string,
  claims: {
    externalId: string;
    name: string;
    image?: string | null;
    email?: string | null;
    ttlSeconds?: number;
  },
): string {
  const ttl = claims.ttlSeconds ?? 60 * 60; // 1h default
  return jwt.sign(
    {
      sub: claims.externalId,
      name: claims.name,
      image: claims.image ?? undefined,
      email: claims.email ?? undefined,
    },
    jwtSecret,
    {
      issuer: tenantId,
      expiresIn: ttl,
      algorithm: "HS256",
    },
  );
}

/**
 * Verify a tenant-issued user token. Throws on signature / expiry /
 * format failure (caller should catch and respond 401).
 *
 * Returns the decoded claims; the `iss` field is the tenant id — the
 * caller uses it to pick the right `jwtSecret` out of the Tenant cache
 * BEFORE calling this function. That means verification is:
 *   1. decode un-verified to read `iss`
 *   2. look up tenant.jwtSecret
 *   3. verify with that secret
 */
export function verifyUserToken(
  token: string,
  jwtSecret: string,
): TenantUserClaims {
  const decoded = jwt.verify(token, jwtSecret, {
    algorithms: ["HS256"],
    clockTolerance: env.TENANT_JWT_CLOCK_SKEW_SEC,
  });
  if (typeof decoded === "string" || !decoded || !decoded.sub || !decoded.iss) {
    throw new Error("Invalid user token payload");
  }
  return decoded as TenantUserClaims;
}

/** Peek at the token's `iss` claim WITHOUT verifying signature. Used
 *  to pick the right tenant before we fetch their jwtSecret. Do not
 *  trust any other field from this output. */
export function peekTokenIssuer(token: string): string | null {
  const decoded = jwt.decode(token);
  if (!decoded || typeof decoded === "string") return null;
  const iss = (decoded as { iss?: unknown }).iss;
  return typeof iss === "string" ? iss : null;
}
