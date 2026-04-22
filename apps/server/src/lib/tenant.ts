import crypto from "node:crypto";
import argon2 from "argon2";
import { prisma } from "../db";

/**
 * Tenant management. A Tenant is a third-party app that uses this chat
 * server; every chat entity (User, Conversation, Message, …) is scoped
 * to exactly one tenant.
 *
 * Two secrets per tenant:
 *   - `apiKey` — surfaced once at create/rotate, never stored raw.
 *     Argon2-hashed in `Tenant.apiKeyHash`. Used by the tenant's backend
 *     to call server-to-server endpoints (webhooks, admin operations).
 *   - `jwtSecret` — stored raw (HMAC requires the plaintext to verify).
 *     Used to sign short-lived user JWTs; the chat server verifies
 *     them in `requireUserJwt`.
 *
 * Rotation is key-replace, not key-additional: after rotation the old
 * value stops working immediately. Callers must coordinate the swap
 * with their tenant-side config.
 */

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
    data: { name, apiKeyHash, jwtSecret },
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
    data: { apiKeyHash },
  });
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
    data: { jwtSecret },
  });
  return jwtSecret;
}

/**
 * Look up a tenant by presented API key. Returns the tenant id (or null).
 * Iterates tenants and Argon2-verifies — O(N tenants) per auth call,
 * which is fine up to a few thousand tenants. For larger deployments,
 * index-by-prefix or switch to token-binding.
 */
export async function findTenantByApiKey(rawKey: string): Promise<{
  id: string;
  jwtSecret: string;
} | null> {
  if (!rawKey) return null;
  const tenants = await prisma.tenant.findMany({
    select: { id: true, apiKeyHash: true, jwtSecret: true },
  });
  for (const t of tenants) {
    if (await verifyApiKey(rawKey, t.apiKeyHash)) {
      return { id: t.id, jwtSecret: t.jwtSecret };
    }
  }
  return null;
}

export async function getTenantById(tenantId: string): Promise<{
  id: string;
  jwtSecret: string;
} | null> {
  return prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, jwtSecret: true },
  });
}
