/**
 * Magic-byte verification + MIME→extension mapping for the attachment
 * pipeline.
 *
 * Why hand-rolled instead of the `file-type` package: that library is
 * ESM-only and pulls a large transitive tree; our allowlist is small
 * and stable, so a focused signature table is simpler to audit and has
 * no supply-chain surface. We only need to answer one question: "do the
 * first N bytes of this object look like the content type the client
 * declared?" — to stop a polyglot (HTML/JS bytes labeled image/png)
 * from being stored and served.
 */

/** Canonical extension per allowed MIME. The S3 key extension is
 *  derived from the *declared MIME*, never from the user's filename
 *  (which can carry RTL overrides / double extensions). */
const MIME_TO_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "application/zip": ".zip",
  "application/x-zip-compressed": ".zip",
  // Office Open XML and OpenDocument. All of them are ZIP containers, which
  // is why they were previously uploaded *as* `application/zip` — the client
  // had no accepted type to declare. That made the stored content type a
  // fabrication, and disposition is decided from it.
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    ".pptx",
  "application/vnd.oasis.opendocument.text": ".odt",
  "application/vnd.oasis.opendocument.spreadsheet": ".ods",
  "application/vnd.oasis.opendocument.presentation": ".odp",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "audio/webm": ".weba",
};

export function extForContentType(contentType: string): string {
  return MIME_TO_EXT[contentType] ?? "";
}

/** Content types that can execute script if served inline, even when
 *  they nominally fall under an `image/*` prefix. SVG is XML+script;
 *  it must always be a download. Kept as an explicit denylist so a
 *  future allowlist edit can't accidentally make it inline-renderable. */
const NEVER_INLINE = new Set([
  "image/svg+xml",
  "image/svg",
  "text/html",
  "application/xhtml+xml",
  "application/xml",
  "text/xml",
]);

/** Content types we render/serve inline (image/audio/video). Anything
 *  outside this set must be served as `attachment` only. HTML / SVG /
 *  XML are explicitly excluded — they execute script in the bucket
 *  origin if served inline. */
export function isInlineSafeContentType(contentType: string): boolean {
  if (NEVER_INLINE.has(contentType)) return false;
  return (
    contentType.startsWith("image/") ||
    contentType.startsWith("video/") ||
    contentType.startsWith("audio/")
  );
}

type Matcher = (buf: Buffer) => boolean;

/**
 * Every Office Open XML and OpenDocument file is a ZIP archive, so the
 * signature check for all of them is the ZIP one.
 *
 * This does not prove a `.docx` is a `.docx` — only that it is a zip. That is
 * the same guarantee the previous `application/zip` declaration gave, and it
 * is the honest limit of a magic-byte check on a container format. What
 * changes is that the *stored* type is now what the user actually sent, so
 * download disposition is decided from a real value rather than a placeholder.
 */
const isZipContainer: Matcher = (buf) =>
  startsWith([0x50, 0x4b, 0x03, 0x04])(buf) ||
  startsWith([0x50, 0x4b, 0x05, 0x06])(buf) ||
  startsWith([0x50, 0x4b, 0x07, 0x08])(buf);

const startsWith = (sig: number[], offset = 0): Matcher => (buf) => {
  if (buf.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (buf[offset + i] !== sig[i]) return false;
  }
  return true;
};

// ASCII helpers
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/**
 * Per-MIME magic-byte matchers. A `null` entry means "no reliable
 * signature" (text/* and the structurally-varied container formats);
 * for those we accept any bytes since there is nothing deterministic
 * to check, but they're already non-executable in a nosniff/attachment
 * response.
 */
const SIGNATURES: Record<string, Matcher | null> = {
  "image/png": startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/jpeg": startsWith([0xff, 0xd8, 0xff]),
  "image/gif": (buf) =>
    startsWith(ascii("GIF87a"))(buf) || startsWith(ascii("GIF89a"))(buf),
  // RIFF....WEBP
  "image/webp": (buf) =>
    startsWith(ascii("RIFF"))(buf) && startsWith(ascii("WEBP"), 8)(buf),
  // ftyp box with avif/heic/heif brand at offset 8
  "image/avif": (buf) => startsWith(ascii("ftyp"), 4)(buf),
  "image/heic": (buf) => startsWith(ascii("ftyp"), 4)(buf),
  "image/heif": (buf) => startsWith(ascii("ftyp"), 4)(buf),
  "application/pdf": startsWith(ascii("%PDF-")),
  "text/plain": null,
  "text/csv": null,
  // PK\x03\x04 (local file header), PK\x05\x06 (empty archive) and
  // PK\x07\x08 (spanned). Shared by every ZIP-container format below.
  "application/zip": isZipContainer,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    isZipContainer,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    isZipContainer,
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    isZipContainer,
  "application/vnd.oasis.opendocument.text": isZipContainer,
  "application/vnd.oasis.opendocument.spreadsheet": isZipContainer,
  "application/vnd.oasis.opendocument.presentation": isZipContainer,
  "application/x-zip-compressed": (buf) =>
    startsWith([0x50, 0x4b, 0x03, 0x04])(buf) ||
    startsWith([0x50, 0x4b, 0x05, 0x06])(buf) ||
    startsWith([0x50, 0x4b, 0x07, 0x08])(buf),
  // ftyp box at offset 4 for the MP4/QuickTime family
  "video/mp4": (buf) => startsWith(ascii("ftyp"), 4)(buf),
  "video/quicktime": (buf) => startsWith(ascii("ftyp"), 4)(buf),
  // EBML header shared by WebM + Matroska + WebM audio
  "video/webm": startsWith([0x1a, 0x45, 0xdf, 0xa3]),
  "audio/webm": startsWith([0x1a, 0x45, 0xdf, 0xa3]),
  // ID3 tag or MPEG frame sync
  "audio/mpeg": (buf) =>
    startsWith(ascii("ID3"))(buf) ||
    (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0),
  "audio/ogg": startsWith(ascii("OggS")),
  "audio/wav": (buf) =>
    startsWith(ascii("RIFF"))(buf) && startsWith(ascii("WAVE"), 8)(buf),
};

/**
 * Returns true when `head` (the first bytes of the stored object) is
 * consistent with `declaredContentType`. When we have no signature for
 * that type (text/*), returns true — there's nothing to falsify and the
 * type is non-executable in a nosniff/attachment response.
 *
 * Returns false when the type is unknown (not in the allowlist) or the
 * bytes contradict the declared signature.
 */
export function bytesMatchContentType(
  head: Buffer,
  declaredContentType: string,
): boolean {
  if (!(declaredContentType in SIGNATURES)) return false;
  const matcher = SIGNATURES[declaredContentType];
  if (matcher === null) return true;
  return matcher(head);
}
