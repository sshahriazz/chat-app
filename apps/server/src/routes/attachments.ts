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

const router: Router = Router();

// ~50 MB is a reasonable ceiling for a chat attachment; adjust per plan.
const MAX_SIZE = 50 * 1024 * 1024;

// POST /api/attachments/upload-url
// Client sends file metadata; server mints a signed PUT URL, creates the
// Attachment row (with messageId:null — linked later on message send).
router.post("/upload-url", requireAuth, async (req, res) => {
  const { user } = req as AuthenticatedRequest;
  const { filename, contentType, size } = req.body as {
    filename?: string;
    contentType?: string;
    size?: number;
  };

  if (!filename || !contentType || typeof size !== "number") {
    res
      .status(400)
      .json({ error: "filename, contentType and size are required" });
    return;
  }
  if (size <= 0 || size > MAX_SIZE) {
    res.status(400).json({ error: `size must be between 1 and ${MAX_SIZE}` });
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