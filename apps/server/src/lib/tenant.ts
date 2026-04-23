import crypto from "node:crypto";
import argon2 from "argon2";
import { prisma } from "../db";
import { env } from "../env";
import { logger } from "./logger";
import { CACHE_NS, cacheDel, cacheGet, cacheSet } from "./cache";

/**
 * Tenant management. A Tenant is a third-party app that uses this chat
 * server; every chat entity (User, Conversation, Message, …) is scoped
 * to exactly one tenant.
 *
 * Two secrets per tenant:
 *   - `apiKey` — surfaced once at create/rotate, never stored raw.
 *     Argon2-hashed in `Tenant.apiKeyHash`. Used by the tenant's backend
 *     to call server-to-server endpoints (webhooks, admin operations).
 *     First 8 chars are stored in `apiKeyPrefix` (indexed) so auth is
 *     O(log N tenants) + 1 Argon2 verify instead of N verifies.
 *   - `jwtSecret` — stored wrapped (AES-256-GCM) if
 *     `JWT_SECRET_ENCRYPTION_KEY` is set, plaintext otherwise. HMAC
 *     verification still needs the plaintext in memory; the wrap is a
 *     DB-leak defense.
 *
 * Rotation is key-replace, not key-additional: after rotation the old
 * value stops working immediately. Callers must coordinate the swap
 * with their tenant-side config.
 */

const API_KEY_PREFIX_LEN = 8;

/** Random 32 bytes → 43-char base64url. Plenty for an API key. */
function generateRandomKey(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

/**
 * Argon2id parameters tuned for auth — moderate cost so api-key lookups
 * stay under ~50ms on modern hardware. The hash is stored in
 * `Tenant.apiKeyHash`.
 */
const ARGON2_OPTS = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

async function hashApiKey(raw: string): Promise<string> {
  return argon2.hash(raw, ARGON2_OPTS);
}

export async function verifyApiKey(raw: string, hash: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, raw);
  } catch {
    return false;
  }
}

// ─── jwtSecret at-rest envelope encryption ───────────────────────
//
// Format of a wrapped secret: `enc:v1:<iv_b64url>:<ct_b64url>:<tag_b64url>`.
// AES-256-GCM with a random 12-byte IV per wrap. The key comes from
// `JWT_SECRET_ENCRYPTION_KEY` (base64, 32 bytes). Rows produced before
// the env var was set are stored plaintext — `unwrapSecret` detects the
// `enc:v1:` prefix and decides.

const ENC_PREFIX = "enc:v1:";

function encryptionKey(): Buffer | null {
  const b64 = env.JWT_SECRET_ENCRYPTION_KEY;
  if (!b64) return null;
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) {
    logger.error(
      "[tenant] JWT_SECRET_ENCRYPTION_KEY must be 32 bytes (base64). Ignoring; secrets will be stored plaintext.",
      { len: key.length },
    );
    return null;
  }
  return key;
}

export function wrapSecret(plain: string): string {
  const key = encryptionKey();
  if (!key) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return (
    ENC_PREFIX +
    iv.toString("base64url") +
    ":" +
    ct.toString("base64url") +
    ":" +
    tag.toString("base64url")
  );
}

export function unwrapSecret(stored: string): string {
  if (!stored.startsWith(ENC_PREFIX)) return stored; // legacy plaintext
  const key = encryptionKey();
  if (!key) {
    throw new Error(
      "JWT_SECRET_ENCRYPTION_KEY must be set to decrypt wrapped tenant secrets",
    );
  }
  const parts = stored.slice(ENC_PREFIX.length).split(":");
  if (parts.length !== 3) throw new Error("Malformed wrapped secret");
  const iv = Buffer.from(parts[0], "base64url");
  const ct = Buffer.from(parts[1], "base64url");
  const tag = Buffer.from(parts[2], "base64url");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

function prefixOf(raw: string): string {
  return raw.slice(0, API_KEY_PREFIX_LEN);
}

export interface CreatedTenant {
  id: string;
  name: string;
  /** Shown exactly once. Tenants MUST persist this client-side — lost
   *  keys require rotation. */
  apiKey: string;
  /** Shown once. Signing secret for tenant's user JWTs. */
  jwtSecret: string;
}

/**
 * Create a fresh tenant with newly-generated api-key + jwt-secret.
 * Caller (admin endpoint) must surface the raw values exactly once.
 */
export async function createTenant(name: string): Promise<CreatedTenant> {
  const apiKey = generateRandomKey();
  const jwtSecret = generateRandomKey();
  const apiKeyHash = await hashApiKey(apiKey);

  const tenant = await prisma.tenant.create({
    data: {
      name,
      apiKeyHash,
      apiKeyPrefix: prefixOf(apiKey),
      jwtSecret: wrapSecret(jwtSecret),
    },
    select: { id: true, name: true },
  });

  return { id: tenant.id, name: tenant.name, apiKey, jwtSecret };
}

/**
 * Rotate a tenant's API key. Old key stops working immediately.
 * Returns the new raw key (surfaced once).
 */
export async function rotateApiKey(tenantId: string): Promise<string> {
  const apiKey = generateRandomKey();
  const apiKeyHash = await hashApiKey(apiKey);
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { apiKeyHash, apiKeyPrefix: prefixOf(apiKey) },
  });
  // apiKey doesn't live in the tenant cache, but the cached row has a
  // copy of the Tenant struct that the webhook/middleware code might
  // look up by tenantId. Safe to invalidate anyway — cheap + instant.
  await invalidateTenant(tenantId);
  return apiKey;
}

/**
 * Rotate a tenant's JWT signing secret. Every currently-issued user
 * token is invalidated at the same moment — tenants should coordinate
 * the swap across their own backend.
 */
export async function rotateJwtSecret(tenantId: string): Promise<string> {
  const jwtSecret = generateRandomKey();
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { jwtSecret: wrapSecret(jwtSecret) },
  });
  // Must invalidate — every live JWT signed with the old secret is
  // about to fail verification, and we don't want cached entries
  // keeping the old secret live for 30s while clients flap.
  await invalidateTenant(tenantId);
  return jwtSecret;
}

/**
 * Look up a tenant by presented API key.
 *
 * Two-tier lookup:
 *   1. Fast path: filter tenants to those with the matching
 *      `apiKeyPrefix`. Typically exactly one row. O(log N) on the
 *      index + 1 Argon2 verify.
 *   2. Fallback: legacy tenants stored before the prefix column was
 *      added have `apiKeyPrefix = NULL`. Iterate just those and verify.
 *      As legacy keys are rotated, the fallback set shrinks to empty.
 *
 * Both tiers use Argon2 verify, so a valid key is always accepted even
 * if its prefix cache is stale for some reason.
 */
export async function findTenantByApiKey(rawKey: string): Promise<{
  id: string;
  jwtSecret: string;
} | null> {
  if (!rawKey) return null;

  // 1. Indexed prefix lookup.
  const prefix = prefixOf(rawKey);
  const prefixMatches = await prisma.tenant.findMany({
    where: { apiKeyPrefix: prefix },
    select: { id: true, apiKeyHash: true, jwtSecret: true },
  });
  for (const t of prefixMatches) {
    if (await verifyApiKey(rawKey, t.apiKeyHash)) {
      return { id: t.id, jwtSecret: unwrapSecret(t.jwtSecret) };
    }
  }

  // 2. Legacy rows with NULL prefix (rotated away over time).
  const legacy = await prisma.tenant.findMany({
    where: { apiKeyPrefix: null },
    select: { id: true, apiKeyHash: true, jwtSecret: true },
  });
  for (const t of legacy) {
    if (await verifyApiKey(rawKey, t.apiKeyHash)) {
      return { id: t.id, jwtSecret: unwrapSecret(t.jwtSecret) };
    }
  }

  return null;
}

interface CachedTenant {
  id: string;
  /** Unwrapped — ready to HMAC-verify a JWT with. Never store the
   *  `enc:v1:...` ciphertext in cache; that would defeat the fast path. */
  jwtSecret: string;
}

export async function getTenantById(tenantId: string): Promise<CachedTenant | null> {
  const cached = await cacheGet<CachedTenant>(CACHE_NS.tenant, tenantId);
  if (cached !== null) return cached;

  const row = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, jwtSecret: true },
  });
  if (!row) return null;
  const resolved: CachedTenant = {
    id: row.id,
    jwtSecret: unwrapSecret(row.jwtSecret),
  };
  await cacheSet(CACHE_NS.tenant, tenantId, resolved);
  return resolved;
}

/** Purge the tenant cache entry for instant rotation effect.
 *  TTL bounds the window to ~30s anyway; this makes it immediate. */
export async function invalidateTenant(tenantId: string): Promise<void> {
  await cacheDel(CACHE_NS.tenant, tenantId);
}
