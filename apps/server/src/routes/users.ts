import crypto from "node:crypto";
import { Router } from "express";
import { env } from "../env";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";
import { requireTenantWide } from "../middleware/require-tenant-wide";
import { generalLimiter, searchLimiter } from "../middleware/rate-limit";
import { prisma } from "../db";
import { validate } from "../http/validate";
import {
  OnlineUsersBodySchema,
  TenantUserListQuerySchema,
  UserSearchQuerySchema,
} from "../http/schemas";
import { deleteObject, keyFromPublicUrl } from "../lib/s3";
import { invalidateUserProfile } from "../lib/user-cache";
import { invalidateFederatedUser } from "../lib/user-federation";
import { userScopeFilter } from "../lib/scope-filter";
import { logger } from "../lib/logger";

const router: Router = Router();

// A user counts as "online" if they touched the app within this window.
const ONLINE_WINDOW_MS = 60_000;

function isOnline(lastActiveAt: Date | null | undefined): boolean {
  if (!lastActiveAt) return false;
  return Date.now() - new Date(lastActiveAt).getTime() < ONLINE_WINDOW_MS;
}

// ─── Keyset cursor helpers for tenant user listing ───────────
//
// Opaque base64url blob encoding `(name, id)` — the sort key of the
// last row on the previous page. Short field names keep the cursor
// small for URL-friendly round-trips.
//
// `decode` is defensive: any malformed input (tampered, truncated,
// copied across environments) returns null, and the caller treats
// null as "start from the first page" rather than erroring out.
// That keeps a bad cursor from breaking the UI on refresh.

interface UserListCursor {
  name: string;
  id: string;
}

// Cursor signing key. Derived from a required server secret with a
// fixed domain-separation label so it's stable across restarts without
// introducing a new env var. Signing prevents a client from forging /
// tampering a cursor to seek into arbitrary positions of the sorted set
// (defense-in-depth: the endpoint is already requireTenantWide, but a
// future scoped reuse would otherwise leak past the scope filter).
const CURSOR_KEY = crypto
  .createHash("sha256")
  .update("user-list-cursor-hmac:v1:" + env.CENTRIFUGO_TOKEN_SECRET)
  .digest();

function signCursor(payload: string): string {
  return crypto
    .createHmac("sha256", CURSOR_KEY)
    .update(payload)
    .digest("base64url")
    .slice(0, 24); // 144-bit tag is plenty for tamper-detection
}

function encodeUserListCursor(cursor: UserListCursor): string {
  const payload = Buffer.from(
    JSON.stringify({ n: cursor.name, i: cursor.id }),
    "utf8",
  ).toString("base64url");
  return `${payload}.${signCursor(payload)}`;
}

function decodeUserListCursor(raw: string | undefined): UserListCursor | null {
  if (!raw) return null;
  try {
    const dot = raw.lastIndexOf(".");
    if (dot <= 0) return null;
    const payload = raw.slice(0, dot);
    const sig = raw.slice(dot + 1);
    const expected = signCursor(payload);
    // Constant-time compare; reject any tampered / unsigned cursor.
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (
      parsed &&
      typeof parsed.n === "string" &&
      typeof parsed.i === "string"
    ) {
      return { name: parsed.n, id: parsed.i };
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Search users by name or email ────────────────────────────

router.get(
  "/search",
  requireAuth,
  searchLimiter,
  validate({ query: UserSearchQuerySchema }),
  async (req, res) => {
    const { user, tenantId, scope } = req as AuthenticatedRequest;
    const { q } = req.query as { q: string };

    const users = await prisma.user.findMany({
      where: {
        tenantId,
        id: { not: user.id },
        // Scope isolation: a scoped requester only sees same-scope +
        // tenant-wide users. `userScopeFilter` returns {} for
        // unscoped requesters so this is effectively a no-op for them.
        AND: [userScopeFilter(scope)],
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
        ],
      },
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        lastActiveAt: true,
      },
      take: 20,
    });

    const results = users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      image: u.image,
      lastActiveAt: u.lastActiveAt,
      online: isOnline(u.lastActiveAt),
    }));

    res.json(results);
  },
);

// ─── Tenant-wide user search (cross-scope discovery) ─────────
//
// Mirror of `/search` but without `userScopeFilter`. Callable only by
// tenant-wide identities (`requireTenantWide` rejects scoped requesters
// with 403), so scope stays a real isolation boundary: a scoped user
// cannot reach this endpoint to enumerate users outside their partition.
//
// Reuses `searchLimiter` — same cost profile as `/search` (trigram /
// ILIKE scan with LIMIT 20), same abuse surface.

router.get(
  "/tenant/search",
  requireAuth,
  requireTenantWide,
  searchLimiter,
  validate({ query: UserSearchQuerySchema }),
  async (req, res) => {
    const { user, tenantId } = req as AuthenticatedRequest;
    const { q } = req.query as { q: string };

    const users = await prisma.user.findMany({
      where: {
        tenantId,
        id: { not: user.id },
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
        ],
      },
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        lastActiveAt: true,
      },
      take: 20,
    });

    const results = users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      image: u.image,
      lastActiveAt: u.lastActiveAt,
      online: isOnline(u.lastActiveAt),
    }));

    res.json(results);
  },
);

// ─── Browseable tenant user listing ──────────────────────────
//
// Keyset-paginated listing intended for UIs that want to scroll
// through every user in the tenant (search-as-you-type caps at 20
// and isn't browseable past that). Ordered by `name ASC, id ASC`
// for a stable total order — id is the tiebreaker when two users
// share a name so the cursor remains unambiguous.
//
// Why keyset over offset:
//   - Constant-time per page. Offset pagination does a Postgres
//     skip of N rows per request; a deep page at offset=10000 has
//     to scan (and discard) 10000 rows every time.
//   - Stable under inserts. If a new user is created while the
//     client is paginating, offset pagination shifts the window
//     and can duplicate or skip rows. Keyset reads from "after the
//     last name/id I saw" and is immune.
//
// Behind `requireTenantWide` — only unscoped identities can
// enumerate the full tenant. Reuses `searchLimiter` because the
// cost profile (ordered scan + LIMIT) is similar to `/search`.

router.get(
  "/tenant",
  requireAuth,
  requireTenantWide,
  searchLimiter,
  validate({ query: TenantUserListQuerySchema }),
  async (req, res) => {
    const { user, tenantId } = req as AuthenticatedRequest;
    const { cursor: rawCursor, limit: limitParam } = req.query as {
      cursor?: string;
      limit?: number;
    };

    const limit = limitParam ?? 50;
    const cursor = decodeUserListCursor(rawCursor);

    // Compound keyset predicate:
    //   (name, id) > (cursor.name, cursor.id)
    // expressed as Prisma OR since there's no tuple-compare operator
    // in the client. Matches the ORDER BY clause exactly so the
    // index pushdown stays correct.
    const keysetFilter = cursor
      ? {
          OR: [
            { name: { gt: cursor.name } },
            { name: cursor.name, id: { gt: cursor.id } },
          ],
        }
      : {};

    // take `limit + 1` as a "has more" probe: if we get limit+1 rows,
    // there's another page and we slice off the sentinel before
    // returning. Avoids a separate count query.
    const rows = await prisma.user.findMany({
      where: {
        tenantId,
        id: { not: user.id },
        ...keysetFilter,
      },
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        lastActiveAt: true,
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeUserListCursor({ name: last.name, id: last.id })
        : null;

    const users = page.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      image: u.image,
      lastActiveAt: u.lastActiveAt,
      online: isOnline(u.lastActiveAt),
    }));

    res.json({ users, nextCursor });
  },
);

// ─── Get online status for a list of user IDs ─────────────────

router.post(
  "/online",
  requireAuth,
  generalLimiter,
  validate({ body: OnlineUsersBodySchema }),
  async (req, res) => {
    const { tenantId, scope } = req as AuthenticatedRequest;
    const { userIds } = req.body as { userIds: string[] };

    const users = await prisma.user.findMany({
      where: {
        tenantId,
        id: { in: userIds },
        AND: [userScopeFilter(scope)],
      },
      select: { id: true, lastActiveAt: true },
    });

    const onlineIds = users
      .filter((u) => isOnline(u.lastActiveAt))
      .map((u) => u.id);
    res.json({ online: onlineIds });
  },
);

// ─── DELETE /api/users/me ─────────────────────────────────────
//
// GDPR "right to be forgotten". Deletes the user row; all child rows
// (sessions, accounts, conversation members, messages the user sent,
// attachments they uploaded, reactions, push subscriptions) are removed
// automatically via `onDelete: Cascade` in the schema.
//
// S3 objects are not referenced by FK, so we enumerate them BEFORE the
// cascade (we lose uploaderId → key mapping after) and delete them
// async post-response. A fire-and-forget S3 failure just leaves orphan
// bytes that the daily `gcOrphanAttachments` cron sweeps.
//
// A structured audit log is emitted so compliance can trace the
// deletion without needing DB forensics.

// POST /api/users/me/revoke
// "Log out everywhere" primitive. Bumps the user's `tokensValidAfter`
// to NOW(), causing every existing JWT (across every device, browser
// tab, mobile app) to be rejected on the next request — even if the
// tenant keeps minting fresh ones with old `iat` values. The next
// legitimate login (`iat` ≥ now) re-enables access. Use cases: lost
// device, suspected token leak, mandatory re-auth after sensitive
// change.
router.post("/me/revoke", requireAuth, generalLimiter, async (req, res) => {
  const { user, tenantId } = req as AuthenticatedRequest;
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { tokensValidAfter: new Date() },
    select: { externalId: true },
  });
  // Invalidate BOTH caches so the next request re-reads the new
  // `tokensValidAfter` from DB. Without this, the fed-user cache hit
  // returns a stale row for up to its TTL and revocation silently
  // doesn't take effect.
  await invalidateUserProfile(user.id);
  await invalidateFederatedUser(tenantId, updated.externalId);
  res.json({ ok: true });
});

router.delete("/me", requireAuth, generalLimiter, async (req, res) => {
  const { user, tenantId } = req as AuthenticatedRequest;

  // 1. Enumerate S3 keys for attachments owned by this user before the
  //    cascade wipes the rows. `tenantId` is redundant given uploaderId
  //    is already tenant-scoped, but explicit beats implicit.
  const attachments = await prisma.attachment.findMany({
    where: { tenantId, uploaderId: user.id },
    select: { url: true },
  });
  const s3Keys: string[] = [];
  for (const a of attachments) {
    const k = keyFromPublicUrl(a.url);
    if (k) s3Keys.push(k);
  }

  // 2. Fetch the externalId so we can write a tombstone before the
  //    User row disappears. Without this, the next authenticated
  //    request from the tenant's still-valid JWT would silently
  //    re-materialize this user via `upsertFederatedUser` — defeating
  //    GDPR's right-to-be-forgotten. The tombstone makes deletion
  //    sticky for 30 days; after that, the same externalId is free to
  //    re-register (e.g. user signs up again with the same tenant).
  const me = await prisma.user.findUnique({
    where: { id: user.id },
    select: { externalId: true },
  });

  // 3. Delete the user row. Cascade handles every other table per the
  //    schema; if this throws, nothing has been mutated yet. `deleteMany`
  //    + tenantId lets us defend against a hypothetical userId collision
  //    across tenants (UUIDs make that astronomically unlikely, but the
  //    check costs nothing).
  await prisma.user.deleteMany({ where: { id: user.id, tenantId } });

  if (me?.externalId) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    await prisma.deletedExternalId.upsert({
      where: {
        tenantId_externalId: { tenantId, externalId: me.externalId },
      },
      create: { tenantId, externalId: me.externalId, deletedAt: now, expiresAt },
      update: { deletedAt: now, expiresAt },
    });
    // Drop the fed-user cache entry so an in-flight request after the
    // delete doesn't hit the cache and skip the tombstone check.
    await invalidateFederatedUser(tenantId, me.externalId);
  }

  // 3. Invalidate caches: profile, session (the in-flight request
  //    already has a valid session but it's about to be gone).
  await invalidateUserProfile(user.id);

  // 4. Post-cutover: no more session cookies to clear. Tenant must
  //    stop issuing JWTs for this externalId (our JWT middleware
  //    would 404 anyway once the User row is gone).

  // 5. Fire-and-forget S3 cleanup. Doesn't block the response; any
  //    failures here are picked up by the orphan GC cron.
  if (s3Keys.length > 0) {
    (async () => {
      for (const key of s3Keys) {
        await deleteObject(key).catch((err) =>
          logger.warn("gdpr: s3 delete failed", {
            userId: user.id,
            key,
            err: err as Error,
          }),
        );
      }
    })();
  }

  // 6. Audit log. Emit at info level so it lands in the primary log
  //    stream and can be filtered for compliance reports.
  logger.info("gdpr: user deleted", {
    userId: user.id,
    email: user.email,
    attachmentsDeleted: s3Keys.length,
  });

  res.json({ ok: true });
});

export default router;
