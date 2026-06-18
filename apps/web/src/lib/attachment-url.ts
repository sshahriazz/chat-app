import { api } from "./api";

/**
 * Attachment access helpers.
 *
 * The object-storage bucket is private (no anonymous read). Every read
 * goes through an authenticated API call that returns a short-lived
 * signed URL; the browser then points an <img>/<video> at that URL or
 * navigates to it for download. We can't put the signed URL straight in
 * an `<img src>` from the message payload because signed URLs expire and
 * realtime-delivered messages never pass through the signing path — so
 * the client fetches on demand and caches per attachment id.
 */

interface SignedUrlResponse {
  url: string;
  expiresIn: number;
}

interface CacheEntry {
  url: string;
  // epoch ms after which we must re-fetch (refreshed a little before the
  // server's expiry so an in-flight load never races the cutoff).
  staleAt: number;
}

const viewCache = new Map<string, CacheEntry>();

// Re-fetch this many ms before the server-stated expiry.
const REFRESH_SKEW_MS = 30_000;

/**
 * Resolve a signed INLINE URL for an attachment (image/video/audio).
 * Cached until shortly before expiry. Throws if the request fails
 * (caller renders a fallback).
 */
export async function getAttachmentViewUrl(id: string): Promise<string> {
  const cached = viewCache.get(id);
  if (cached && Date.now() < cached.staleAt) return cached.url;

  const res = await api.get<SignedUrlResponse>(
    `/api/attachments/${encodeURIComponent(id)}/view`,
  );
  viewCache.set(id, {
    url: res.url,
    staleAt: Date.now() + Math.max(0, res.expiresIn * 1000 - REFRESH_SKEW_MS),
  });
  return res.url;
}

/** Drop a cached view URL (e.g. after a load error so the next render
 *  fetches a fresh one). */
export function invalidateAttachmentViewUrl(id: string): void {
  viewCache.delete(id);
}

/**
 * Trigger a download for an attachment. Fetches a signed
 * Content-Disposition: attachment URL, then navigates to it via a
 * transient anchor so the browser saves the file with its name.
 */
export async function downloadAttachment(
  id: string,
  filename: string,
): Promise<void> {
  const res = await api.get<SignedUrlResponse>(
    `/api/attachments/${encodeURIComponent(id)}/download`,
  );
  const a = document.createElement("a");
  a.href = res.url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
