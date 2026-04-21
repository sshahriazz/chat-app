import { prisma } from "../db";
import { Prisma } from "../generated/prisma/client";
import * as centrifugo from "./centrifugo";

interface PublishIntent {
  channels: string[];
  data: unknown;
  idempotencyKey: string;
}

/**
 * `RealtimeTx` is handed to the callback passed to `withRealtime`. It exposes
 * the Prisma transaction client plus an `enqueue` method. Enqueued publishes
 * are NOT sent to Centrifugo until the surrounding DB transaction commits —
 * which guarantees subscribers never see events for writes that rolled back.
 */
export interface RealtimeTx {
  tx: Prisma.TransactionClient;
  enqueue: (intent: PublishIntent) => void;
  enqueueToConversation: (
    conversationId: string,
    data: unknown,
    idempotencyKey: string,
    opts?: { exclude?: string },
  ) => Promise<void>;
  createSystemMessage: (
    conversationId: string,
    senderId: string,
    content: string,
  ) => Promise<{ id: string; seq: number; createdAt: Date }>;
}

export async function withRealtime<T>(
  fn: (rt: RealtimeTx) => Promise<T>,
): Promise<T> {
  const queue: PublishIntent[] = [];

  const result = await prisma.$transaction(async (tx) => {
    const rt: RealtimeTx = {
      tx,
      enqueue: (intent) => queue.push(intent),
      enqueueToConversation: async (conversationId, data, idempotencyKey, opts = {}) => {
        const members = await tx.conversationMember.findMany({
          where: {
            conversationId,
            ...(opts.exclude ? { userId: { not: opts.exclude } } : {}),
          },
          select: { userId: true },
        });
        if (members.length === 0) return;
        queue.push({
          channels: members.map((m) => centrifugo.userChannel(m.userId)),
          data,
          idempotencyKey,
        });
      },
      createSystemMessage: async (conversationId, senderId, content) => {
        const { currentSeq: seq } = await tx.conversation.update({
          where: { id: conversationId },
          data: { currentSeq: { increment: 1 } },
          select: { currentSeq: true },
        });
        // System messages are plain-text produced server-side — wrap them in
        // a minimal Tiptap paragraph so renderers handle them the same way as
        // user messages. `plainContent` mirrors for search.
        const systemDoc = {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: content }] },
          ],
        };
        const msg = await tx.message.create({
          data: {
            conversationId,
            senderId,
            content: systemDoc,
            plainContent: content,
            type: "system",
            seq,
          },
        });
        const members = await tx.conversationMember.findMany({
          where: { conversationId },
          select: { userId: true },
        });
        if (members.length > 0) {
          queue.push({
            channels: members.map((m) => centrifugo.userChannel(m.userId)),
            data: {
              type: "message_added",
              conversationId,
              message: {
                id: msg.id,
                seq: msg.seq,
                senderId,
                senderName: "",
                content: systemDoc,
                plainContent: content,
                msgType: "system",
                replyTo: null,
                createdAt: msg.createdAt,
                clientMessageId: null,
              },
            },
            idempotencyKey: `message_${msg.id}`,
          });
        }
        return { id: msg.id, seq: msg.seq, createdAt: msg.createdAt };
      },
    };
    return fn(rt);
  });

  // Transaction committed. Flush publishes. Each has an idempotency key so
  // retries inside `centrifugo.broadcast` are safe. A failure here is logged
  // but not propagated — the HTTP request already succeeded.
  for (const intent of queue) {
    try {
      await centrifugo.broadcast(intent.channels, intent.data, {
        idempotencyKey: intent.idempotencyKey,
      });
    } catch (err) {
      console.error("[realtime] broadcast failed:", err, {
        key: intent.idempotencyKey,
        channelCount: intent.channels.length,
      });
    }
  }

  return result;
}
