import crypto from "node:crypto";
import { prisma } from "../db";
import type { TenantUserClaims } from "../http/jwt-tenant";
import { logger } from "../infra/logger";
import * as centrifugo from "./centrifugo";
import { invalidateUserProfile } from "./user-cache";
import { CACHE_NS, cacheDel, cacheGet, cacheSet } from "./cache";

/**
 * User federation — bridge between a tenant's own user model and this
 * server's `User` rows.
 *
 * A tenant-issued user JWT carries the tenant's user id (`sub` →
 * `externalId`) plus display metadata (name/image/email). Our User
 * table stores a row keyed `(tenantId, externalId)` that mirrors those
 * claims; every other FK in the system points at our server-internal
 * `User.id` (UUID), so once a User row is materialized, the rest of
 * the code works unchanged.
 *
 * Three call paths for materialization:
 *   1. `requireUserJwt` middleware — on every browser request, verify
 *      the JWT and upsert the User row so name/image changes propagate
 *      lazily.
 *   2. `POST /api/webhooks/users.updated` — tenant pushes a profile
 *      change; we update eagerly and broadcast a `user_updated` event
 *      to live peers (retained "live update" mode, per product choice).
 *   3. `POST /api/webhooks/users.deleted` — tenant notifies us that a
 *      user is gone; we cascade-delete + clean up attachments.
 */

export interface FederatedUserInput {
  externalId: string;
  name: string;
  image?: string | null;
  email?: string | null;
  /** Optional second-level partition inside the tenant. Null = tenant-wide. */
  scope?: string | null;
}

export interface MaterializedUser {
  id: string;
  tenantId: string;
  externalId: string;
  name: string;
  image: string | null;
  email: string | null;
  scope: string | null;
}

/**
 * Upsert a User row from the tenant's claims. Called from the JWT
 * middleware on every request — must be fast. Writes only when the
 * incoming metadata differs from what's stored.
 */
/**
 * Deterministic short hash of the tenant-visible claim tuple. Stored
 * alongside the cached `MaterializedUser` so the middleware can skip
 * the DB entirely when the JWT presents the same claims as last time.
 *
 * `scope: undefined` means "tenant didn't send one this time; don't
 * touch the stored scope." We hash `"__undef__"` as a sentinel so two
 * minted tokens — one with scope set, one without — don't collide.
 */
function claimHash(input: FederatedUserInput): string {
  const parts = [
    input.externalId,
    input.name,
    input.image ?? "",
    input.email ?? "",
    input.scope === undefined ? "__undef__" : (input.scope ?? "__null__"),
  ];
  return crypto.createHash("sha256").update(parts.join("\x1f")).digest("hex");
}

interface CachedFederatedUser extends MaterializedUser {
  /** Hash of the claims that produced this row. Fast-path hit only
   *  when the incoming JWT's claimHash matches. */
  hash: string;
}

function fedKey(tenantId: string, externalId: string): string {
  return `${tenantId}:${externalId}`;
}

/** Purge the cached federation entry so the next auth goes back to DB.
 *  Called from webhook updates + user deletes. */
export async function invalidateFederatedUser(
  tenantId: string,
  externalId: string,
): Promise<void> {
  await cacheDel(CACHE_NS.fedUser, fedKey(tenantId, externalId));
}

export async function upsertFederatedUser(
  tenantId: string,
  claims: FederatedUserInput,
): Promise<MaterializedUser> {
  const hash = claimHash(claims);

  // ── Cache fast path: same claims as last time → zero DB traffic ──
  //
  // Hit rate in steady state is >90% for an active session (same user
  // hammering the API with the same JWT claims). The 60s TTL bounds
  // the staleness of profile changes that came in via some path we
  // didn't explicitly invalidate; webhook + broadcast-profile both
  // purge immediately.
  const cached = await cacheGet<CachedFederatedUser>(
    CACHE_NS.fedUser,
    fedKey(tenantId, claims.externalId),
  );
  if (cached && cached.hash === hash) {
    const { hash: _h, ...user } = cached;
    return user;
  }

  // Hot path: the row already exists and nothing changed. Skip the write
  // so a browser session hammering the API at N req/s doesn't translate
  // into N UPDATEs on the user row.
  const existing = await prisma.user.findUnique({
    where: { tenantId_externalId: { tenantId, externalId: claims.externalId } },
    select: {
      id: true, tenantId: true, externalId: true,
      name: true, image: true, email: true, scope: true,
    },
  });

  if (existing) {
    const nameChanged = existing.name !== claims.name;
    const imageChanged = (existing.image ?? null) !== (claims.image ?? null);
    const emailChanged =
      claims.email !== undefined && (claims.email ?? null) !== (existing.email ?? null);
    // Only treat scope as "changed" when the caller explicitly supplied
    // one. `scope: undefined` means "don't touch" so a webhook that
    // doesn't know the scope can still update name/image without
    // accidentally promoting a scoped user to tenant-wide.
    const scopeProvided = claims.scope !== undefined;
    const scopeChanged =
      scopeProvided && (existing.scope ?? null) !== (claims.scope ?? null);

    let result: MaterializedUser;
    if (!nameChanged && !imageChanged && !emailChanged && !scopeChanged) {
      result = {
        id: existing.id,
        tenantId: existing.tenantId,
        externalId: existing.externalId,
        name: existing.name,
        image: existing.image ?? null,
        email: existing.email ?? null,
        scope: existing.scope ?? null,
      };
    } else {
      const updated = await prisma.user.update({
        where: { tenantId_externalId: { tenantId, externalId: claims.externalId } },
        data: {
          name: claims.name,
          image: claims.image ?? null,
          ...(emailChanged ? { email: claims.email ?? null } : {}),
          ...(scopeChanged ? { scope: claims.scope ?? null } : {}),
          updatedAt: new Date(),
        },
        select: {
          id: true, tenantId: true, externalId: true,
          name: true, image: true, email: true, scope: true,
        },
      });
      await invalidateUserProfile(updated.id);
      result = {
        id: updated.id,
        tenantId: updated.tenantId,
        externalId: updated.externalId,
        name: updated.name,
        image: updated.image ?? null,
        email: updated.email ?? null,
        scope: updated.scope ?? null,
      };
    }
    await cacheSet<CachedFederatedUser>(
      CACHE_NS.fedUser,
      fedKey(tenantId, claims.externalId),
      { ...result, hash },
    );
    return result;
  }

  // First-time materialization. `upsert` compiles to Postgres
  // `INSERT ... ON CONFLICT (...) DO UPDATE` so two requests from the
  // same tenant+externalId racing on first login both succeed — one
  // INSERTs, the other is a no-op UPDATE that still returns the row.
  // Prior code used `findUnique`-then-`create`, which raced with a 500.
  const id = crypto.randomUUID();
  const row = await prisma.user.upsert({
    where: { tenantId_externalId: { tenantId, externalId: claims.externalId } },
    create: {
      id,
      tenantId,
      externalId: claims.externalId,
      name: claims.name,
      image: claims.image ?? null,
      email: claims.email ?? null,
      scope: claims.scope ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    update: {
      // Loser-of-the-race path: the row exists already. Touching
      // updatedAt is enough; the winner already wrote the claims.
      updatedAt: new Date(),
    },
    select: {
      id: true, tenantId: true, externalId: true,
      name: true, image: true, email: true, scope: true,
    },
  });
  const result: MaterializedUser = {
    id: row.id,
    tenantId: row.tenantId,
    externalId: row.externalId,
    name: row.name,
    image: row.image ?? null,
    email: row.email ?? null,
    scope: row.scope ?? null,
  };
  await cacheSet<CachedFederatedUser>(
    CACHE_NS.fedUser,
    fedKey(tenantId, claims.externalId),
    { ...result, hash },
  );
  return result;
}

/**
 * Tenant-initiated profile update. Upserts the row + broadcasts a
 * `user_updated` event to every peer who shares a conversation with
 * this user so their rendered avatars / names refresh in real time.
 *
 * Matches today's `/me/broadcast-profile` semantics so consumers of
 * the realtime event don't need to change.
 */
export async function applyTenantUserUpdate(
  tenantId: string,
  input: FederatedUserInput,
): Promise<MaterializedUser> {
  // Webhooks are an authoritative push from the tenant — bypass any
  // cached fast-path match so this write always hits DB and the fresh
  // values overwrite both DB and cache. Cheap; webhooks are low volume.
  await invalidateFederatedUser(tenantId, input.externalId);

  const user = await upsertFederatedUser(tenantId, input);

  // Peers to notify: every user who shares at least one conversation
  // with this user, plus the user themselves (multi-tab sync). Mirrors
  // the set used by today's `/me/broadcast-profile`.
  const rows = await prisma.conversationMember.findMany({
    where: { conversation: { members: { some: { userId: user.id } } } },
    select: { userId: true },
    distinct: ["userId"],
  });

  const channels = rows.map((r) => centrifugo.userChannel(r.userId));
  if (channels.length > 0) {
    await centrifugo
      .broadcast(
        channels,
        {
          type: "user_updated",
          user: { id: user.id, name: user.name, image: user.image },
        },
        { idempotencyKey: `user_updated_${user.id}_${Date.now()}` },
      )
      .catch((err) =>
        logger.error(
          { err: { message: (err as Error).message }, userId: user.id },
          "[user-federation] broadcast failed",
        ),
      );
  }

  return user;
}

/**
 * Tenant-initiated user deletion. Cascade-deletes the User row (Postgres
 * FKs clean up sessions, accounts, conversation memberships, messages,
 * reactions, attachments, push subs). S3 objects are left to the
 * existing orphan GC — doing the S3 delete inline would block the
 * webhook response for large histories.
 */
export async function deleteFederatedUser(
  tenantId: string,
  externalId: string,
): Promise<{ deleted: boolean }> {
  const row = await prisma.user.findUnique({
    where: { tenantId_externalId: { tenantId, externalId } },
    select: { id: true },
  });
  if (!row) return { deleted: false };

  await prisma.user.delete({ where: { id: row.id } });
  await invalidateUserProfile(row.id);
  await invalidateFederatedUser(tenantId, externalId);
  return { deleted: true };
}
