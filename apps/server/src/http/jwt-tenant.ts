import jwt from "jsonwebtoken";
import { env } from "../env";

/** Single-purpose audience claim — tokens minted with this value are
 *  scoped to chat-app and cannot be replayed against unrelated
 *  services that happen to share a tenant's HMAC secret. */
export const TENANT_JWT_AUDIENCE = "chat-app";

/** Upper bound on tenant-minted token lifetime enforced at verify
 *  time. A tenant minting a 30-day token would otherwise widen the
 *  blast radius of any token leak. */
export const MAX_TENANT_TOKEN_TTL_SEC = 60 * 60; // 1 hour

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
 *   scope       — optional second-level partition inside the tenant.
 *                 Non-null restricts user discovery + add-member to
 *                 peers with the same scope (or unscoped tenant-wide
 *                 users). Null/absent = tenant-wide.
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
  scope?: string | null;
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
    scope?: string | null;
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
      // Only include `scope` in the JWT if the caller actually passed
      // one — leaving it undefined keeps tokens minimal and prevents
      // accidental "scope: null" signals from being stamped on tokens
      // the tenant didn't mean to scope.
      ...(claims.scope !== undefined ? { scope: claims.scope } : {}),
    },
    jwtSecret,
    {
      issuer: tenantId,
      audience: TENANT_JWT_AUDIENCE,
      expiresIn: ttl,
      algorithm: "HS256",
    },
  );
}

/**
 * Verify a tenant-issued user token. Throws on signature / expiry /
 * format / issuer / audience failure (caller should catch and respond
 * 401).
 *
 * Returns the decoded claims; the `iss` field is the tenant id — the
 * caller uses it to pick the right `jwtSecret` out of the Tenant cache
 * BEFORE calling this function. That means verification is:
 *   1. decode un-verified to read `iss`
 *   2. look up tenant.jwtSecret
 *   3. verify with that secret + assert `iss` matches the tenant we
 *      looked up + assert `aud === "chat-app"`
 *
 * The explicit `expectedIssuer` argument closes a defense-in-depth
 * gap: prior to this, the un-verified `iss` *selected* the secret,
 * but the post-verify path never re-confirmed the verified `iss`
 * equaled the tenant id we'd routed against. A future refactor that
 * cached secrets under a different key would have silently
 * mis-attributed users.
 */
export function verifyUserToken(
  token: string,
  jwtSecret: string,
  expectedIssuer: string,
): TenantUserClaims {
  const decoded = jwt.verify(token, jwtSecret, {
    algorithms: ["HS256"],
    issuer: expectedIssuer,
    audience: TENANT_JWT_AUDIENCE,
    clockTolerance: env.TENANT_JWT_CLOCK_SKEW_SEC,
  });
  if (typeof decoded === "string" || !decoded || !decoded.sub || !decoded.iss) {
    throw new Error("Invalid user token payload");
  }
  if (decoded.iss !== expectedIssuer) {
    // Belt-and-braces: jwt.verify already enforces this via the
    // `issuer` option, but reassert here so the contract is explicit
    // and the code is robust to library upgrades.
    throw new Error("Token issuer mismatch");
  }
  // Bound tenant-minted token lifetime server-side. A tenant minting
  // a 24h+ token would otherwise widen the blast radius of any leak.
  if (
    typeof decoded.iat === "number" &&
    typeof decoded.exp === "number" &&
    decoded.exp - decoded.iat > MAX_TENANT_TOKEN_TTL_SEC
  ) {
    throw new Error("Token TTL exceeds server-enforced maximum");
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
