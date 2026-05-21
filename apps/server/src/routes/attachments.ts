import { Router } from "express";
import crypto from "node:crypto";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";
import { prisma } from "../db";
import {
  createUploadUrl,
  createDownloadUrl,
  createViewUrl,
  keyFromPublicUrl,
} from "../lib/s3";
import { extForContentType, isInlineSafeContentType } from "../lib/file-signature";
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
    const { filename, contentType, size, width, height } = req.body as {
      filename: string;
      contentType: string;
      size: number;
      width?: number;
      height?: number;
    };

    // Schema enforces size / content-type / dimension bounds + filename
    // sanitization — this handler just carries out the side effects.
    const attWidth = width ?? null;
    const attHeight = height ?? null;

    // Per-user quota. Sums the uploader's existing attachments; rejects if
    // this upload would push them over the cap. Racy under extreme
    // concurrency (two parallel presigns can both pass), but the window is
    // small and the worst case is a user ending up slightly over quota —
    // acceptable while we don't need strict accounting.
    const used = await prisma.attachment.aggregate({
      where: { tenantId, uploaderId: user.id },
      _sum: { size: true },
    });
    const usedBytes = used._sum.size ?? 0;
    if (usedBytes + size > PER_USER_QUOTA_BYTES) {
      throw new PayloadTooLargeError(
        `storage quota exceeded (used ${usedBytes} / ${PER_USER_QUOTA_BYTES} bytes)`,
      );
    }

    // Derive the extension from the DECLARED MIME, never from the user's
    // filename — the filename can carry double extensions / RTL overrides
    // that a naive `path.extname` would propagate into the key.
    const ext = extForContentType(contentType);
    const key = `${user.id}/${crypto.randomUUID()}${ext}`;

    const signed = await createUploadUrl({
      userId: user.id,
      key,
      contentType,
      contentLength: size,
    });

    const attachment = await prisma.attachment.create({
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
      },
    });

    res.status(201).json({
      attachmentId: attachment.id,
      uploadUrl: signed.uploadUrl,
      publicUrl: signed.publicUrl,
      expiresIn: signed.expiresIn,
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
  res.json({ url: signed.url, expiresIn: signed.expiresIn });
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
