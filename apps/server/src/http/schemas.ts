import { z } from "zod";
import "zod-openapi";

/**
 * Shared Zod schemas for HTTP requests.
 *
 * Single source of truth for:
 *   1. Runtime validation via `validate()` middleware on routes
 *   2. OpenAPI documentation (imported by `http/openapi.ts`)
 *
 * Keeping them here avoids the drift that happens when routes hand-roll
 * `if (!field)` checks while the docs describe a different contract.
 */

// ─── Shared primitives ───────────────────────────────────────

/**
 * An http(s) URL. `z.string().url()` alone accepts `javascript:`,
 * `data:`, `vbscript:`, `file:` etc. — which become stored-XSS / open
 * surface when a stored URL is later used as an href/src. Restrict to
 * http(s) so only fetchable web URLs pass.
 */
export const httpUrl = (max = 2048) =>
  z
    .string()
    .url()
    .max(max)
    .refine((u) => /^https?:\/\//i.test(u), "URL must be http(s)");

/**
 * A resource id path-param shape: non-empty, length-bounded, and
 * restricted to the id charset we actually issue (uuid/cuid-style).
 * Caps DoS via giant ids and rejects junk before it reaches Prisma.
 */
const idString = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "invalid id");

export const IdParamSchema = z
  .object({ id: z.string().min(1) })
  .meta({ id: "IdParam" });

export const ConversationIdParamsSchema = z
  .object({ id: z.string().min(1) })
  .meta({ id: "ConversationIdParams" });

export const MessageIdParamsSchema = z
  .object({
    id: z.string().min(1),
    messageId: z.string().min(1),
  })
  .meta({ id: "MessageIdParams" });

export const ReactionIdParamsSchema = z
  .object({
    id: z.string().min(1),
    messageId: z.string().min(1),
    emoji: z.string().min(1).max(128),
  })
  .meta({ id: "ReactionIdParams" });

export const MemberIdParamsSchema = z
  .object({
    id: z.string().min(1),
    userId: z.string().min(1),
  })
  .meta({ id: "MemberIdParams" });

// ─── Tiptap content ──────────────────────────────────────────
//
// The canonical shape is enforced deeper (message-content.ts runs a
// round-trip through the Tiptap schema); this layer just rejects things
// that obviously aren't a document so we don't hit the richer
// canonicalizer with junk.

export const TiptapDocSchema = z
  .object({
    type: z.literal("doc"),
    content: z.array(z.unknown()).optional(),
  })
  .meta({ id: "TiptapDoc" });

// ─── Conversations ───────────────────────────────────────────

export const CreateConversationBodySchema = z
  .object({
    type: z.enum(["direct", "group"]),
    name: z.string().min(1).max(100).optional(),
    memberIds: z.array(z.string().min(1)).min(1).max(50),
  })
  .meta({ id: "CreateConversationBody" });

export const RenameConversationBodySchema = z
  .object({ name: z.string().min(1).max(100) })
  .meta({ id: "RenameConversationBody" });

export const AddMembersBodySchema = z
  .object({
    userIds: z.array(z.string().min(1)).min(1).max(50),
    name: z.string().min(1).max(100).optional(),
  })
  .meta({ id: "AddMembersBody" });

export const ListConversationsQuerySchema = z
  .object({
    limit: z.coerce.number().int().positive().max(100).optional(),
    before: z.string().optional(),
  })
  .meta({ id: "ListConversationsQuery" });

// ─── Messages ────────────────────────────────────────────────

export const SendMessageBodySchema = z
  .object({
    content: TiptapDocSchema.optional(),
    replyToId: z.string().min(1).optional(),
    clientMessageId: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/, "clientMessageId must be url-safe chars")
      .optional(),
    attachmentIds: z.array(z.string().min(1)).max(10).optional(),
  })
  .meta({ id: "SendMessageBody" });

export const EditMessageBodySchema = z
  .object({ content: TiptapDocSchema })
  .meta({ id: "EditMessageBody" });

export const ListMessagesQuerySchema = z
  .object({
    limit: z.coerce.number().int().positive().max(100).optional(),
    before: z.string().optional(),
    anchor: z.string().optional(),
  })
  .meta({ id: "ListMessagesQuery" });

export const MarkReadBodySchema = z
  .object({ messageId: z.string().min(1) })
  .meta({ id: "MarkReadBody" });

export const MuteBodySchema = z
  .object({ muted: z.boolean() })
  .meta({ id: "MuteBody" });

export const ReactionBodySchema = z
  .object({ emoji: z.string().min(1).max(16) })
  .meta({ id: "ReactionBody" });

// ─── Search ──────────────────────────────────────────────────

export const SearchQuerySchema = z
  .object({ q: z.string().min(2).max(128) })
  .meta({ id: "SearchQuery" });

// ─── Users ───────────────────────────────────────────────────

export const UserSearchQuerySchema = z
  .object({ q: z.string().min(2).max(64) })
  .meta({ id: "UserSearchQuery" });

export const OnlineUsersBodySchema = z
  .object({
    userIds: z
      .array(z.string().min(1).max(128))
      .min(1)
      .max(200),
  })
  .meta({ id: "OnlineUsersBody" });

// Browseable listing of tenant users. `cursor` is an opaque base64url
// blob minted by the server (encodes the last `(name, id)` of the
// previous page); clients treat it as a token to pass back verbatim.
// A fabricated or tampered cursor is tolerated — it's decoded
// defensively and silently falls back to the first page rather than
// throwing, so bad cursors don't break the UI.
export const TenantUserListQuerySchema = z
  .object({
    cursor: z.string().min(1).max(1024).optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
  })
  .meta({ id: "TenantUserListQuery" });

// ─── Attachments ─────────────────────────────────────────────

export const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;

const ALLOWED_CONTENT_TYPES = [
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
] as const;

/**
 * Sanitize a user-supplied filename before we store or display it.
 *
 * Drops:
 *   - C0 control chars (U+0000-U+001F) and DEL (U+007F) - including the
 *     null byte, which has historically truncated filenames on the OS
 *     side and confused content-disposition parsers.
 *   - Bidi / direction overrides (U+202A-U+202E, U+2066-U+2069). RLO
 *     (U+202E) displays "evil<RLO>gpj.exe" as "evilexe.jpg" in clients.
 *   - Path separators / parent traversals.
 * Normalizes Unicode -> NFC and truncates to 100 chars (extension is
 * derived from the declared MIME, not from this label).
 *
 * The strip range uses \u escapes only, so the source stays ASCII.
 */
const FILENAME_STRIP =
  /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;

function sanitizeFilename(raw: string): string {
  let s = raw.normalize("NFC");
  // Drop control + bidi-override codepoints.
  s = s.replace(FILENAME_STRIP, "");
  // Disallow path separators outright; treat the basename as the label.
  s = s.replace(/[\\/]+/g, "_");
  // Collapse dot-runs that look like traversal.
  s = s.replace(/\.{2,}/g, ".");
  // Trim leading/trailing dots + whitespace (Windows quirks + UX noise).
  s = s.replace(/^[\s.]+|[\s.]+$/g, "");
  return s.slice(0, 100);
}

/** Tight cap for avatar uploads — smaller than MAX_ATTACHMENT_SIZE so a
 *  user can't park a 10 MB blob in the public `avatars/*` prefix. */
export const MAX_AVATAR_SIZE = 2 * 1024 * 1024;

export const UploadUrlBodySchema = z
  .object({
    filename: z
      .string()
      .min(1)
      .max(255)
      .transform(sanitizeFilename)
      .refine((s) => s.length > 0, "Filename is empty after sanitization"),
    contentType: z.enum(ALLOWED_CONTENT_TYPES),
    size: z.number().int().positive().max(MAX_ATTACHMENT_SIZE),
    width: z.number().int().positive().max(16384).optional(),
    height: z.number().int().positive().max(16384).optional(),
    /** What the upload is for:
     *  - "attachment" (default): private bucket, quota-counted, attached
     *    to a message later via `attachmentIds`.
     *  - "avatar": uploaded to the public `avatars/<userId>/` prefix
     *    (granted anonymous GET by the bucket policy in `minio-init`).
     *    Stricter type+size constraints; NOT tracked in the attachments
     *    table — the URL lives on User.image. */
    purpose: z.enum(["attachment", "avatar"]).default("attachment"),
  })
  .refine(
    (b) =>
      b.purpose !== "avatar" ||
      (b.contentType.startsWith("image/") && b.size <= MAX_AVATAR_SIZE),
    {
      message: `Avatars must be image/* and ≤ ${MAX_AVATAR_SIZE} bytes`,
      path: ["purpose"],
    },
  )
  .meta({ id: "UploadUrlBody" });

// ─── Centrifugo ──────────────────────────────────────────────

export const SubscriptionTokenBodySchema = z
  .object({ channel: z.string().min(1).max(200) })
  .meta({ id: "SubscriptionTokenBody" });

// ─── Push ────────────────────────────────────────────────────

// Allowlist of hostnames the server will ever POST a Web Push to. A
// bare `z.string().url()` accepts `http://169.254.169.254/...`,
// `http://localhost:6379/`, internal admin endpoints, etc. — turning
// the push fan-out into an SSRF primitive (the server POSTs to whatever
// endpoint a user registered whenever they get a message). Browsers
// only ever hand out push endpoints on these provider domains.
const PUSH_ENDPOINT_HOST_ALLOWLIST: RegExp[] = [
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /(^|\.)notify\.windows\.com$/,
  /(^|\.)push\.apple\.com$/,
];

function isAllowedPushEndpoint(u: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  return PUSH_ENDPOINT_HOST_ALLOWLIST.some((re) => re.test(parsed.hostname));
}

const pushEndpoint = z
  .string()
  .url()
  .max(1024)
  .refine(isAllowedPushEndpoint, "Unsupported push endpoint host");

export const PushSubscribeBodySchema = z
  .object({
    endpoint: pushEndpoint,
    keys: z.object({
      p256dh: z.string().min(1).max(200),
      auth: z.string().min(1).max(200),
    }),
  })
  .meta({ id: "PushSubscribeBody" });

export const PushUnsubscribeBodySchema = z
  .object({ endpoint: pushEndpoint })
  .meta({ id: "PushUnsubscribeBody" });

// ─── Webhooks (tenant → us) ──────────────────────────────────

export const UsersUpdatedWebhookBodySchema = z
  .object({
    externalId: z.string().min(1).max(256),
    name: z.string().min(1).max(128),
    image: httpUrl(2048).nullable().optional(),
    email: z.string().email().max(254).nullable().optional(),
  })
  .meta({ id: "UsersUpdatedWebhookBody" });

export const UsersDeletedWebhookBodySchema = z
  .object({
    externalId: z.string().min(1).max(256),
  })
  .meta({ id: "UsersDeletedWebhookBody" });

// ─── Admin (operator → us, MASTER_API_KEY) ───────────────────

export const CreateTenantBodySchema = z
  .object({ name: z.string().min(1).max(128) })
  .meta({ id: "CreateTenantBody" });
