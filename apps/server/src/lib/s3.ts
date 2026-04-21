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
 * Two S3 clients with different endpoints:
 *
 *   getOpsClient()     → internal endpoint (`http://minio:9000`). Used
 *                        for HEAD/DELETE/anything the server runs itself.
 *                        Cheap intra-cluster calls, no public round-trip.
 *
 *   getSigningClient() → public endpoint (derived from S3_PUBLIC_URL_BASE).
 *                        Used ONLY to mint presigned PUT/GET URLs. The
 *                        Host in the signed URL must match what the
 *                        browser will send when uploading — otherwise
 *                        SigV4 validation fails on MinIO's side.
 *
 * When only one URL is set (S3_PUBLIC_URL_BASE points directly at an
 * internet-reachable MinIO), both clients share the same endpoint and
 * the split is a no-op.
 */

function getSigningEndpoint(publicUrlBase: string, bucket: string): string {
  // Strip the `/<bucket>` suffix so the SDK appends its own path-style
  // `/<bucket>/<key>`. Works for `http://host:port/bucket` and for
  // `https://host/subpath/bucket`.
  const u = new URL(publicUrlBase);
  const trimmed = u.pathname.replace(new RegExp(`/${bucket}/?$`), "");
  u.pathname = trimmed;
  return u.toString().replace(/\/$/, "");
}

let opsClient: S3Client | null = null;
let signingClient: S3Client | null = null;

function getOpsClient() {
  if (opsClient) return opsClient;
  const cfg = requireS3Config();
  opsClient = new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
    // Custom endpoints (R2/MinIO) need path-style addressing.
    forcePathStyle: !!cfg.endpoint,
  });
  return opsClient;
}

function getSigningClient() {
  if (signingClient) return signingClient;
  const cfg = requireS3Config();
  const signingEndpoint = getSigningEndpoint(cfg.publicUrlBase, cfg.bucket);
  signingClient = new S3Client({
    region: cfg.region,
    endpoint: signingEndpoint,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
    forcePathStyle: true,
  });
  return signingClient;
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
  const client = getSigningClient();
  const expiresIn = params.expiresIn ?? 5 * 60; // 5 min

  const cmd = new PutObjectCommand({
    Bucket: cfg.bucket,
    Key: params.key,
    ContentType: params.contentType,
    ContentLength: params.contentLength,
  });

  const uploadUrl = await getSignedUrl(client, cmd, { expiresIn });
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
  const client = getSigningClient();
  const expiresIn = params.expiresIn ?? 60; // 1 min

  // RFC 5987 encoding so non-ASCII filenames survive.
  const encoded = encodeURIComponent(params.filename);
  const disposition = `attachment; filename*=UTF-8''${encoded}`;

  const cmd = new GetObjectCommand({
    Bucket: cfg.bucket,
    Key: params.key,
    ResponseContentDisposition: disposition,
  });

  const url = await getSignedUrl(client, cmd, { expiresIn });
  return { url, expiresIn };
}

/**
 * Delete an object by key. Used by the orphan-attachment GC. Missing
 * objects resolve cleanly (S3 delete is idempotent).
 */
export async function deleteObject(key: string): Promise<void> {
  const cfg = requireS3Config();
  const client = getOpsClient();
  await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
}

/**
 * HEAD an object and return its actual byte size, or `null` if it doesn't
 * exist. Used by the post-upload verification flow to confirm the
 * bytes the client actually PUT match the size we signed the presign for.
 */
export async function headObjectSize(key: string): Promise<number | null> {
  const cfg = requireS3Config();
  const client = getOpsClient();
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
