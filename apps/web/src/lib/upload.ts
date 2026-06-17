import { api } from "./api";
import type { Attachment } from "./types";

interface PresignResponse {
  attachmentId: string;
  upload: { url: string; fields: Record<string, string> };
  publicUrl: string;
  expiresIn: number;
}

/**
 * For image files, read intrinsic width/height client-side before upload so
 * the server can persist them. Bubbles then render with `width`/`height`
 * attrs and avoid layout shift as thumbnails stream in during scroll.
 *
 * Returns null dimensions for non-images or if decoding fails (e.g. HEIC
 * that the browser can't render).
 */
async function readImageDimensions(
  file: File,
): Promise<{ width: number; height: number } | null> {
  if (typeof window === "undefined" || !file.type.startsWith("image/")) {
    return null;
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode().catch(() => {
      /* swallow; we'll check naturalWidth below */
    });
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      return { width: img.naturalWidth, height: img.naturalHeight };
    }
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Two-step upload: server mints a presigned PUT URL; client streams bytes
 * directly to object storage. Server never sees the file.
 *
 * Used for both message attachments and user avatars — the Attachment row
 * has `messageId: null` either way until it's later linked or referenced.
 */
export async function uploadFile(file: File): Promise<Attachment> {
  const contentType = file.type || "application/octet-stream";
  const dims = await readImageDimensions(file);

  const presign = await api.post<PresignResponse>(
    "/api/attachments/upload-url",
    {
      filename: file.name,
      contentType,
      size: file.size,
      ...(dims ? { width: dims.width, height: dims.height } : {}),
    },
  );

  // Presigned POST: build multipart/form-data from the server-provided
  // policy fields, then append the file LAST (S3 requires `file` to be
  // the final field). Do NOT set Content-Type manually — the browser
  // sets the multipart boundary. The "Content-Type" form field (from
  // `fields`) is what S3 stores + enforces against the signed policy.
  const form = new FormData();
  for (const [k, v] of Object.entries(presign.upload.fields)) {
    form.append(k, v);
  }
  form.append("file", file);

  const res = await fetch(presign.upload.url, {
    method: "POST",
    body: form,
  });
  // S3 returns 204 (or 201 if success_action_status set) on success.
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);

  return {
    id: presign.attachmentId,
    url: presign.publicUrl,
    contentType,
    filename: file.name,
    size: file.size,
    width: dims?.width ?? null,
    height: dims?.height ?? null,
  };
}
