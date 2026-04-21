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
 * Generic S3-compatible client. Works for AWS S3 (leave `endpoint` unset),
 * Cloudflare R2, MinIO, Backblaze B2, Wasabi, etc.
 *
 * The server never touches bytes. It only:
 *   1. Mints a presigned PUT URL (valid ~5 min).
 *   2. Records metadata in the `attachments` table.
 *
 * Clients upload directly to object storage, then POST the message
 * with the `attachmentId`(s) we gave them. Bandwidth cost + latency
 * stay with object storage, not our app tier.
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
 * Single S3 client pointed at the INTERNAL endpoint (e.g. `http://minio:9000`).
 * Both presigning and server-side operations (HEAD/DELETE) use it.
 *
 * Why sign against the internal hostname?
 *
 * Next.js's built-in rewrite proxy uses http-proxy with `changeOrigin:
 * true` (hardcoded — no way to configure via next.config.ts). That means
 * when a browser PUTs to `https://chat.example.com/<bucket>/<key>?sig=…`,
 * the web container rewrites the Host header to `minio:9000` before
 * forwarding to MinIO. SigV4 validates using the Host header MinIO
 * *receives*, not the URL the browser typed — so to pass validation the
 * signature must have been computed with Host=minio:9000.
 *
 * The presigned URL returned to the browser is then rewritten (below) so
 * its origin matches the public host. That only changes the URL string —
 * the signature payload stays the same, and MinIO still sees what it
 * expects after the Host rewrite.
 */

let s3Client: S3Client | null = null;

function getS3Client() {
  if (s3Client) return s3Client;
  const cfg = requireS3Config();
  s3Client = new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
    // Custom endpoints (R2/MinIO) need path-style addressing.
    forcePathStyle: !!cfg.endpoint,
  });
  return s3Client;
}

/**
 * Rewrite the origin of a presigned URL to the public host while leaving
 * the path and query string (including the signature) untouched.
 *
 *   http://minio:9000/chatapp/<key>?X-Amz-Signature=…
 *          ↓
 *   https://chat.example.com/chatapp/<key>?X-Amz-Signature=…
 *
 * The browser uses the rewritten URL; the Next.js rewrite proxy sends the
 * request on to MinIO with the internal Host header, so SigV4 still
 * validates against the Host the server signed with.
 */
function rewriteToPublicOrigin(signedUrl: string, publicUrlBase: string): string {
  const signed = new URL(signedUrl);
  const publicOrigin = new URL(publicUrlBase).origin;
  return `${publicOrigin}${signed.pathname}${signed.search}`;
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
  const client = getS3Client();
  const expiresIn = params.expiresIn ?? 5 * 60; // 5 min

  const cmd = new PutObjectCommand({
    Bucket: cfg.bucket,
    Key: params.key,
    ContentType: params.contentType,
    ContentLength: params.contentLength,
  });

  const internalUrl = await getSignedUrl(client, cmd, { expiresIn });
  const uploadUrl = rewriteToPublicOrigin(internalUrl, cfg.publicUrlBase);
  const publicUrl = `${cfg.publicUrlBase}/${params.key}`;
  return { uploadUrl, publicUrl, key: params.key, expiresIn };
}

/**
 * Signed GET URL that forces the browser to download rather than render.
 * The `ResponseContentDisposition` override is applied per-request, so the
 * same object can still serve inline for <img>/<video> on the public URL.
 */
export async function createDownloadUrl(params: {
  key: string;
  filename: string;
  expiresIn?: number;
}): Promise<{ url: string; expiresIn: number }> {
  const cfg = requireS3Config();
  const client = getS3Client();
  const expiresIn = params.expiresIn ?? 60; // 1 min

  // RFC 5987 encoding so non-ASCII filenames survive.
  const encoded = encodeURIComponent(params.filename);
  const disposition = `attachment; filename*=UTF-8''${encoded}`;

  const cmd = new GetObjectCommand({
    Bucket: cfg.bucket,
    Key: params.key,
    ResponseContentDisposition: disposition,
  });

  const internalUrl = await getSignedUrl(client, cmd, { expiresIn });
  const url = rewriteToPublicOrigin(internalUrl, cfg.publicUrlBase);
  return { url, expiresIn };
}

/**
 * Delete an object by key. Used by the orphan-attachment GC. Missing
 * objects resolve cleanly (S3 delete is idempotent).
 */
export async function deleteObject(key: string): Promise<void> {
  const cfg = requireS3Config();
  const client = getS3Client();
  await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
}

/**
 * HEAD an object and return its actual byte size, or `null` if it doesn't
 * exist. Used by the post-upload verification flow to confirm the
 * bytes the client actually PUT match the size we signed the presign for.
 */
export async function headObjectSize(key: string): Promise<number | null> {
  const cfg = requireS3Config();
  const client = getS3Client();
  try {
    const res = await client.send(
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
 * Recovers the bucket key from the public URL we stored at upload time.
 * Relies on S3_PUBLIC_URL_BASE pointing at the bucket origin.
 */
export function keyFromPublicUrl(publicUrl: string): string | null {
  const base = env.S3_PUBLIC_URL_BASE?.replace(/\/$/, "");
  if (!base) return null;
  if (!publicUrl.startsWith(base + "/")) return null;
  return publicUrl.slice(base.length + 1);
}
