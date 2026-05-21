import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../env";

/**
 * S3-compatible storage. Works for AWS S3 (leave `S3_ENDPOINT` unset),
 * Cloudflare R2, MinIO, Backblaze B2, Wasabi, etc.
 *
 * The server never touches bytes. It only:
 *   1. Mints a presigned PUT URL (valid ~5 min).
 *   2. Records metadata in the `attachments` table.
 *
 * Clients upload directly to object storage; bandwidth + latency stay
 * with the storage tier, not the app tier.
 */

function missingVar(name: string): never {
  throw new Error(
    `S3 not configured: set ${name} in apps/server/.env to enable attachments.`,
  );
}

function requireS3Config() {
  const region = env.S3_REGION ?? missingVar("S3_REGION");
  const bucket = env.S3_BUCKET ?? missingVar("S3_BUCKET");
  const accessKeyId = env.S3_ACCESS_KEY_ID ?? missingVar("S3_ACCESS_KEY_ID");
  const secretAccessKey =
    env.S3_SECRET_ACCESS_KEY ?? missingVar("S3_SECRET_ACCESS_KEY");
  const publicUrlBase =
    env.S3_PUBLIC_URL_BASE ?? missingVar("S3_PUBLIC_URL_BASE");
  return {
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    endpoint: env.S3_ENDPOINT,
    publicUrlBase: publicUrlBase.replace(/\/$/, ""),
  };
}

/**
 * Two S3 clients, each pointed at a different endpoint:
 *
 *   internalClient → S3_ENDPOINT (e.g. http://minio:9000)
 *     Reached over the docker network. Used for server-only operations
 *     (HEAD, DELETE) where there's no proxy in front of MinIO.
 *
 *   presignClient → origin of S3_PUBLIC_URL_BASE (e.g. https://chat.technext.it)
 *     Used purely to sign URLs the browser will use directly. The
 *     browser PUTs/GETs to `chat.technext.it/<bucket>/<key>` with
 *     `Host: chat.technext.it`; Traefik forwards to MinIO preserving
 *     that Host header; MinIO verifies SigV4 against the received Host.
 *     The signature must be computed against that same public Host, or
 *     verification 403s — which is what this split achieves.
 *
 * Earlier versions used a single client signed against `minio:9000` and
 * then rewrote the URL's origin to the public host before handing it to
 * the browser. That worked only because Next.js's `http-proxy` rewrote
 * `Host` back to `minio:9000` while forwarding — a side effect of `web`
 * being the reverse proxy. With Traefik routing `/chatapp` direct to
 * MinIO, the Host arrives unchanged and the old trick collapses.
 */
let internalClient: S3Client | null = null;
let presignClient: S3Client | null = null;

function buildClient(
  endpoint: string | undefined,
  cfg: ReturnType<typeof requireS3Config>,
): S3Client {
  return new S3Client({
    region: cfg.region,
    endpoint,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
    // Path-style is required for any custom endpoint (MinIO/R2/etc.).
    // For AWS-hosted S3 (no endpoint) the SDK uses subdomain style.
    forcePathStyle: !!endpoint,
  });
}

function getInternalClient(): S3Client {
  if (internalClient) return internalClient;
  internalClient = buildClient(requireS3Config().endpoint, requireS3Config());
  return internalClient;
}

function getPresignClient(): S3Client {
  if (presignClient) return presignClient;
  const cfg = requireS3Config();
  // Use only the *origin* of the public URL. The SDK in path-style
  // mode appends `/<bucket>/<key>` itself — keeping the bucket in
  // the endpoint would double-prefix.
  // For AWS-hosted S3 (no custom endpoint), there's no Host-rewrite
  // problem to solve: presigned URLs are subdomain-style and signed
  // for the actual S3 host. In that case we keep `endpoint: undefined`
  // so the SDK uses its default subdomain behavior.
  const publicOrigin = cfg.endpoint
    ? new URL(cfg.publicUrlBase).origin
    : undefined;
  presignClient = buildClient(publicOrigin, cfg);
  return presignClient;
}

export interface UploadUrlResult {
  uploadUrl: string;
  publicUrl: string;
  key: string;
  expiresIn: number;
}

export async function createUploadUrl(params: {
  userId: string;
  key: string;
  contentType: string;
  contentLength: number;
  expiresIn?: number;
}): Promise<UploadUrlResult> {
  const cfg = requireS3Config();
  // 90s is plenty for a one-shot upload and bounds the replay window
  // if the signed URL leaks (Referer to a third-party image, browser
  // extension, proxy log).
  const expiresIn = params.expiresIn ?? 90;

  const cmd = new PutObjectCommand({
    Bucket: cfg.bucket,
    Key: params.key,
    ContentType: params.contentType,
    ContentLength: params.contentLength,
  });

  const uploadUrl = await getSignedUrl(getPresignClient(), cmd, { expiresIn });
  const publicUrl = `${cfg.publicUrlBase}/${params.key}`;
  return { uploadUrl, publicUrl, key: params.key, expiresIn };
}

/**
 * Signed GET URL that forces the browser to download rather than render.
 * The bucket is private (no anonymous read) — every read goes through a
 * server-minted, membership-checked signed URL.
 *
 * We pin the response Content-Type to the value the caller passes (the
 * stored MIME) and add `X-Content-Type-Options: nosniff` so a polyglot
 * file declared as `image/png` can never be re-interpreted as HTML by
 * the browser. `Content-Disposition: attachment` forces a download for
 * any risky type.
 */
export async function createDownloadUrl(params: {
  key: string;
  filename: string;
  contentType?: string;
  expiresIn?: number;
}): Promise<{ url: string; expiresIn: number }> {
  const cfg = requireS3Config();
  // 120s: the client fetches this JSON, then navigates to the URL to
  // download. Generous enough for click-to-fetch latency, short enough
  // to bound leakage if the URL escapes (Referer, history, logs).
  const expiresIn = params.expiresIn ?? 120;

  // RFC 5987 encoding so non-ASCII filenames survive.
  const encoded = encodeURIComponent(params.filename);
  const disposition = `attachment; filename*=UTF-8''${encoded}`;

  const cmd = new GetObjectCommand({
    Bucket: cfg.bucket,
    Key: params.key,
    ResponseContentDisposition: disposition,
    ...(params.contentType ? { ResponseContentType: params.contentType } : {}),
  });

  const url = await getSignedUrl(getPresignClient(), cmd, { expiresIn });
  return { url, expiresIn };
}

/**
 * Signed GET URL for INLINE rendering (<img>/<video>/<audio>). Used by
 * `/api/attachments/:id/view` after the caller's conversation
 * membership has been verified. The response Content-Type is pinned to
 * the stored MIME and `Content-Disposition: inline` is set explicitly.
 *
 * SAFETY: callers must only ever pass this through for content types
 * that are safe to render inline (image/video/audio). HTML / SVG /
 * XML must NOT reach this path — the route enforces that, and the
 * upload allowlist already excludes them.
 *
 * 300s TTL: the client fetches this JSON then sets it as an <img>/
 * <video> src; the URL only needs to stay valid long enough for the
 * browser to load the bytes (which it then caches). Generous for slow
 * mobile connections / large media; still bounded for leak exposure.
 */
export async function createViewUrl(params: {
  key: string;
  filename: string;
  contentType: string;
  expiresIn?: number;
}): Promise<{ url: string; expiresIn: number }> {
  const cfg = requireS3Config();
  const expiresIn = params.expiresIn ?? 300;

  const encoded = encodeURIComponent(params.filename);
  const disposition = `inline; filename*=UTF-8''${encoded}`;

  const cmd = new GetObjectCommand({
    Bucket: cfg.bucket,
    Key: params.key,
    ResponseContentType: params.contentType,
    ResponseContentDisposition: disposition,
  });

  const url = await getSignedUrl(getPresignClient(), cmd, { expiresIn });
  return { url, expiresIn };
}

export async function deleteObject(key: string): Promise<void> {
  const cfg = requireS3Config();
  await getInternalClient().send(
    new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }),
  );
}

/**
 * HEAD an object and return its actual byte size, or `null` if missing.
 * Used by the post-upload verification flow to confirm the bytes the
 * client actually PUT match the size we signed the presign for.
 */
export async function headObjectSize(key: string): Promise<number | null> {
  const cfg = requireS3Config();
  try {
    const res = await getInternalClient().send(
      new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }),
    );
    return typeof res.ContentLength === "number" ? res.ContentLength : null;
  } catch (err: unknown) {
    const status =
      (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
        ?.httpStatusCode ?? 0;
    if (status === 404) return null;
    throw err;
  }
}

/**
 * Fetch the first `length` bytes of an object via a ranged GET. Used by
 * the post-upload verification flow to magic-byte-sniff the stored
 * content against the declared MIME. Returns null if the object is
 * missing. Reads at most `length` bytes regardless of object size.
 */
export async function getObjectHead(
  key: string,
  length = 64,
): Promise<Buffer | null> {
  const cfg = requireS3Config();
  try {
    const res = await getInternalClient().send(
      new GetObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
        Range: `bytes=0-${length - 1}`,
      }),
    );
    const body = res.Body as unknown as AsyncIterable<Uint8Array> | undefined;
    if (!body) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of body) {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= length) break;
    }
    return Buffer.concat(chunks).subarray(0, length);
  } catch (err: unknown) {
    const status =
      (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
        ?.httpStatusCode ?? 0;
    if (status === 404 || status === 416) return null;
    throw err;
  }
}

/**
 * Recovers the bucket key from the public URL we stored at upload time.
 * Relies on S3_PUBLIC_URL_BASE pointing at the bucket origin.
 *
 * Prefer the persisted `Attachment.objectKey` column — this helper is
 * the legacy fallback for rows created before that column existed. It
 * fails closed: returns null on any prefix mismatch or traversal-shaped
 * residue so the caller can refuse rather than operate on a guessed key.
 */
export function keyFromPublicUrl(publicUrl: string): string | null {
  const base = env.S3_PUBLIC_URL_BASE?.replace(/\/$/, "");
  if (!base) return null;
  if (!publicUrl.startsWith(base + "/")) return null;
  const key = publicUrl.slice(base.length + 1);
  // Defense-in-depth: reject anything that doesn't look like our
  // `<uuid-ish>/<uuid><ext>` key shape, and any path-traversal residue.
  if (key.includes("..") || key.includes("//") || key.startsWith("/")) {
    return null;
  }
  return key;
}
