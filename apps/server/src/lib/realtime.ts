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
 * the Prisma transaction client plus an `enqueue` method.
 *
 * Enqueued publishes are inserted into `chat_outbox` **inside the surrounding
 * transaction**. Centrifugo's native Postgres consumer polls the table and
 * dispatches them, so:
 *   - If the transaction rolls back, the outbox row vanishes with it — no
 *     phantom events.
 *   - If the app crashes between commit and publish, the row still exists
 *     and Centrifugo will pick it up when it next polls.
 *   - If Centrifugo is briefly unreachable, rows queue in the outbox until
 *     it recovers. No event is lost.
 *
 * The Centrifugo tutorial uses the `broadcast` method shape (channels +
 * data + idempotency_key at the payload root); we match that so rows are
 * readable by the default PG consumer config.
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

async function flushToOutbox(tx: Prisma.TransactionClient, queue: PublishIntent[]) {
  if (queue.length === 0) return;
  await tx.outbox.createMany({
    data: queue.map((q) => ({
      method: "broadcast",
      payload: {
        channels: q.channels,
        data: q.data as Prisma.InputJsonValue,
        idempotency_key: q.idempotencyKey,
      } as Prisma.InputJsonValue,
      // Single-partition is the default; bump later if/when Centrifugo is
      // configured with multiple partitions for parallel draining.
      partition: 0,
    })),
  });
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

    const value = await fn(rt);
    // Insert all queued publishes into the outbox as the final step of the
    // transaction. If anything above throws, the outbox writes roll back
    // with the business data — no split-brain.
    await flushToOutbox(tx, queue);
    return value;
  });

  return result;
}
