import { z } from "zod";
import { createDocument, type ZodOpenApiObject } from "zod-openapi";
import { env } from "../env";
import {
  MessageModelSchema,
  ConversationModelSchema,
  ConversationMemberModelSchema,
  AttachmentModelSchema,
  ReactionModelSchema,
  UserModelSchema,
  PushSubscriptionModelSchema,
} from "../generated/zod/schemas/variants/pure";
import { commonResponses, errorResponseSchema } from "./openapi-shared";

/**
 * Lightweight public user shape — what we return from search, conversation
 * members, message senders. Drops email where we don't want it leaked.
 */
const publicUserSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    email: z.string().optional(),
    image: z.string().nullable().optional(),
    lastActiveAt: z.date().nullable().optional(),
  })
  .meta({ id: "PublicUser" });

const okSchema = z.object({ ok: z.literal(true) }).meta({ id: "OkResponse" });

const healthStatusSchema = z
  .object({
    status: z.enum(["ok", "degraded"]),
    db: z.enum(["ok", "fail"]),
    redis: z.enum(["ok", "fail"]),
  })
  .meta({ id: "HealthStatus" });

const searchUserResultSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    image: z.string().nullable(),
    lastActiveAt: z.date().nullable(),
    online: z.boolean(),
  })
  .meta({ id: "UserSearchResult" });

const conversationWithMetaSchema = ConversationModelSchema.pick({
  id: true,
  type: true,
  name: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
  version: true,
})
  .extend({
    unreadCount: z.number().int().nonnegative(),
    muted: z.boolean(),
    members: z.array(
      ConversationMemberModelSchema.pick({
        id: true,
        conversationId: true,
        userId: true,
        role: true,
        joinedAt: true,
      }).extend({
        user: publicUserSchema,
      }),
    ),
    lastMessage: z
      .object({
        id: z.string(),
        plainContent: z.string(),
        createdAt: z.date(),
        sender: z.object({ id: z.string(), name: z.string() }),
      })
      .nullable(),
  })
  .meta({ id: "ConversationWithMeta" });

const conversationsPageSchema = z
  .object({
    conversations: z.array(conversationWithMetaSchema),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: "ConversationsPage" });

const messageWithRelationsSchema = MessageModelSchema.pick({
  id: true,
  conversationId: true,
  senderId: true,
  content: true,
  plainContent: true,
  type: true,
  replyToId: true,
  editedAt: true,
  deletedAt: true,
  createdAt: true,
  seq: true,
  clientMessageId: true,
})
  .extend({
    sender: publicUserSchema.optional(),
    attachments: z.array(
      AttachmentModelSchema.pick({
        id: true,
        url: true,
        contentType: true,
        filename: true,
        size: true,
        width: true,
        height: true,
      }),
    ),
    reactions: z
      .array(
        ReactionModelSchema.pick({
          id: true,
          emoji: true,
          userId: true,
        }).extend({
          user: z.object({ id: z.string(), name: z.string() }),
        }),
      )
      .optional(),
    replyTo: z
      .object({
        id: z.string(),
        content: z.unknown(),
        plainContent: z.string(),
        senderId: z.string(),
        deletedAt: z.date().nullable().optional(),
        sender: z.object({ id: z.string(), name: z.string() }),
      })
      .nullable()
      .optional(),
  })
  .meta({ id: "MessageWithRelations" });

// ─── Request bodies ──────────────────────────────────────────

const tiptapDocSchema = z
  .object({
    type: z.literal("doc"),
    content: z.array(z.unknown()).optional(),
  })
  .meta({ id: "TiptapDoc" });

const createConversationBodySchema = z
  .object({
    type: z.enum(["direct", "group"]),
    name: z.string().min(1).max(100).optional(),
    memberIds: z.array(z.string()).min(1),
  })
  .meta({ id: "CreateConversationBody" });

const renameConversationBodySchema = z
  .object({ name: z.string().min(1).max(100) })
  .meta({ id: "RenameConversationBody" });

const addMembersBodySchema = z
  .object({
    userIds: z.array(z.string()).min(1),
    name: z.string().min(1).max(100).optional(),
  })
  .meta({ id: "AddMembersBody" });

const sendMessageBodySchema = z
  .object({
    content: tiptapDocSchema.optional(),
    replyToId: z.string().optional(),
    clientMessageId: z.string().max(256).optional(),
    attachmentIds: z.array(z.string()).optional(),
  })
  .meta({ id: "SendMessageBody" });

const editMessageBodySchema = z
  .object({ content: tiptapDocSchema })
  .meta({ id: "EditMessageBody" });

const markReadBodySchema = z
  .object({ messageId: z.string() })
  .meta({ id: "MarkReadBody" });

const muteBodySchema = z
  .object({ muted: z.boolean() })
  .meta({ id: "MuteBody" });

const reactionBodySchema = z
  .object({ emoji: z.string().min(1).max(16) })
  .meta({ id: "ReactionBody" });

const uploadUrlBodySchema = z
  .object({
    filename: z.string().min(1).max(255),
    contentType: z.string(),
    size: z.number().int().positive(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  })
  .meta({ id: "UploadUrlBody" });

const uploadUrlResponseSchema = z
  .object({
    attachmentId: z.string(),
    uploadUrl: z.string().url(),
    publicUrl: z.string().url(),
    expiresIn: z.number().int().positive(),
  })
  .meta({ id: "UploadUrlResponse" });

const connectionTokenResponseSchema = z
  .object({ token: z.string() })
  .meta({ id: "CentrifugoConnectionToken" });

const subscriptionTokenBodySchema = z
  .object({ channel: z.string() })
  .meta({ id: "CentrifugoSubscriptionTokenBody" });

const pushSubscribeBodySchema = z
  .object({
    endpoint: z.string().url(),
    keys: z.object({
      p256dh: z.string(),
      auth: z.string(),
    }),
  })
  .meta({ id: "PushSubscribeBody" });

const onlineUsersBodySchema = z
  .object({
    userIds: z.array(z.string()).min(1).max(200),
  })
  .meta({ id: "OnlineUsersBody" });

// ─── Path helpers ────────────────────────────────────────────

const sessionCookie = {
  cookie: z.object({
    "better-auth.session_token": z.string().meta({
      description:
        "Better-auth session cookie. The browser sends it automatically when logged in; document here so 'Try it' in the docs UI knows the name.",
    }),
  }),
};

const jsonBody = <T extends z.ZodTypeAny>(schema: T) => ({
  content: { "application/json": { schema } },
});

const jsonResponse = <T extends z.ZodTypeAny>(
  description: string,
  schema: T,
) => ({
  description,
  content: { "application/json": { schema } },
});

/** Build the full OpenAPI 3.1 document that describes the HTTP surface. */
export function buildOpenApiDocument() {
  const doc: ZodOpenApiObject = {
    openapi: "3.1.0",
    info: {
      title: "Chat App API",
      version: "0.1.0",
      description:
        "HTTP surface of the chat backend. Realtime events flow over Centrifugo WebSocket channels and are not documented here — the HTTP endpoints below cover authentication, conversation + message CRUD, attachments, presence, push subscriptions, and health probes.",
    },
    servers: [
      {
        url: env.BETTER_AUTH_URL ?? "http://localhost:3001",
        description: "Current deployment",
      },
    ],
    tags: [
      { name: "Health", description: "Liveness + readiness probes" },
      { name: "Auth", description: "Better-auth session endpoints" },
      { name: "Users", description: "User directory + presence" },
      { name: "Conversations", description: "Conversation + membership CRUD" },
      { name: "Messages", description: "Messages, reactions, typing, reads" },
      { name: "Search", description: "Full-text search across messages" },
      {
        name: "Attachments",
        description: "S3 presigned upload + authenticated download",
      },
      { name: "Centrifugo", description: "Realtime connection + subscription tokens" },
      { name: "Push", description: "Web Push subscription lifecycle" },
    ],
    paths: {
      "/livez": {
        get: {
          tags: ["Health"],
          summary: "Liveness probe",
          description:
            "Always returns 200 while the process is up. Dependency status is reported in the body but does not change the HTTP code — restarting on a degraded dependency would usually make things worse.",
          responses: {
            "200": jsonResponse("Process is alive", healthStatusSchema),
          },
        },
      },
      "/health": {
        get: {
          tags: ["Health"],
          summary: "Liveness probe (legacy alias)",
          description: "Alias for `/livez` kept for uptime monitors that default to `/health`.",
          responses: {
            "200": jsonResponse("Process is alive", healthStatusSchema),
          },
        },
      },
      "/readyz": {
        get: {
          tags: ["Health"],
          summary: "Readiness probe",
          description:
            "503 when DB or Redis is unreachable so an LB pulls this instance from rotation until it recovers.",
          responses: {
            "200": jsonResponse("Ready to serve traffic", healthStatusSchema),
            "503": jsonResponse(
              "Dependencies unhealthy — pull from rotation",
              healthStatusSchema,
            ),
          },
        },
      },

      "/api/auth/{path}": {
        description:
          "Catch-all for better-auth endpoints (sign-in, sign-up, sign-out, session, update-user, …). See https://www.better-auth.com/docs for the full contract.",
        parameters: [
          {
            name: "path",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Better-auth route suffix",
          },
        ],
        get: {
          tags: ["Auth"],
          summary: "Better-auth GET handler",
          responses: {
            "200": { description: "See better-auth docs" },
            "401": commonResponses.Unauthorized,
          },
        },
        post: {
          tags: ["Auth"],
          summary: "Better-auth POST handler",
          responses: {
            "200": { description: "See better-auth docs" },
            "400": commonResponses.BadRequest,
            "401": commonResponses.Unauthorized,
            "429": commonResponses.TooManyRequests,
          },
        },
      },

      "/api/users/search": {
        get: {
          tags: ["Users"],
          summary: "Search users by name or email",
          requestParams: {
            ...sessionCookie,
            query: z.object({
              q: z
                .string()
                .min(2)
                .max(64)
                .meta({ description: "Search query (2–64 chars)." }),
            }),
          },
          responses: {
            "200": jsonResponse(
              "Up to 20 matching users",
              z.array(searchUserResultSchema),
            ),
            "400": commonResponses.BadRequest,
            "401": commonResponses.Unauthorized,
            "429": commonResponses.TooManyRequests,
          },
        },
      },
      "/api/users/online": {
        post: {
          tags: ["Users"],
          summary: "Batch presence lookup",
          requestParams: sessionCookie,
          requestBody: jsonBody(onlineUsersBodySchema),
          responses: {
            "200": jsonResponse(
              "Subset of supplied ids currently online",
              z.object({ online: z.array(z.string()) }),
            ),
            "400": commonResponses.BadRequest,
            "401": commonResponses.Unauthorized,
          },
        },
      },

      "/api/init": {
        get: {
          tags: ["Conversations"],
          summary: "Single boot call — conversations + centrifugo token",
          description:
            "Client calls this once on app startup. Returns the first page of conversations along with a Centrifugo connection JWT so the socket can open immediately without a second round-trip.",
          requestParams: {
            ...sessionCookie,
            query: z.object({
              limit: z.coerce
                .number()
                .int()
                .positive()
                .max(100)
                .optional()
                .meta({ description: "Page size (default 50, max 100)" }),
            }),
          },
          responses: {
            "200": jsonResponse(
              "Conversation list + Centrifugo token",
              z.object({
                conversations: z.array(conversationWithMetaSchema),
                nextCursor: z.string().nullable(),
                centrifugoToken: z.string(),
              }),
            ),
            "401": commonResponses.Unauthorized,
          },
        },
      },
      "/api/conversations": {
        get: {
          tags: ["Conversations"],
          summary: "List conversations (paginated)",
          requestParams: {
            ...sessionCookie,
            query: z.object({
              limit: z.coerce
                .number()
                .int()
                .positive()
                .max(100)
                .optional(),
              before: z.string().optional().meta({
                description:
                  "ISO timestamp cursor — only conversations older than this.",
              }),
            }),
          },
          responses: {
            "200": jsonResponse(
              "Page of conversations",
              conversationsPageSchema,
            ),
            "401": commonResponses.Unauthorized,
          },
        },
        post: {
          tags: ["Conversations"],
          summary: "Create conversation",
          requestParams: sessionCookie,
          requestBody: jsonBody(createConversationBodySchema),
          responses: {
            "201": jsonResponse(
              "Conversation created",
              conversationWithMetaSchema,
            ),
            "200": jsonResponse(
              "Existing direct conversation returned",
              conversationWithMetaSchema,
            ),
            "400": commonResponses.BadRequest,
            "401": commonResponses.Unauthorized,
          },
        },
      },
      "/api/conversations/{id}": {
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        get: {
          tags: ["Conversations"],
          summary: "Get conversation by id",
          requestParams: sessionCookie,
          responses: {
            "200": jsonResponse("Conversation", conversationWithMetaSchema),
            "401": commonResponses.Unauthorized,
            "404": commonResponses.NotFound,
          },
        },
        put: {
          tags: ["Conversations"],
          summary: "Rename group",
          requestParams: sessionCookie,
          requestBody: jsonBody(renameConversationBodySchema),
          responses: {
            "200": jsonResponse("Updated conversation", conversationWithMetaSchema),
            "400": commonResponses.BadRequest,
            "401": commonResponses.Unauthorized,
            "403": commonResponses.Forbidden,
            "404": commonResponses.NotFound,
          },
        },
      },
      "/api/conversations/{id}/members": {
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        post: {
          tags: ["Conversations"],
          summary: "Add members (promotes a direct chat to a group when expanding)",
          requestParams: sessionCookie,
          requestBody: jsonBody(addMembersBodySchema),
          responses: {
            "200": jsonResponse(
              "Add result",
              z.object({
                added: z.number().int().nonnegative(),
                promoted: z.boolean(),
              }),
            ),
            "400": commonResponses.BadRequest,
            "401": commonResponses.Unauthorized,
            "404": commonResponses.NotFound,
          },
        },
      },
      "/api/conversations/{id}/members/{userId}": {
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "userId", in: "path", required: true, schema: { type: "string" } },
        ],
        delete: {
          tags: ["Conversations"],
          summary: "Remove member / leave group",
          requestParams: sessionCookie,
          responses: {
            "200": jsonResponse("Removed", okSchema),
            "401": commonResponses.Unauthorized,
            "403": commonResponses.Forbidden,
            "404": commonResponses.NotFound,
          },
        },
      },

      "/api/conversations/{id}/messages": {
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        get: {
          tags: ["Messages"],
          summary: "List messages (paginated)",
          requestParams: {
            ...sessionCookie,
            query: z.object({
              limit: z.coerce
                .number()
                .int()
                .positive()
                .max(100)
                .optional(),
              before: z.string().optional(),
              anchor: z.string().optional().meta({
                description:
                  "Message id to center the page on (jump-to-message flow).",
              }),
            }),
          },
          responses: {
            "200": jsonResponse(
              "Page of messages + read receipts",
              z.object({
                messages: z.array(messageWithRelationsSchema),
                readPositions: z.array(
                  z.object({
                    userId: z.string(),
                    name: z.string(),
                    image: z.string().nullable(),
                    lastReadMessageId: z.string().nullable(),
                  }),
                ),
                nextCursor: z.string().nullable(),
              }),
            ),
            "401": commonResponses.Unauthorized,
            "403": commonResponses.Forbidden,
          },
        },
        post: {
          tags: ["Messages"],
          summary: "Send message",
          description:
            "Accepts a canonicalized Tiptap JSON doc. The server rejects anything that isn't structural JSON and rewrites mention labels to the canonical DB name before persisting.",
          requestParams: sessionCookie,
          requestBody: jsonBody(sendMessageBodySchema),
          responses: {
            "201": jsonResponse("Created", messageWithRelationsSchema),
            "200": jsonResponse(
              "Retry — existing message returned via clientMessageId",
              messageWithRelationsSchema,
            ),
            "400": commonResponses.BadRequest,
            "401": commonResponses.Unauthorized,
            "403": commonResponses.Forbidden,
            "413": {
              description: "Content exceeds the size ceiling",
              content: { "application/json": { schema: errorResponseSchema } },
            },
            "429": commonResponses.TooManyRequests,
          },
        },
      },
      "/api/conversations/{id}/messages/{messageId}": {
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "messageId", in: "path", required: true, schema: { type: "string" } },
        ],
        put: {
          tags: ["Messages"],
          summary: "Edit message",
          requestParams: sessionCookie,
          requestBody: jsonBody(editMessageBodySchema),
          responses: {
            "200": jsonResponse("Edited message", messageWithRelationsSchema),
            "400": commonResponses.BadRequest,
            "401": commonResponses.Unauthorized,
            "404": commonResponses.NotFound,
            "413": {
              description: "Content exceeds the size ceiling",
              content: { "application/json": { schema: errorResponseSchema } },
            },
          },
        },
        delete: {
          tags: ["Messages"],
          summary: "Soft-delete message",
          requestParams: sessionCookie,
          responses: {
            "200": jsonResponse("Deleted", okSchema),
            "401": commonResponses.Unauthorized,
            "404": commonResponses.NotFound,
          },
        },
      },
      "/api/conversations/{id}/messages/{messageId}/reactions": {
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "messageId", in: "path", required: true, schema: { type: "string" } },
        ],
        post: {
          tags: ["Messages"],
          summary: "Add reaction",
          requestParams: sessionCookie,
          requestBody: jsonBody(reactionBodySchema),
          responses: {
            "201": jsonResponse(
              "Reaction added (idempotent upsert)",
              ReactionModelSchema.pick({
                id: true,
                messageId: true,
                userId: true,
                emoji: true,
                createdAt: true,
              }),
            ),
            "400": commonResponses.BadRequest,
            "401": commonResponses.Unauthorized,
            "404": commonResponses.NotFound,
          },
        },
      },
      "/api/conversations/{id}/messages/{messageId}/reactions/{emoji}": {
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "messageId", in: "path", required: true, schema: { type: "string" } },
          {
            name: "emoji",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "URL-encoded emoji grapheme cluster.",
          },
        ],
        delete: {
          tags: ["Messages"],
          summary: "Remove reaction",
          requestParams: sessionCookie,
          responses: {
            "200": jsonResponse("Removed", okSchema),
            "400": commonResponses.BadRequest,
            "401": commonResponses.Unauthorized,
            "404": commonResponses.NotFound,
          },
        },
      },
      "/api/conversations/{id}/read": {
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        post: {
          tags: ["Messages"],
          summary: "Mark conversation as read",
          requestParams: sessionCookie,
          requestBody: jsonBody(markReadBodySchema),
          responses: {
            "200": jsonResponse("Marked", okSchema),
            "400": commonResponses.BadRequest,
            "401": commonResponses.Unauthorized,
            "404": commonResponses.NotFound,
          },
        },
      },
      "/api/conversations/{id}/mute": {
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        post: {
          tags: ["Messages"],
          summary: "Mute / unmute conversation",
          requestParams: sessionCookie,
          requestBody: jsonBody(muteBodySchema),
          responses: {
            "200": jsonResponse(
              "Updated mute state",
              z.object({ muted: z.boolean() }),
            ),
            "400": commonResponses.BadRequest,
            "401": commonResponses.Unauthorized,
            "404": commonResponses.NotFound,
          },
        },
      },
      "/api/conversations/{id}/typing": {
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        post: {
          tags: ["Messages"],
          summary: "Typing indicator ping",
          requestParams: sessionCookie,
          responses: {
            "200": jsonResponse("Broadcast queued", okSchema),
            "401": commonResponses.Unauthorized,
            "403": commonResponses.Forbidden,
            "429": commonResponses.TooManyRequests,
          },
        },
      },

      "/api/conversations/{id}/search": {
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        get: {
          tags: ["Search"],
          summary: "Search within a single conversation",
          requestParams: {
            ...sessionCookie,
            query: z.object({ q: z.string().min(2).max(128) }),
          },
          responses: {
            "200": jsonResponse(
              "Ranked results (trigram + ILIKE)",
              z.object({ results: z.array(messageWithRelationsSchema) }),
            ),
            "400": commonResponses.BadRequest,
            "401": commonResponses.Unauthorized,
            "403": commonResponses.Forbidden,
          },
        },
      },
      "/api/search": {
        get: {
          tags: ["Search"],
          summary: "Global search across all user's conversations",
          requestParams: {
            ...sessionCookie,
            query: z.object({ q: z.string().min(2).max(128) }),
          },
          responses: {
            "200": jsonResponse(
              "Ranked results",
              z.object({ results: z.array(messageWithRelationsSchema) }),
            ),
            "400": commonResponses.BadRequest,
            "401": commonResponses.Unauthorized,
          },
        },
      },

      "/api/attachments/upload-url": {
        post: {
          tags: ["Attachments"],
          summary: "Mint a presigned S3 upload URL",
          description:
            "Client sends file metadata; server allocates an attachment row, presigns a PUT URL, and returns both so the client uploads directly to S3 — the app server never handles attachment bytes.",
          requestParams: sessionCookie,
          requestBody: jsonBody(uploadUrlBodySchema),
          responses: {
            "201": jsonResponse("Presigned URL minted", uploadUrlResponseSchema),
            "400": commonResponses.BadRequest,
            "401": commonResponses.Unauthorized,
            "413": {
              description: "Per-user storage quota exceeded",
              content: { "application/json": { schema: errorResponseSchema } },
            },
            "415": {
              description: "Content type not allow-listed",
              content: { "application/json": { schema: errorResponseSchema } },
            },
            "429": commonResponses.TooManyRequests,
          },
        },
      },
      "/api/attachments/{id}/download": {
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        get: {
          tags: ["Attachments"],
          summary: "302-redirect to an authenticated download URL",
          description:
            "Issues a short-lived signed URL with Content-Disposition: attachment so the browser downloads instead of rendering inline.",
          requestParams: sessionCookie,
          responses: {
            "302": {
              description: "Redirect to presigned download URL",
            },
            "401": commonResponses.Unauthorized,
            "403": commonResponses.Forbidden,
            "404": commonResponses.NotFound,
          },
        },
      },

      "/api/centrifugo/connection-token": {
        post: {
          tags: ["Centrifugo"],
          summary: "Mint a Centrifugo connection JWT",
          description:
            "Returned JWT carries a `subs` claim that auto-subscribes the client to its personal `user:{userId}` channel. No connect proxy needed.",
          requestParams: sessionCookie,
          responses: {
            "200": jsonResponse("JWT", connectionTokenResponseSchema),
            "401": commonResponses.Unauthorized,
          },
        },
      },
      "/api/centrifugo/subscription-token": {
        post: {
          tags: ["Centrifugo"],
          summary: "Mint a subscription JWT for a presence channel",
          description:
            "Only `presence:conv_{id}` channels are gated through this endpoint — the user's own `user:{userId}` channel is auto-subscribed via the connection token.",
          requestParams: sessionCookie,
          requestBody: jsonBody(subscriptionTokenBodySchema),
          responses: {
            "200": jsonResponse("JWT", connectionTokenResponseSchema),
            "400": commonResponses.BadRequest,
            "401": commonResponses.Unauthorized,
            "403": commonResponses.Forbidden,
          },
        },
      },

      "/api/push/vapid-public-key": {
        get: {
          tags: ["Push"],
          summary: "Fetch VAPID public key",
          requestParams: sessionCookie,
          responses: {
            "200": jsonResponse(
              "VAPID public key",
              z.object({ key: z.string() }),
            ),
            "401": commonResponses.Unauthorized,
            "503": {
              description: "Push not configured (VAPID_* missing)",
              content: { "application/json": { schema: errorResponseSchema } },
            },
          },
        },
      },
      "/api/push/subscribe": {
        post: {
          tags: ["Push"],
          summary: "Register a Push subscription for this browser",
          requestParams: sessionCookie,
          requestBody: jsonBody(pushSubscribeBodySchema),
          responses: {
            "200": jsonResponse("Subscribed", okSchema),
            "400": commonResponses.BadRequest,
            "401": commonResponses.Unauthorized,
            "503": {
              description: "Push not configured",
              content: { "application/json": { schema: errorResponseSchema } },
            },
          },
        },
      },
      "/api/push/unsubscribe": {
        post: {
          tags: ["Push"],
          summary: "Unregister a Push subscription",
          requestParams: sessionCookie,
          requestBody: jsonBody(
            z.object({ endpoint: z.string().url() }).meta({
              id: "PushUnsubscribeBody",
            }),
          ),
          responses: {
            "200": jsonResponse("Unsubscribed", okSchema),
            "400": commonResponses.BadRequest,
            "401": commonResponses.Unauthorized,
          },
        },
      },

      "/api/me/active": {
        post: {
          tags: ["Users"],
          summary: "Heartbeat — bump `lastActiveAt` for presence",
          requestParams: sessionCookie,
          responses: {
            "200": jsonResponse("ok", okSchema),
            "401": commonResponses.Unauthorized,
          },
        },
      },
      "/api/me/broadcast-profile": {
        post: {
          tags: ["Users"],
          summary: "Broadcast profile change to peers",
          description:
            "Called by the client after `authClient.updateUser` so sidebars / headers / message avatars refresh in real time for everyone sharing a conversation.",
          requestParams: sessionCookie,
          responses: {
            "200": jsonResponse("ok", okSchema),
            "401": commonResponses.Unauthorized,
            "404": commonResponses.NotFound,
          },
        },
      },
    },
    components: {
      // Surface generated Prisma-derived model schemas so consumers can
      // reference them directly in codegen.
      schemas: {
        User: UserModelSchema,
        Conversation: ConversationModelSchema,
        ConversationMember: ConversationMemberModelSchema,
        Message: MessageModelSchema,
        Reaction: ReactionModelSchema,
        Attachment: AttachmentModelSchema,
        PushSubscription: PushSubscriptionModelSchema,
      },
    },
  };

  return createDocument(doc);
}

// Cached single build — the doc is deterministic, so building once at
// first access and serving the same JSON on every hit avoids recomputing
// the schema registration on every /openapi.json request.
let cached: ReturnType<typeof createDocument> | null = null;
export function getOpenApiDocument() {
  if (!cached) cached = buildOpenApiDocument();
  return cached;
}
