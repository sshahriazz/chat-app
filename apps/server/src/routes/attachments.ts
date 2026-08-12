import { Router } from "express";
import crypto from "node:crypto";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";
import { prisma } from "../db";
import { runInManagedTx } from "../lib/tenant-context";
import {
  createUploadUrl,
  createDownloadUrl,
  createViewUrl,
  keyFromPublicUrl,
} from "../lib/s3";
import { extForContentType, isInlineSafeContentType } from "../lib/file-signature";
import { acquireTenantLock } from "../lib/dm-lock";
import { generalLimiter, uploadUrlLimiter } from "../middleware/rate-limit";
import { validate } from "../http/validate";
import { UploadUrlBodySchema } from "../http/schemas";
import { BadRequestError, NotFoundError, PayloadTooLargeError } from "../http/errors";

const router: Router = Router();

// Per-user aggregate storage cap. Prevents a single account from filling
// the bucket via repeated uploads under the per-file ceiling.
// Bump in production if you need per-plan quotas; make it an env var.
const PER_USER_QUOTA_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB

/** Resolve the storage key for an attachment row. Prefer the persisted
 *  `objectKey`; fall back to deriving it from the URL for legacy rows.
 *  Returns null when neither yields a usable key (caller → 404). */
function resolveKey(att: { objectKey: string | null; url: string }): string | null {
  if (att.objectKey) return att.objectKey;
  return keyFromPublicUrl(att.url);
}

/**
 * Shared authorization for a single attachment by id.
 *
 * Returns the attachment row when the caller may access it, else throws
 * NotFoundError — deliberately the SAME error for "doesn't exist",
 * "wrong tenant", and "not a member", so the endpoint is not an
 * existence oracle (an attacker can't distinguish a real-but-forbidden
 * id from a non-existent one).
 */
async function authorizeAttachment(
  attachmentId: string,
  user: { id: string },
  tenantId: string,
) {
  const attachment = await prisma.attachment.findFirst({
    where: { id: attachmentId, tenantId },
    include: { message: { select: { conversationId: true } } },
  });
  if (!attachment) throw new NotFoundError("Attachment not found");

  // Linked attachments require conversation membership; orphan uploads
  // (messageId null) are only accessible to the uploader.
  if (attachment.messageId && attachment.message) {
    const member = await prisma.conversationMember.findFirst({
      where: {
        conversationId: attachment.message.conversationId,
        userId: user.id,
        conversation: { tenantId },
      },
      select: { id: true },
    });
    if (!member) throw new NotFoundError("Attachment not found");
  } else if (attachment.uploaderId !== user.id) {
    throw new NotFoundError("Attachment not found");
  }

  return attachment;
}

function paramId(req: { params: Record<string, unknown> }): string {
  const raw = req.params.id;
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (typeof id !== "string" || id.length === 0 || id.length > 64) {
    throw new BadRequestError("Invalid attachment id");
  }
  return id;
}

// POST /api/attachments/upload-url
// Client sends file metadata; server mints a signed PUT URL, creates the
// Attachment row (with messageId:null — linked later on message send).
router.post(
  "/upload-url",
  requireAuth,
  uploadUrlLimiter,
  validate({ body: UploadUrlBodySchema }),
  async (req, res) => {
    const { user, tenantId } = req as AuthenticatedRequest;
    const { filename, contentType, size, width, height, purpose, thumbnail } =
      req.body as {
        filename: string;
        contentType: string;
        size: number;
        width?: number;
        height?: number;
        purpose: "attachment" | "avatar";
        thumbnail?: {
          contentType: "image/jpeg" | "image/webp";
          size: number;
          width: number;
          height: number;
        };
      };

    // Schema enforces size / content-type / dimension bounds + filename
    // sanitization — this handler just carries out the side effects.
    const attWidth = width ?? null;
    const attHeight = height ?? null;

    // Derive the extension from the DECLARED MIME, never from the user's
    // filename — the filename can carry double extensions / RTL overrides
    // that a naive `path.extname` would propagate into the key.
    const ext = extForContentType(contentType);
    // Avatars live under `avatars/<userId>/...` so the bucket policy
    // applied by `minio-init` can grant anonymous GET to that prefix only
    // (every other key stays private). Message attachments stay in the
    // user-id-rooted private namespace.
    const key =
      purpose === "avatar"
        ? `avatars/${user.id}/${crypto.randomUUID()}${ext}`
        : `${user.id}/${crypto.randomUUID()}${ext}`;

    // Mint the presign first (no DB state). The row insert below reserves
    // the quota; the presigned POST policy bounds the actual upload size.
    const signed = await createUploadUrl({
      userId: user.id,
      key,
      contentType,
      contentLength: size,
    });

    // The poster image, if the device made one. Keyed off the same UUID as
    // the original so the pair is obvious in the bucket and a delete of one
    // prefix takes both.
    const wantsThumbnail = purpose === "attachment" && !!thumbnail;
    const thumbnailKey = wantsThumbnail
      ? `${key.replace(/(\.[^.]+)?$/, "")}_thumb${extForContentType(thumbnail!.contentType)}`
      : null;
    const signedThumbnail =
      wantsThumbnail && thumbnailKey
        ? await createUploadUrl({
            userId: user.id,
            key: thumbnailKey,
            contentType: thumbnail!.contentType,
            contentLength: thumbnail!.size,
          })
        : null;

    // Avatars are NOT tracked in the attachments table: they have no
    // message link, no GC need (a User row carries the URL on `image`
    // and is overwritten on the next save), and shouldn't count against
    // the per-user message-attachment quota. Return early without the
    // transaction.
    if (purpose === "avatar") {
      res.status(201).json({
        upload: { url: signed.url, fields: signed.fields },
        publicUrl: signed.publicUrl,
        expiresIn: signed.expiresIn,
      });
      return;
    }

    // Atomic quota enforcement. A per-tenant advisory lock serializes
    // concurrent presigns within the tenant so the sum-then-insert can't
    // race — without it, N parallel uploads each read the old sum, all
    // pass the check, and the cap is blown by up to N×maxFile. Both the
    // per-user cap and the optional per-tenant cap are checked here.
    const attachment = await runInManagedTx(() => prisma.$transaction(async (tx) => {
      // inManagedTx: the RLS extension skips this tx's queries, so set the
      // tenant GUC here so RLS scopes the aggregate + insert below.
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
      await acquireTenantLock(tx, tenantId, "attach-quota");

      const userAgg = await tx.attachment.aggregate({
        where: { tenantId, uploaderId: user.id },
        _sum: { size: true },
      });
      const userUsed = userAgg._sum.size ?? 0;
      // The thumbnail occupies real bytes in the bucket, so it counts. Small,
      // but a quota that ignores a category of object is a quota that drifts.
      const reserved = size + (thumbnail?.size ?? 0);
      if (userUsed + reserved > PER_USER_QUOTA_BYTES) {
        throw new PayloadTooLargeError(
          `per-user storage quota exceeded (used ${userUsed} / ${PER_USER_QUOTA_BYTES} bytes)`,
        );
      }

      const tenantRow = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { storageQuotaBytes: true },
      });
      const tenantQuota = tenantRow?.storageQuotaBytes ?? null;
      if (tenantQuota !== null) {
        const tenantAgg = await tx.attachment.aggregate({
          where: { tenantId },
          _sum: { size: true },
        });
        const tenantUsed = tenantAgg._sum.size ?? 0;
        if (BigInt(tenantUsed) + BigInt(reserved) > tenantQuota) {
          throw new PayloadTooLargeError(
            `tenant storage quota exceeded (used ${tenantUsed} / ${tenantQuota} bytes)`,
          );
        }
      }

      return tx.attachment.create({
        data: {
          tenantId,
          uploaderId: user.id,
          url: signed.publicUrl,
          objectKey: key,
          contentType,
          filename,
          size,
          width: attWidth,
          height: attHeight,
          // Recorded now, before the bytes exist. A client that fails to
          // complete the thumbnail upload leaves a key pointing at nothing —
          // which `/view` handles by omitting the URL rather than 404ing, the
          // same way it already tolerates a missing original.
          thumbnailKey,
          thumbnailWidth: thumbnail?.width ?? null,
          thumbnailHeight: thumbnail?.height ?? null,
        },
      });
    }));

    res.status(201).json({
      attachmentId: attachment.id,
      // Presigned POST: client must POST multipart/form-data to `url`
      // with these `fields` first, then the `file` field last.
      upload: { url: signed.url, fields: signed.fields },
      publicUrl: signed.publicUrl,
      expiresIn: signed.expiresIn,
      // Second presigned POST for the poster image. The client uploads both
      // and may skip this one on failure — the attachment is still valid
      // without it.
      ...(signedThumbnail
        ? {
            thumbnailUpload: {
              url: signedThumbnail.url,
              fields: signedThumbnail.fields,
            },
          }
        : {}),
    });
  },
);

// GET /api/attachments/:id/view — returns a short-lived signed URL for
// INLINE rendering (<img>/<video>/<audio>) as JSON `{ url, expiresIn }`.
//
// Returns JSON rather than a 302 because the bucket is private and the
// server is bearer-auth only: an `<img src>` / `<a href>` can't carry
// the Authorization header, so the client must fetch this through the
// authenticated API client and then point the element at the returned
// signed URL (which needs no auth of its own).
//
// Membership-checked. Only inline-safe content types (image/video/
// audio) get an inline-disposition URL; anything else (PDF, zip, text)
// is signed as a forced download so it can never execute script in the
// bucket origin.
router.get("/:id/view", requireAuth, generalLimiter, async (req, res) => {
  const { user, tenantId } = req as AuthenticatedRequest;
  const id = paramId(req);
  const attachment = await authorizeAttachment(id, user, tenantId);

  const key = resolveKey(attachment);
  if (!key) throw new NotFoundError("Attachment not found");

  const signed = isInlineSafeContentType(attachment.contentType)
    ? await createViewUrl({
        key,
        filename: attachment.filename,
        contentType: attachment.contentType,
      })
    : await createDownloadUrl({
        key,
        filename: attachment.filename,
        contentType: attachment.contentType,
      });

  res.setHeader("Cache-Control", "no-store");
  // The poster image, when the uploader's device produced one.
  //
  // Signed in the same round-trip as the original rather than behind its own
  // endpoint: a card needs both to render and to be openable, and splitting
  // them would double the per-attachment request count that is already the
  // costliest part of opening a thread.
  //
  // Always inline-safe. The upload schema constrains a thumbnail to JPEG or
  // WebP, so unlike the original it can never be a type that renders script —
  // which is why this does not go through the isInlineSafeContentType branch
  // above.
  const thumbnail = attachment.thumbnailKey
    ? await createViewUrl({
        key: attachment.thumbnailKey,
        filename: attachment.filename,
        contentType: "image/jpeg",
      })
    : null;

  res.json({
    url: signed.url,
    expiresIn: signed.expiresIn,
    ...(thumbnail ? { thumbnailUrl: thumbnail.url } : {}),
  });
});

// GET /api/attachments/:id/download — returns a short-lived signed URL
// (Content-Disposition: attachment + pinned Content-Type + nosniff) as
// JSON `{ url, expiresIn }`. JSON (not 302) for the same bearer-auth
// reason as /view. The client fetches this, then navigates / triggers
// the download against the returned URL.
router.get("/:id/download", requireAuth, generalLimiter, async (req, res) => {
  const { user, tenantId } = req as AuthenticatedRequest;
  const id = paramId(req);
  const attachment = await authorizeAttachment(id, user, tenantId);

  const key = resolveKey(attachment);
  if (!key) throw new NotFoundError("Attachment not found");

  const signed = await createDownloadUrl({
    key,
    filename: attachment.filename,
    contentType: attachment.contentType,
  });
  res.setHeader("Cache-Control", "no-store");
  res.json({ url: signed.url, expiresIn: signed.expiresIn });
});

export default router;
