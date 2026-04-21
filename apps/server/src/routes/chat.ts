import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";
import { prisma } from "../db";
import * as centrifugo from "../lib/centrifugo";
import { withRealtime } from "../lib/realtime";
import {
  getConversationMemberIds,
  invalidateConversation,
} from "../lib/member-cache";
import { invalidateConversationMeta } from "../lib/conversation-cache";
import { invalidateUserProfile } from "../lib/user-cache";
import { pushToUsers } from "../lib/push";
import { logger } from "../lib/logger";
import { headObjectSize, deleteObject, keyFromPublicUrl } from "../lib/s3";
import {
  canonicalizeFromJson,
  canonicalizeMentionLabels,
  extractMentions,
  extractPlainText,
  isEmptyContent,
  MAX_MESSAGE_PLAIN_CHARS,
  type MessageContentJson,
} from "../lib/message-content";
import {
  sendMessageLimiter,
  typingLimiter,
  searchLimiter,
  generalLimiter,
} from "../middleware/rate-limit";
import { validate } from "../http/validate";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
} from "../http/errors";
import {
  AddMembersBodySchema,
  CreateConversationBodySchema,
  EditMessageBodySchema,
  ListConversationsQuerySchema,
  ListMessagesQuerySchema,
  MarkReadBodySchema,
  MuteBodySchema,
  ReactionBodySchema,
  RenameConversationBodySchema,
  SearchQuerySchema,
  SendMessageBodySchema,
} from "../http/schemas";

const router: Router = Router();

/** Extract a single string param (Express 5 params can be string | string[]) */
function param(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}


/**
 * Selects and shapes the conversation payload used by `conversation_updated`
 * and `conversation_joined` events. The shape matches what the client expects
 * for a conversation list entry (minus per-user fields: unreadCount, muted).
 */
const CONVERSATION_EVENT_SELECT = {
  id: true,
  type: true,
  name: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
  version: true,
  members: {
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
          lastActiveAt: true,
        },
      },
    },
  },
} as const;

/**
 * Broadcast an event to every member of a conversation via their personal
 * `user:{userId}` channel. Each member's client dispatches by event.type and
 * event.conversationId. Pass `exclude` to skip a specific user (typing).
 *
 * `idempotencyKey` is required so Centrifugo can dedupe retries. For events
 * wrapped in a DB transaction, prefer `withRealtime` so publishes fire only
 * after commit.
 */
async function broadcastToConversation(
  conversationId: string,
  data: unknown,
  idempotencyKey: string,
  opts: { exclude?: string } = {},
) {
  const userIds = await getConversationMemberIds(conversationId);
  const filtered = opts.exclude
    ? userIds.filter((id) => id !== opts.exclude)
    : userIds;
  if (filtered.length === 0) return;
  const channels = filtered.map((id) => centrifugo.userChannel(id));
  await centrifugo.broadcast(channels, data, { idempotencyKey });
}

// ─── Init (single call on app startup) ───────────────────────

router.get("/init", requireAuth, async (req, res) => {
  const { user } = req as AuthenticatedRequest;
  const limit = Number(req.query.limit) || 50;

  const [page, token] = await Promise.all([
    getConversationsWithUnread(user.id, { limit }),
    Promise.resolve(
      centrifugo.generateConnectionToken(user.id, {
        name: user.name,
        email: user.email,
      }),
    ),
  ]);

  res.json({
    conversations: page.conversations,
    nextCursor: page.nextCursor,
    centrifugoToken: token,
  });
});

// ─── Create conversation ──────────────────────────────────────

router.post(
  "/conversations",
  requireAuth,
  validate({ body: CreateConversationBodySchema }),
  async (req, res) => {
  const { user } = req as AuthenticatedRequest;
  const { type, name, memberIds } = req.body as {
    type: "direct" | "group";
    name?: string;
    memberIds: string[];
  };

  if (!type || !memberIds?.length) {
    throw new BadRequestError("type and memberIds are required");
  }

  if (type === "direct") {
    if (memberIds.length !== 1) {
      throw new BadRequestError("Direct chats require exactly one other member");
    }

    // Check for existing direct conversation
    const existing = await prisma.conversation.findFirst({
      where: {
        type: "direct",
        AND: [
          { members: { some: { userId: user.id } } },
          { members: { some: { userId: memberIds[0] } } },
        ],
      },
      include: { members: { include: { user: true } } },
    });

    if (existing) {
      res.json(existing);
      return;
    }
  }

  
  const allMemberIds = [user.id, ...memberIds.filter((id) => id !== user.id)];

  
  const conversation = await withRealtime(async (rt) => {
    const conv = await rt.tx.conversation.create({
      data: {
        type,
        name: type === "group" ? name : null,
        createdBy: user.id,
        members: {
          create: allMemberIds.map((userId) => ({
            userId,
            role: userId === user.id ? "owner" : "member",
          })),
        },
      },
      include: { members: { include: { user: true } } },
    });

    if (type === "group") {
      const otherCount = allMemberIds.filter((id) => id !== user.id).length;
      await rt.createSystemMessage(
        conv.id,
        user.id,
        `${user.name} created the group${name ? ` "${name}"` : ""} with ${otherCount} member${otherCount !== 1 ? "s" : ""}`,
      );
    }

    // Tell every member about the new conversation so their sidebar adds it.
    const eventPayload = await rt.tx.conversation.findUniqueOrThrow({
      where: { id: conv.id },
      select: CONVERSATION_EVENT_SELECT,
    });
    await rt.enqueueToConversation(
      conv.id,
      { type: "conversation_updated", conversation: eventPayload },
      `conv_created_${conv.id}`,
    );

    return conv;
  });

  // Cache warms lazily on next read, but invalidate pre-emptively in case a
  // prior (e.g. ghost) entry lingered.
  await Promise.all([
    invalidateConversation(conversation.id),
    invalidateConversationMeta(conversation.id),
  ]);

  res.status(201).json(conversation);
});

// ─── List conversations ───────────────────────────────────────

router.get("/conversations", requireAuth, validate({ query: ListConversationsQuerySchema }), async (req, res) => {
  const { user } = req as AuthenticatedRequest;
  const limit = Number(req.query.limit) || 50;
  const before =
    typeof req.query.before === "string" ? req.query.before : undefined;
  const page = await getConversationsWithUnread(user.id, { limit, before });
  res.json(page);
});

// ─── Get conversation ─────────────────────────────────────────

router.get("/conversations/:id", requireAuth, async (req, res) => {
  const { user } = req as AuthenticatedRequest;
  const id = param(req.params.id);

  const conversation = await prisma.conversation.findFirst({
    where: {
      id,
      members: { some: { userId: user.id } },
    },
    include: {
      members: {
        include: {
          user: { select: { id: true, name: true, email: true, image: true, lastActiveAt: true } },
        },
      },
    },
  });

  if (!conversation) {
    throw new NotFoundError("Conversation not found");
  }

  res.json(conversation);
});

// ─── Update conversation (rename group) ───────────────────────

router.put("/conversations/:id", requireAuth, validate({ body: RenameConversationBodySchema }), async (req, res) => {
  const { user } = req as AuthenticatedRequest;
  const id = param(req.params.id);
  const { name } = req.body as { name: string };

  const member = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId: id, userId: user.id } },
    include: { conversation: true },
  });

  if (!member) {
    throw new NotFoundError("Conversation not found");
  }

  if (member.conversation.type !== "group") {
    throw new BadRequestError("Cannot rename a direct conversation");
  }

  if (member.role !== "owner" && member.role !== "admin") {
    throw new ForbiddenError("Only owners and admins can rename groups");
  }

  const oldName = member.conversation.name;

  const conversation = await withRealtime(async (rt) => {
    const updated = await rt.tx.conversation.update({
      where: { id },
      data: { name, version: { increment: 1 } },
      select: CONVERSATION_EVENT_SELECT,
    });

    await rt.createSystemMessage(
      id,
      user.id,
      `${user.name} renamed the group from "${oldName}" to "${name}"`,
    );

    await rt.enqueueToConversation(
      id,
      { type: "conversation_updated", conversation: updated },
      `conv_updated_${id}_${updated.version}`,
    );

    return updated;
  });

  res.json(conversation);
});

// ─── Add members (promotes a direct chat to a group when expanding) ──

router.post("/conversations/:id/members", requireAuth, validate({ body: AddMembersBodySchema }), async (req, res) => {
  const { user } = req as AuthenticatedRequest;
  const id = param(req.params.id);
  const { userIds, name } = req.body as { userIds: string[]; name?: string };

  if (!userIds?.length) {
    throw new BadRequestError("userIds is required");
  }

  const member = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId: id, userId: user.id } },
    include: { conversation: true },
  });

  if (!member) {
    throw new NotFoundError("Conversation not found");
  }

  const wasDirect = member.conversation.type === "direct";
  // Name only has meaning on promotion; ignored for groups (use PUT to rename).
  const promotionName = wasDirect && name?.trim() ? name.trim() : null;

  const result = await withRealtime(async (rt) => {
    // Skip users who are already members to keep the event payload accurate.
    const existingMemberIds = (
      await rt.tx.conversationMember.findMany({
        where: { conversationId: id, userId: { in: userIds } },
        select: { userId: true },
      })
    ).map((m) => m.userId);

    const trulyNewIds = userIds.filter((uid) => !existingMemberIds.includes(uid));

    const newUsers = await rt.tx.user.findMany({
      where: { id: { in: trulyNewIds } },
      select: { id: true, name: true },
    });

    if (newUsers.length === 0) {
      return { added: 0, promoted: false };
    }

    if (wasDirect) {
      // Promote the *other* original direct member from "member" → "admin"
      // so both original participants can rename / add more people.
      // The creator already has role "owner" so they're unaffected.
      // MUST run before createMany below, otherwise the newly-added users
      // (also role "member") would get swept into the promotion.
      await rt.tx.conversationMember.updateMany({
        where: { conversationId: id, role: "member" },
        data: { role: "admin" },
      });
    }

    await rt.tx.conversationMember.createMany({
      data: newUsers.map((u) => ({
        conversationId: id,
        userId: u.id,
        role: "member" as const,
      })),
    });

    // A direct chat becomes a group the moment it gains a 3rd member.
    await rt.tx.conversation.update({
      where: { id },
      data: {
        ...(wasDirect
          ? {
              type: "group" as const,
              ...(promotionName ? { name: promotionName } : {}),
            }
          : {}),
        version: { increment: 1 },
      },
    });

    const names = newUsers.map((u) => u.name).join(", ");
    const systemText = wasDirect
      ? promotionName
        ? `${user.name} added ${names} and created the group "${promotionName}"`
        : `${user.name} added ${names} and turned this into a group`
      : `${user.name} added ${names}`;
    await rt.createSystemMessage(id, user.id, systemText);

    // Re-read with up-to-date members list + version for the event.
    const updated = await rt.tx.conversation.findUniqueOrThrow({
      where: { id },
      select: CONVERSATION_EVENT_SELECT,
    });

    // All current members (including newly added) get the shared update.
    await rt.enqueueToConversation(
      id,
      { type: "conversation_updated", conversation: updated },
      `conv_updated_${id}_${updated.version}`,
    );

    return { added: newUsers.length, promoted: wasDirect };
  });

  await Promise.all([
    invalidateConversation(id),
    invalidateConversationMeta(id),
  ]);

  res.json(result);
});

// ─── Remove member / leave group ──────────────────────────────

router.delete("/conversations/:id/members/:userId", requireAuth, async (req, res) => {
  const { user } = req as AuthenticatedRequest;
  const id = param(req.params.id);
  const targetUserId = param(req.params.userId);
  const isSelf = user.id === targetUserId;

  const member = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId: id, userId: user.id } },
    include: { conversation: true },
  });

  if (!member || member.conversation.type !== "group") {
    throw new NotFoundError("Group not found");
  }

  if (!isSelf && member.role !== "owner" && member.role !== "admin") {
    throw new ForbiddenError("Only owners and admins can remove members");
  }

  await withRealtime(async (rt) => {
    // Verify the target is currently a member and capture name for the system message.
    const target = await rt.tx.conversationMember.findUnique({
      where: {
        conversationId_userId: { conversationId: id, userId: targetUserId },
      },
      include: { user: { select: { name: true } } },
    });
    if (!target) return;

    await rt.tx.conversationMember.delete({ where: { id: target.id } });

    await rt.tx.conversation.update({
      where: { id },
      data: { version: { increment: 1 } },
    });

    if (isSelf) {
      await rt.createSystemMessage(id, user.id, `${user.name} left the group`);
    } else {
      await rt.createSystemMessage(
        id,
        user.id,
        `${user.name} removed ${target.user.name}`,
      );
    }

    // Tell the removed user they're gone so their sidebar drops the entry
    // and their realtime listener stops caring about this conversation.
    rt.enqueue({
      channels: [centrifugo.userChannel(targetUserId)],
      data: { type: "conversation_left", conversationId: id },
      idempotencyKey: `conv_left_${targetUserId}_${id}`,
    });

    // And tell remaining members about the new member list / version.
    const updated = await rt.tx.conversation.findUniqueOrThrow({
      where: { id },
      select: CONVERSATION_EVENT_SELECT,
    });
    await rt.enqueueToConversation(
      id,
      { type: "conversation_updated", conversation: updated },
      `conv_updated_${id}_${updated.version}`,
    );
  });

  await Promise.all([
    invalidateConversation(id),
    invalidateConversationMeta(id),
  ]);

  res.json({ ok: true });
});

// ─── Send message ─────────────────────────────────────────────

const MESSAGE_INCLUDE = {
  replyTo: {
    select: {
      id: true,
      content: true,
      plainContent: true,
      senderId: true,
      sender: { select: { id: true, name: true } },
    },
  },
  attachments: {
    select: {
      id: true,
      url: true,
      contentType: true,
      filename: true,
      size: true,
      width: true,
      height: true,
    },
  },
} as const;

router.post("/conversations/:id/messages", requireAuth, sendMessageLimiter, validate({ body: SendMessageBodySchema }), async (req, res) => {
  const { user } = req as AuthenticatedRequest;
  const id = param(req.params.id);
  const { content, replyToId, clientMessageId, attachmentIds } = req.body as {
    content?: unknown;
    replyToId?: string;
    clientMessageId?: string;
    attachmentIds?: string[];
  };

  const attachmentIdList = Array.isArray(attachmentIds) ? attachmentIds : [];

  // Canonicalize incoming Tiptap JSON. Rejects anything that isn't structural
  // JSON. Round-trip through the extension schema strips unknown nodes,
  // forbidden marks and stray attrs — defense in depth for the display path.
  let canonJson: MessageContentJson | null = null;
  let plainText = "";
  if (content !== undefined && content !== null) {
    try {
      canonJson = canonicalizeFromJson(content);
      plainText = extractPlainText(canonJson);
    } catch {
      throw new BadRequestError("content must be a Tiptap JSON document");
    }
  }

  if (plainText.length > MAX_MESSAGE_PLAIN_CHARS) {
    throw new PayloadTooLargeError(
      `content exceeds ${MAX_MESSAGE_PLAIN_CHARS} characters`,
    );
  }

  const hasBody = canonJson !== null && !isEmptyContent(canonJson);
  if (!hasBody && attachmentIdList.length === 0) {
    throw new BadRequestError("content or attachments required");
  }

  const member = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId: id, userId: user.id } },
  });

  if (!member) {
    throw new ForbiddenError("Not a member of this conversation");
  }

  // Retry-safe dedup: if the client already sent this message and we stored
  // it, return the stored row. The unique index on (conversationId, clientMessageId)
  // also protects against two concurrent inserts with the same key.
  if (clientMessageId !== undefined) {
    if (typeof clientMessageId !== "string" || clientMessageId.length > 256) {
      throw new BadRequestError("clientMessageId must be ≤256 chars");
    }
  }
  if (clientMessageId) {
    const existing = await prisma.message.findUnique({
      where: {
        conversationId_clientMessageId: {
          conversationId: id,
          clientMessageId,
        },
      },
      include: MESSAGE_INCLUDE,
    });
    if (existing) {
      res.status(200).json(existing);
      return;
    }
  }

  if (replyToId) {
    const replyTarget = await prisma.message.findFirst({
      where: { id: replyToId, conversationId: id, deletedAt: null },
    });
    if (!replyTarget) {
      throw new NotFoundError("Reply target message not found");
    }
  }

  // Validate attachment ownership + unlinked status *before* the tx to give
  // a clean 400 and keep the tx small.
  if (attachmentIdList.length > 0) {
    const rows = await prisma.attachment.findMany({
      where: { id: { in: attachmentIdList } },
      select: { id: true, uploaderId: true, messageId: true },
    });
    const bad = attachmentIdList.find((aid) => {
      const row = rows.find((r) => r.id === aid);
      return !row || row.uploaderId !== user.id || row.messageId !== null;
    });
    if (bad) {
      throw new BadRequestError(`invalid attachment: ${bad}`);
    }
  }

  const message = await withRealtime(async (rt) => {
    // Atomic per-conversation sequence: UPDATE ... SET current_seq = current_seq + 1
    // runs as a single row-locked op, so concurrent inserts always get distinct seqs.
    const { currentSeq: seq } = await rt.tx.conversation.update({
      where: { id },
      data: { currentSeq: { increment: 1 }, updatedAt: new Date() },
      select: { currentSeq: true },
    });

    // Rewrite every mention node's label to the canonical DB name before
    // storing. Client-supplied labels can't be trusted ("@alice" pointing
    // at Bob's uid would otherwise persist). IDs that don't resolve to a
    // real member of this conversation get filtered out of `mentions`
    // below so they never trigger notifications or mute-bypass.
    let validatedMentions: string[] = [];
    if (canonJson) {
      const rawIds = extractMentions(canonJson);
      if (rawIds.length > 0) {
        const rows = await rt.tx.conversationMember.findMany({
          where: { conversationId: id, userId: { in: rawIds } },
          include: { user: { select: { id: true, name: true } } },
        });
        const lookup = new Map(rows.map((r) => [r.user.id, r.user.name]));
        canonicalizeMentionLabels(canonJson, lookup);
        validatedMentions = rows.map((r) => r.user.id);
      }
    }
    // Recompute plaintext after label rewrites — "@alice" might now read
    // "@Alice Smith" and the search column should reflect it.
    const finalPlainContent = canonJson ? extractPlainText(canonJson) : "";
    const finalStoredContent = canonJson && !isEmptyContent(canonJson)
      ? canonJson
      : ({ type: "doc", content: [] } as MessageContentJson);

    const msg = await rt.tx.message.create({
      data: {
        conversationId: id,
        senderId: user.id,
        content: finalStoredContent,
        plainContent: finalPlainContent,
        type: "text",
        replyToId: replyToId || null,
        seq,
        clientMessageId: clientMessageId ?? null,
      },
    });

    if (attachmentIdList.length > 0) {
      await rt.tx.attachment.updateMany({
        where: {
          id: { in: attachmentIdList },
          uploaderId: user.id,
          messageId: null,
        },
        data: { messageId: msg.id },
      });
    }

    await rt.tx.user.update({
      where: { id: user.id },
      data: { lastActiveAt: new Date() },
    });

    // Denormalized unread counter: bump for every other member.
    await rt.tx.conversationMember.updateMany({
      where: { conversationId: id, userId: { not: user.id } },
      data: { unreadCount: { increment: 1 } },
    });

    // Re-read with relations now that attachments are linked.
    const full = await rt.tx.message.findUniqueOrThrow({
      where: { id: msg.id },
      include: MESSAGE_INCLUDE,
    });

    // `validatedMentions` was built above while canonicalizing labels —
    // already narrowed to actual conversation members.
    const mentions = validatedMentions;

    await rt.enqueueToConversation(
      id,
      {
        type: "message_added",
        conversationId: id,
        message: {
          id: full.id,
          seq: full.seq,
          senderId: user.id,
          senderName: user.name,
          content: full.content,
          plainContent: full.plainContent,
          msgType: full.type,
          replyTo: full.replyTo || null,
          createdAt: full.createdAt,
          clientMessageId: full.clientMessageId,
          attachments: full.attachments,
          mentions,
        },
      },
      `message_${full.id}`,
    );

    return full;
  });

  // Fan out Web Push alongside the Centrifugo broadcast. Recipients:
  // every non-sender, non-muted member plus anyone mentioned (who bypasses
  // mute). The service worker suppresses the notification if any tab of
  // theirs is visible, so active users don't get double-pinged.
  const mentionsInMessage = extractMentions(
    message.content as MessageContentJson,
  );
  const recipients = await prisma.conversationMember.findMany({
    where: {
      conversationId: id,
      userId: { not: user.id },
      OR: [{ muted: false }, { userId: { in: mentionsInMessage } }],
    },
    select: { userId: true },
  });
  if (recipients.length > 0) {
    const preview = message.plainContent.slice(0, 140) || "📎 Attachment";
    pushToUsers(
      recipients.map((r) => r.userId),
      {
        title: user.name,
        body: preview,
        tag: `conv:${id}`,
        url: "/",
      },
    ).catch((err) =>
      logger.error("push dispatch failed", {
        conversationId: id,
        err: err as Error,
      }),
    );
  }

  // Post-commit attachment size verification. Fire-and-forget — doesn't
  // block the response. S3 signs ContentLength in the presigned PUT so
  // compliant backends reject mismatched uploads, but we verify anyway
  // as defense-in-depth against non-strict backends (older MinIO, etc).
  // If a mismatch is detected we delete both the S3 object and the DB
  // row so a cheating client can't retain a too-large file.
  if (message.attachments && message.attachments.length > 0) {
    const linked = message.attachments.map((a) => ({
      id: a.id,
      url: a.url,
      expectedSize: a.size,
    }));
    (async () => {
      for (const a of linked) {
        const key = keyFromPublicUrl(a.url);
        if (!key) continue;
        try {
          const actual = await headObjectSize(key);
          if (actual === null) {
            logger.warn("attachment missing from S3 after link", {
              attachmentId: a.id,
            });
            await prisma.attachment.delete({ where: { id: a.id } }).catch(() => {});
            continue;
          }
          if (actual !== a.expectedSize) {
            logger.warn("attachment size mismatch after upload", {
              attachmentId: a.id,
              expectedSize: a.expectedSize,
              actualSize: actual,
            });
            await deleteObject(key).catch(() => {});
            await prisma.attachment.delete({ where: { id: a.id } }).catch(() => {});
          }
        } catch (err) {
          logger.warn("attachment verification failed", {
            attachmentId: a.id,
            err: err as Error,
          });
        }
      }
    })();
  }

  res.status(201).json(message);
});

// ─── Search messages (scoped + global) ────────────────────────
//
// Both endpoints use the GIN trgm index on messages.content. Ranking blends
// trigram similarity (fuzzy — catches typos) with ILIKE (catches substring
// matches of short queries where similarity is low). Recency breaks ties.

interface SearchRow {
  id: string;
  // `content` is jsonb — returned as a JS object by pg. Kept in the response
  // so a future richer result renderer can format matches with marks intact.
  content: unknown;
  plain_content: string;
  createdAt: Date;
  senderId: string;
  conversationId: string;
  conversation_type: "direct" | "group";
  conversation_name: string | null;
  sender_name: string;
  sender_image: string | null;
}

function shapeSearchResults(rows: SearchRow[]) {
  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    plainContent: r.plain_content,
    createdAt: r.createdAt,
    senderId: r.senderId,
    conversationId: r.conversationId,
    conversation: {
      id: r.conversationId,
      type: r.conversation_type,
      name: r.conversation_name,
    },
    sender: {
      id: r.senderId,
      name: r.sender_name,
      image: r.sender_image,
    },
  }));
}

router.get("/conversations/:id/search", requireAuth, searchLimiter, validate({ query: SearchQuerySchema }), async (req, res) => {
  const { user } = req as AuthenticatedRequest;
  const id = param(req.params.id);
  const q = ((req.query.q as string) || "").trim();

  if (q.length < 2 || q.length > 128) {
    throw new BadRequestError("q must be 2-128 characters");
  }

  const member = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId: id, userId: user.id } },
    select: { id: true },
  });
  if (!member) {
    throw new ForbiddenError("Not a member of this conversation");
  }

  const likePattern = `%${q}%`;
  const rows = await prisma.$queryRaw<SearchRow[]>`
    SELECT m.id,
           m.content,
           m.plain_content,
           m.created_at AS "createdAt",
           m.sender_id AS "senderId",
           m.conversation_id AS "conversationId",
           c.type AS conversation_type,
           c.name AS conversation_name,
           u.name AS sender_name,
           u.image AS sender_image
    FROM messages m
    JOIN "user" u ON u.id = m.sender_id
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.conversation_id = ${id}
      AND m.deleted_at IS NULL
      AND (m.plain_content ILIKE ${likePattern} OR m.plain_content % ${q})
    ORDER BY GREATEST(similarity(m.plain_content, ${q}), 0) DESC,
             m.created_at DESC
    LIMIT 50
  `;

  res.json({ results: shapeSearchResults(rows) });
});

// Global search — all conversations the user is a member of.
// Intended as the foundation for a global Cmd+K modal later.
router.get("/search", requireAuth, searchLimiter, validate({ query: SearchQuerySchema }), async (req, res) => {
  const { user } = req as AuthenticatedRequest;
  const q = ((req.query.q as string) || "").trim();

  if (q.length < 2 || q.length > 128) {
    throw new BadRequestError("q must be 2-128 characters");
  }

  const likePattern = `%${q}%`;
  const rows = await prisma.$queryRaw<SearchRow[]>`
    SELECT m.id,
           m.content,
           m.plain_content,
           m.created_at AS "createdAt",
           m.sender_id AS "senderId",
           m.conversation_id AS "conversationId",
           c.type AS conversation_type,
           c.name AS conversation_name,
           u.name AS sender_name,
           u.image AS sender_image
    FROM messages m
    JOIN "user" u ON u.id = m.sender_id
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM conversation_members cm
        WHERE cm.conversation_id = m.conversation_id
          AND cm.user_id = ${user.id}
      )
      AND (m.plain_content ILIKE ${likePattern} OR m.plain_content % ${q})
    ORDER BY GREATEST(similarity(m.plain_content, ${q}), 0) DESC,
             m.created_at DESC
    LIMIT 50
  `;

  res.json({ results: shapeSearchResults(rows) });
});

// ─── Get messages (paginated, cursor-based by ID) ─────────────

router.get("/conversations/:id/messages", requireAuth, generalLimiter, validate({ query: ListMessagesQuerySchema }), async (req, res) => {
  const { user } = req as AuthenticatedRequest;
  const id = param(req.params.id);
  const before = req.query.before as string | undefined;
  const anchor = req.query.anchor as string | undefined;
  const limit = req.query.limit as string | undefined;

  const member = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId: id, userId: user.id } },
  });

  if (!member) {
    throw new ForbiddenError("Not a member of this conversation");
  }

  const take = Math.min(parseInt(limit || "50", 10) || 50, 100);

  // Anchor mode: fetch a window centered on a specific message id. Used by
  // the "jump to message" flow from search results. Takes precedence over
  // `before`.
  let seqMin: number | null = null;
  let seqMax: number | null = null;
  if (anchor) {
    const anchorMsg = await prisma.message.findFirst({
      where: { id: anchor, conversationId: id },
      select: { seq: true },
    });
    if (anchorMsg) {
      const half = Math.floor(take / 2);
      seqMin = Math.max(0, anchorMsg.seq - half);
      seqMax = anchorMsg.seq + half;
    }
  }

  let cursorDate: Date | undefined;
  if (!anchor && before) {
    const cursorMsg = await prisma.message.findUnique({
      where: { id: before },
      select: { createdAt: true },
    });
    cursorDate = cursorMsg?.createdAt;
  }

  const messages = await prisma.message.findMany({
    where: {
      conversationId: id,
      ...(seqMin !== null && seqMax !== null
        ? { seq: { gte: seqMin, lte: seqMax } }
        : cursorDate
          ? { createdAt: { lt: cursorDate } }
          : {}),
    },
    orderBy: { createdAt: "desc" },
    take,
    include: {
      sender: { select: { id: true, name: true, image: true } },
      replyTo: {
        select: {
          id: true,
          content: true,
          plainContent: true,
          senderId: true,
          deletedAt: true,
          sender: { select: { id: true, name: true } },
        },
      },
      reactions: {
        select: {
          id: true,
          emoji: true,
          userId: true,
          user: { select: { id: true, name: true } },
        },
      },
      attachments: {
        select: {
          id: true,
          url: true,
          contentType: true,
          filename: true,
          size: true,
          width: true,
          height: true,
        },
      },
    },
  });

  // Get read-by info: which members have read up to which message
  const members = await prisma.conversationMember.findMany({
    where: { conversationId: id, lastReadMessageId: { not: null } },
    select: {
      userId: true,
      lastReadMessageId: true,
      user: { select: { id: true, name: true, image: true } },
    },
  });

  res.json({
    messages,
    readPositions: members.map((m) => ({
      userId: m.userId,
      name: m.user.name,
      image: m.user.image,
      lastReadMessageId: m.lastReadMessageId,
    })),
    nextCursor: messages.length === take ? messages[messages.length - 1].id : null,
  });
});

// ─── Edit message ─────────────────────────────────────────────

router.put("/conversations/:id/messages/:messageId", requireAuth, validate({ body: EditMessageBodySchema }), async (req, res) => {
  const { user } = req as AuthenticatedRequest;
  const id = param(req.params.id);
  const messageId = param(req.params.messageId);
  const { content } = req.body as { content?: unknown };

  let canonJson: MessageContentJson;
  let plainText: string;
  try {
    canonJson = canonicalizeFromJson(content);
    plainText = extractPlainText(canonJson);
  } catch {
    throw new BadRequestError("content must be a Tiptap JSON document");
  }

  if (plainText.length > MAX_MESSAGE_PLAIN_CHARS) {
    res
      .status(413)
      .json({ error: `content exceeds ${MAX_MESSAGE_PLAIN_CHARS} characters` });
    return;
  }

  if (isEmptyContent(canonJson)) {
    throw new BadRequestError("content is required");
  }

  const message = await prisma.message.findFirst({
    where: {
      id: messageId,
      conversationId: id,
      senderId: user.id,
      type: "text",
      deletedAt: null,
    },
  });

  if (!message) {
    throw new NotFoundError("Message not found or not yours");
  }

  const updated = await withRealtime(async (rt) => {
    // Same canonicalization as the send path: rewrite mention labels to
    // the DB canonical name. Bob can't get "@alice" reflected on the
    // edited message.
    const rawIds = extractMentions(canonJson);
    if (rawIds.length > 0) {
      const rows = await rt.tx.conversationMember.findMany({
        where: { conversationId: id, userId: { in: rawIds } },
        include: { user: { select: { id: true, name: true } } },
      });
      const lookup = new Map(rows.map((r) => [r.user.id, r.user.name]));
      canonicalizeMentionLabels(canonJson, lookup);
    }
    const finalPlain = extractPlainText(canonJson);

    const u = await rt.tx.message.update({
      where: { id: messageId },
      data: {
        content: canonJson,
        plainContent: finalPlain,
        editedAt: new Date(),
      },
    });
    await rt.enqueueToConversation(
      id,
      {
        type: "message_edited",
        conversationId: id,
        messageId,
        content: u.content,
        editedAt: u.editedAt,
      },
      `message_edited_${messageId}_${u.editedAt!.getTime()}`,
    );
    return u;
  });

  res.json(updated);
});

// ─── Delete message (soft) ────────────────────────────────────

router.delete("/conversations/:id/messages/:messageId", requireAuth, async (req, res) => {
  const { user } = req as AuthenticatedRequest;
  const id = param(req.params.id);
  const messageId = param(req.params.messageId);

  const message = await prisma.message.findFirst({
    where: {
      id: messageId,
      conversationId: id,
      senderId: user.id,
      deletedAt: null,
    },
  });

  if (!message) {
    throw new NotFoundError("Message not found or not yours");
  }

  await withRealtime(async (rt) => {
    await rt.tx.message.update({
      where: { id: messageId },
      data: {
        deletedAt: new Date(),
        // Reset content to an empty Tiptap doc so a renderer can't leak
        // the old text if it ignores deletedAt by mistake.
        content: { type: "doc", content: [] },
        plainContent: "",
      },
    });
    await rt.enqueueToConversation(
      id,
      {
        type: "message_deleted",
        conversationId: id,
        messageId,
      },
      `message_deleted_${messageId}`,
    );
  });

  res.json({ ok: true });
});

// ─── Mark conversation as read ────────────────────────────────

router.post("/conversations/:id/read", requireAuth, validate({ body: MarkReadBodySchema }), async (req, res) => {
  const { user } = req as AuthenticatedRequest;
  const id = param(req.params.id);
  const { messageId } = req.body as { messageId: string };

  if (!messageId) {
    throw new BadRequestError("messageId is required");
  }

  // Verify message exists in this conversation
  const message = await prisma.message.findFirst({
    where: { id: messageId, conversationId: id },
  });

  if (!message) {
    throw new NotFoundError("Message not found");
  }

  await withRealtime(async (rt) => {
    await rt.tx.conversationMember.update({
      where: { conversationId_userId: { conversationId: id, userId: user.id } },
      data: {
        lastReadMessageId: messageId,
        lastReadAt: new Date(),
        unreadCount: 0,
      },
    });
    await rt.tx.user.update({
      where: { id: user.id },
      data: { lastActiveAt: new Date() },
    });
    await rt.enqueueToConversation(
      id,
      {
        type: "read_receipt",
        conversationId: id,
        userId: user.id,
        userName: user.name,
        messageId,
      },
      `read_${user.id}_${id}_${messageId}`,
      { exclude: user.id },
    );
  });

  res.json({ ok: true });
});

// ─── Mute / unmute conversation ───────────────────────────────

router.post("/conversations/:id/mute", requireAuth, validate({ body: MuteBodySchema }), async (req, res) => {
  const { user } = req as AuthenticatedRequest;
  const id = param(req.params.id);
  const { muted } = req.body as { muted: boolean };

  if (typeof muted !== "boolean") {
    throw new BadRequestError("muted (boolean) is required");
  }

  const member = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId: id, userId: user.id } },
  });

  if (!member) {
    throw new NotFoundError("Conversation not found");
  }

  await withRealtime(async (rt) => {
    await rt.tx.conversationMember.update({
      where: { id: member.id },
      data: { muted },
    });
    // Sync mute state across this user's other sessions (phone + laptop etc).
    rt.enqueue({
      channels: [centrifugo.userChannel(user.id)],
      data: {
        type: "conversation_mute_changed",
        conversationId: id,
        muted,
      },
      idempotencyKey: `mute_${user.id}_${id}_${muted ? 1 : 0}_${Date.now()}`,
    });
  });

  res.json({ muted });
});

// ─── Add reaction ─────────────────────────────────────────────

router.post("/conversations/:id/messages/:messageId/reactions", requireAuth, validate({ body: ReactionBodySchema }), async (req, res) => {
  const { user } = req as AuthenticatedRequest;
  const id = param(req.params.id);
  const messageId = param(req.params.messageId);
  const { emoji } = req.body as { emoji?: string };
  const trimmedEmoji = emoji?.trim() ?? "";

  if (!trimmedEmoji) {
    throw new BadRequestError("emoji is required");
  }
  // A grapheme cluster is rarely more than 16 UTF-16 code units (flag
  // emojis, skin tones, ZWJ sequences). Reject anything longer —
  // attacker could otherwise stuff the unique-index with huge strings.
  if (trimmedEmoji.length > 16) {
    throw new BadRequestError("emoji must be ≤16 chars");
  }

  // Verify membership and message exists
  const message = await prisma.message.findFirst({
    where: {
      id: messageId,
      conversationId: id,
      deletedAt: null,
      conversation: { members: { some: { userId: user.id } } },
    },
  });

  if (!message) {
    throw new NotFoundError("Message not found");
  }

  const reaction = await withRealtime(async (rt) => {
    const r = await rt.tx.reaction.upsert({
      where: {
        messageId_userId_emoji: {
          messageId,
          userId: user.id,
          emoji: trimmedEmoji,
        },
      },
      create: { messageId, userId: user.id, emoji: trimmedEmoji },
      update: {},
    });
    await rt.enqueueToConversation(
      id,
      {
        type: "reaction_added",
        conversationId: id,
        messageId,
        reaction: {
          id: r.id,
          emoji: r.emoji,
          userId: user.id,
          userName: user.name,
        },
      },
      `reaction_add_${r.id}`,
    );
    return r;
  });

  res.status(201).json(reaction);
});

// ─── Remove reaction ──────────────────────────────────────────

router.delete("/conversations/:id/messages/:messageId/reactions/:emoji", requireAuth, async (req, res) => {
  const { user } = req as AuthenticatedRequest;
  const id = param(req.params.id);
  const messageId = param(req.params.messageId);
  const emoji = decodeURIComponent(param(req.params.emoji));

  if (emoji.length > 16 || emoji.length === 0) {
    throw new BadRequestError("emoji must be 1-16 chars");
  }

  const deleted = await prisma.reaction.deleteMany({
    where: { messageId, userId: user.id, emoji },
  });

  if (deleted.count === 0) {
    throw new NotFoundError("Reaction not found");
  }

  await withRealtime(async (rt) => {
    await rt.enqueueToConversation(
      id,
      {
        type: "reaction_removed",
        conversationId: id,
        messageId,
        emoji,
        userId: user.id,
      },
      `reaction_remove_${messageId}_${user.id}_${emoji}_${Date.now()}`,
    );
  });

  res.json({ ok: true });
});

// ─── Typing indicator ─────────────────────────────────────────

router.post("/conversations/:id/typing", requireAuth, typingLimiter, async (req, res) => {
  const { user } = req as AuthenticatedRequest;
  const id = param(req.params.id);

  const member = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId: id, userId: user.id } },
  });

  if (!member) {
    throw new ForbiddenError("Not a member of this conversation");
  }

  // Typing is ephemeral; dupe keys collide by design so retries within the
  // same second don't amplify into a second flash of the indicator.
  await broadcastToConversation(
    id,
    {
      type: "typing_started",
      conversationId: id,
      userId: user.id,
      userName: user.name,
    },
    `typing_${user.id}_${id}_${Math.floor(Date.now() / 2000)}`,
    { exclude: user.id },
  );

  res.json({ ok: true });
});

// ─── Update last active ───────────────────────────────────────

router.post("/me/active", requireAuth, generalLimiter, async (req, res) => {
  const { user } = req as AuthenticatedRequest;
  await prisma.user.update({
    where: { id: user.id },
    data: { lastActiveAt: new Date() },
  });
  res.json({ ok: true });
});

// ─── Broadcast my profile change to peers ─────────────────────
// Called by the client after `authClient.updateUser`. Fans out a
// `user_updated` event to every user who shares a conversation with me so
// their sidebar / header / message avatars refresh in real time.

router.post("/me/broadcast-profile", requireAuth, generalLimiter, async (req, res) => {
  const { user } = req as AuthenticatedRequest;

  // Bust the cache first so the next read downstream gets fresh data.
  // The client has already written to the DB through better-auth by the
  // time it calls this endpoint; we're only responsible for fan-out +
  // cache coherence.
  await invalidateUserProfile(user.id);

  const fresh = await prisma.user.findUnique({
    where: { id: user.id },
    select: { id: true, name: true, image: true },
  });
  if (!fresh) {
    throw new NotFoundError("User not found");
  }

  // Distinct peer user ids — everyone who shares at least one conversation
  // with me, plus me (for multi-tab sync on my own device).
  const rows = await prisma.conversationMember.findMany({
    where: {
      conversation: { members: { some: { userId: fresh.id } } },
    },
    select: { userId: true },
    distinct: ["userId"],
  });

  const channels = rows.map((r) => centrifugo.userChannel(r.userId));
  if (channels.length > 0) {
    await centrifugo.broadcast(
      channels,
      { type: "user_updated", user: fresh },
      { idempotencyKey: `user_updated_${fresh.id}_${Date.now()}` },
    );
  }

  res.json({ ok: true });
});

// ─── Helpers ──────────────────────────────────────────────────

interface ConversationPageParams {
  limit?: number;
  /** ISO timestamp: return only conversations with `updatedAt < before`. */
  before?: string;
}

async function getConversationsWithUnread(
  userId: string,
  { limit = 50, before }: ConversationPageParams = {},
) {
  // Cap the page so a malicious client can't ask for 1M rows.
  const take = Math.min(Math.max(limit, 1), 100);
  const beforeDate = before ? new Date(before) : null;
  // Ignore malformed cursors instead of 400ing — safer default.
  const useBefore = beforeDate && !Number.isNaN(beforeDate.getTime());

  const memberships = await prisma.conversationMember.findMany({
    where: {
      userId,
      ...(useBefore
        ? { conversation: { updatedAt: { lt: beforeDate } } }
        : {}),
    },
    orderBy: { conversation: { updatedAt: "desc" } },
    take: take + 1, // over-fetch by one to detect "has more"
    include: {
      conversation: {
        include: {
          members: {
            include: {
              user: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                  image: true,
                  lastActiveAt: true,
                },
              },
            },
          },
          messages: {
            where: { deletedAt: null },
            orderBy: { createdAt: "desc" },
            take: 1,
            include: {
              sender: { select: { id: true, name: true } },
            },
          },
        },
      },
    },
  });

  const hasMore = memberships.length > take;
  const pageRows = hasMore ? memberships.slice(0, take) : memberships;

  const conversations = pageRows.map((m) => ({
    ...m.conversation,
    unreadCount: m.unreadCount,
    muted: m.muted,
    lastMessage: m.conversation.messages[0] ?? null,
  }));

  const nextCursor =
    hasMore && pageRows.length > 0
      ? pageRows[pageRows.length - 1].conversation.updatedAt.toISOString()
      : null;

  return { conversations, nextCursor };
}

export default router;
