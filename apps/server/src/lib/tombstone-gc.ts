import { prisma } from "../db";

/**
 * GDPR deletion-tombstone GC.
 *
 * `DELETE /api/users/me` writes a `DeletedExternalId` row that makes the
 * deletion "sticky": for 30 days the same `(tenantId, externalId)` cannot
 * be silently re-materialized from a still-valid tenant JWT (enforced in
 * `middleware/require-user-jwt.ts` via the `expiresAt > now` check → 410).
 *
 * Once `expiresAt` has passed the row is never consulted again, so it is
 * dead weight. This job purges expired tombstones to keep the table
 * bounded and honor data-minimization (CASA/ASVS V8.3). The migration
 * that introduced the table promised a nightly sweep — this is it.
 *
 * Idempotent and safe to run concurrently across instances: expired-row
 * deletes race harmlessly (losers see a 0-row delete).
 */
export async function gcExpiredTombstones(): Promise<{ deleted: number }> {
  const { count } = await prisma.deletedExternalId.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return { deleted: count };
}
