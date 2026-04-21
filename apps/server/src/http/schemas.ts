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
    clientMessageId: z.string().max(256).optional(),
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

// ─── Attachments ─────────────────────────────────────────────

const MAX_ATTACHMENT_SIZE = 50 * 1024 * 1024;

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

export const UploadUrlBodySchema = z
  .object({
    filename: z.string().min(1).max(255),
    contentType: z.enum(ALLOWED_CONTENT_TYPES),
    size: z.number().int().positive().max(MAX_ATTACHMENT_SIZE),
    width: z.number().int().positive().max(16384).optional(),
    height: z.number().int().positive().max(16384).optional(),
  })
  .meta({ id: "UploadUrlBody" });

// ─── Centrifugo ──────────────────────────────────────────────

export const SubscriptionTokenBodySchema = z
  .object({ channel: z.string().min(1).max(200) })
  .meta({ id: "SubscriptionTokenBody" });

// ─── Push ────────────────────────────────────────────────────

export const PushSubscribeBodySchema = z
  .object({
    endpoint: z.string().url().max(1024),
    keys: z.object({
      p256dh: z.string().min(1).max(200),
      auth: z.string().min(1).max(200),
    }),
  })
  .meta({ id: "PushSubscribeBody" });

export const PushUnsubscribeBodySchema = z
  .object({ endpoint: z.string().url().max(1024) })
  .meta({ id: "PushUnsubscribeBody" });
