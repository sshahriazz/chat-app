import { Router } from "express";
import crypto from "node:crypto";
import path from "node:path";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";
import { prisma } from "../db";
import {
  createUploadUrl,
  createDownloadUrl,
  keyFromPublicUrl,
} from "../lib/s3";
import { uploadUrlLimiter } from "../middleware/rate-limit";
import { validate } from "../http/validate";
import { UploadUrlBodySchema } from "../http/schemas";
import {
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
} from "../http/errors";

const router: Router = Router();

// Per-user aggregate storage cap. Prevents a single account from filling
// the bucket via repeated uploads under the per-file 50MB ceiling.
// Bump in production if you need per-plan quotas; make it an env var.
const PER_USER_QUOTA_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB

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

    // Schema enforces size / content-type / dimension bounds — this
    // handler just carries out the side effects.
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

    const ext = path.extname(filename).slice(0, 10); // cap ext length
    const key = `${user.id}/${crypto.randomUUID()}${ext}`;

    let signed;
    try {
      signed = await createUploadUrl({
        userId: user.id,
        key,
        contentType,
        contentLength: size,
      });
    } catch (err) {
      // Re-throw so the central error handler renders a 500. S3 errors
      // should never leak their raw message to clients.
      throw err;
    }

    const attachment = await prisma.attachment.create({
      data: {
        tenantId,
        uploaderId: user.id,
        url: signed.publicUrl,
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

// GET /api/attachments/:id/download — issues a short-lived signed URL with
// Content-Disposition: attachment, then 302-redirects the browser to it.
// Works for any content-type so images, PDFs and arbitrary binaries all
// prompt a download instead of rendering inline.
router.get("/:id/download", requireAuth, async (req, res) => {
  const { user, tenantId } = req as AuthenticatedRequest;
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const attachment = await prisma.attachment.findFirst({
    where: { id, tenantId },
    include: {
      message: { select: { conversationId: true } },
    },
  });

  if (!attachment) throw new NotFoundError("Attachment not found");

  // Authorization: linked attachments require conversation membership;
  // orphan uploads (messageId null) are only accessible to the uploader.
  if (attachment.messageId && attachment.message) {
    const member = await prisma.conversationMember.findFirst({
      where: {
        conversationId: attachment.message.conversationId,
        userId: user.id,
        conversation: { tenantId },
      },
      select: { id: true },
    });
    if (!member) throw new ForbiddenError();
  } else if (attachment.uploaderId !== user.id) {
    throw new ForbiddenError();
  }

  const key = keyFromPublicUrl(attachment.url);
  if (!key) throw new Error("Attachment URL has unknown origin");

  const { url } = await createDownloadUrl({
    key,
    filename: attachment.filename,
  });
  res.redirect(url);
});

export default router;