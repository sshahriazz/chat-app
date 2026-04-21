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

const router: Router = Router();

// ~50 MB is a reasonable ceiling for a chat attachment; adjust per plan.
const MAX_SIZE = 50 * 1024 * 1024;
// Per-user aggregate storage cap. Prevents a single account from filling
// the bucket via repeated uploads under the per-file 50MB ceiling.
// Bump in production if you need per-plan quotas; make it an env var.
const PER_USER_QUOTA_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB

// POST /api/attachments/upload-url
// Client sends file metadata; server mints a signed PUT URL, creates the
// Attachment row (with messageId:null — linked later on message send).
router.post("/upload-url", requireAuth, uploadUrlLimiter, async (req, res) => {
  const { user } = req as AuthenticatedRequest;
  const { filename, contentType, size, width, height } = req.body as {
    filename?: string;
    contentType?: string;
    size?: number;
    width?: number;
    height?: number;
  };

  if (!filename || !contentType || typeof size !== "number") {
    res
      .status(400)
      .json({ error: "filename, contentType and size are required" });
    return;
  }

  // Filename sanity: arbitrary-length user input stored in the DB and
  // passed as an S3 key extension seed. Windows/POSIX path separators
  // can't actually produce traversal (the key is a UUID + `path.extname`),
  // but a huge filename is pure abuse.
  if (filename.length > 255) {
    res.status(400).json({ error: "filename too long" });
    return;
  }

  // Content-type allowlist. Explicitly rejects image/svg+xml, HTML, and
  // executables — anything that could serve a script when fetched from
  // the bucket and opened in a browser tab. Arbitrary octet-stream
  // downloads are also rejected; we'd want explicit buy-in for generic
  // binary uploads.
  const ALLOWED_CONTENT_TYPES = new Set<string>([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "image/heic",
    "image/heif",
    "application/pdf",
    "text/plain",
    "text/csv",
    "application/zip",
    "application/x-zip-compressed",
    "video/mp4",
    "video/webm",
    "video/quicktime",
    "audio/mpeg",
    "audio/ogg",
    "audio/wav",
    "audio/webm",
  ]);
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    res.status(415).json({ error: `unsupported content type: ${contentType}` });
    return;
  }

  // Clamp dimension values: only accept finite positive integers below a
  // sanity ceiling (>16k × 16k is almost certainly a hostile client).
  const validDim = (n: unknown): number | null => {
    if (typeof n !== "number" || !Number.isFinite(n)) return null;
    const v = Math.floor(n);
    if (v <= 0 || v > 16384) return null;
    return v;
  };
  const attWidth = validDim(width);
  const attHeight = validDim(height);
  if (size <= 0 || size > MAX_SIZE) {
    res.status(400).json({ error: `size must be between 1 and ${MAX_SIZE}` });
    return;
  }

  // Per-user quota. Sums the uploader's existing attachments; rejects if
  // this upload would push them over the cap. Racy under extreme
  // concurrency (two parallel presigns can both pass), but the window is
  // small and the worst case is a user ending up slightly over quota —
  // acceptable while we don't need strict accounting.
  const used = await prisma.attachment.aggregate({
    where: { uploaderId: user.id },
    _sum: { size: true },
  });
  const usedBytes = used._sum.size ?? 0;
  if (usedBytes + size > PER_USER_QUOTA_BYTES) {
    res.status(413).json({
      error: `storage quota exceeded (used ${usedBytes} / ${PER_USER_QUOTA_BYTES} bytes)`,
    });
    return;
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
    res.status(500).json({ error: (err as Error).message });
    return;
  }

  const attachment = await prisma.attachment.create({
    data: {
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
});

// GET /api/attachments/:id/download — issues a short-lived signed URL with
// Content-Disposition: attachment, then 302-redirects the browser to it.
// Works for any content-type so images, PDFs and arbitrary binaries all
// prompt a download instead of rendering inline.
router.get("/:id/download", requireAuth, async (req, res) => {
  const { user } = req as AuthenticatedRequest;
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const attachment = await prisma.attachment.findUnique({
    where: { id },
    include: {
      message: { select: { conversationId: true } },
    },
  });

  if (!attachment) {
    res.status(404).json({ error: "Attachment not found" });
    return;
  }

  // Authorization: linked attachments require conversation membership;
  // orphan uploads (messageId null) are only accessible to the uploader.
  if (attachment.messageId && attachment.message) {
    const member = await prisma.conversationMember.findUnique({
      where: {
        conversationId_userId: {
          conversationId: attachment.message.conversationId,
          userId: user.id,
        },
      },
      select: { id: true },
    });
    if (!member) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
  } else if (attachment.uploaderId !== user.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const key = keyFromPublicUrl(attachment.url);
  if (!key) {
    res.status(500).json({ error: "Attachment URL has unknown origin" });
    return;
  }

  try {
    const { url } = await createDownloadUrl({
      key,
      filename: attachment.filename,
    });
    res.redirect(url);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;