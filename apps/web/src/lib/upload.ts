import { api } from "./api";
import type { Attachment } from "./types";

interface PresignResponse {
  attachmentId: string;
  uploadUrl: string;
  publicUrl: string;
  expiresIn: number;
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
  const presign = await api.post<PresignResponse>(
    "/api/attachments/upload-url",
    {
      filename: file.name,
      contentType,
      size: file.size,
    },
  );

  const res = await fetch(presign.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: file,
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);

  return {
    id: presign.attachmentId,
    url: presign.publicUrl,
    contentType,
    filename: file.name,
    size: file.size,
    width: null,
    height: null,
  };
}
