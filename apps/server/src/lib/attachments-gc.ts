import { prisma } from "../db";
import { deleteObject, keyFromPublicUrl } from "./s3";

/**
 * Orphan attachment GC.
 *
 * An attachment is an orphan when it was presigned + uploaded to S3 but
 * never linked to a message. Common causes: user cancelled the send,
 * browser crashed mid-upload, or the send HTTP failed.
 *
 * We only delete rows that have been orphaned for at least `olderThanMs`
 * (default 24 h) so active compose sessions aren't disrupted.
 *
 * Safe to run concurrently across instances — the per-row delete is
 * idempotent (race losers see 0-row updates).
 */
export async function gcOrphanAttachments(
  olderThanMs: number = 24 * 60 * 60 * 1000,
): Promise<{ deleted: number; s3Errors: number }> {
  const cutoff = new Date(Date.now() - olderThanMs);

  const orphans = await prisma.attachment.findMany({
    where: {
      messageId: null,
      createdAt: { lt: cutoff },
    },
    // Cap so a single run can't starve the DB on catch-up.
    take: 1000,
    select: { id: true, url: true },
  });

  if (orphans.length === 0) {
    return { deleted: 0, s3Errors: 0 };
  }

  let s3Errors = 0;
  // Sequential to avoid hammering the object-storage endpoint; at ~10ms/op
  // a backlog of 1000 clears in ~10s, fine for a 6-hourly job.
  for (const row of orphans) {
    const key = keyFromPublicUrl(row.url);
    if (!key) continue;
    try {
      await deleteObject(key);
    } catch (err) {
      s3Errors += 1;
      console.warn("[gc-attachments] S3 delete failed:", key, (err as Error).message);
    }
  }

  // Delete DB rows even when S3 delete failed — orphans with dangling S3
  // objects are acceptable, orphans with a live DB row are not (they cost
  // query time and obscure real orphans). Missing S3 objects become
  // harmless dead keys that a separate lifecycle rule can sweep.
  const { count } = await prisma.attachment.deleteMany({
    where: {
      id: { in: orphans.map((r) => r.id) },
    },
  });

  return { deleted: count, s3Errors };
}
