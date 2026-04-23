import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";
import { generalLimiter, searchLimiter } from "../middleware/rate-limit";
import { prisma } from "../db";
import { validate } from "../http/validate";
import {
  OnlineUsersBodySchema,
  UserSearchQuerySchema,
} from "../http/schemas";
import { deleteObject, keyFromPublicUrl } from "../lib/s3";
import { invalidateUserProfile } from "../lib/user-cache";
import { userScopeFilter } from "../lib/scope-filter";
import { logger } from "../lib/logger";

const router: Router = Router();

// A user counts as "online" if they touched the app within this window.
const ONLINE_WINDOW_MS = 60_000;

function isOnline(lastActiveAt: Date | null | undefined): boolean {
  if (!lastActiveAt) return false;
  return Date.now() - new Date(lastActiveAt).getTime() < ONLINE_WINDOW_MS;
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

  // 2. Delete the user row. Cascade handles every other table per the
  //    schema; if this throws, nothing has been mutated yet. `deleteMany`
  //    + tenantId lets us defend against a hypothetical userId collision
  //    across tenants (UUIDs make that astronomically unlikely, but the
  //    check costs nothing).
  await prisma.user.deleteMany({ where: { id: user.id, tenantId } });

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
