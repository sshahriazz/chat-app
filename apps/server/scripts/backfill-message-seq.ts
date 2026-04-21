/**
 * One-off backfill: assign `Message.seq` per-conversation ordered by `createdAt`,
 * and set `Conversation.currentSeq` to the max. Idempotent — skips conversations
 * whose messages are already fully numbered.
 *
 * Run once with:
 *   pnpm -F @chat-app/server exec tsx scripts/backfill-message-seq.ts
 */
import "dotenv/config";
import { prisma } from "../src/db.js";

async function main() {
  const conversations = await prisma.conversation.findMany({
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  console.log(`backfilling ${conversations.length} conversation(s)`);

  let totalUpdated = 0;

  for (const conv of conversations) {
    const messages = await prisma.message.findMany({
      where: { conversationId: conv.id },
      orderBy: { createdAt: "asc" },
      select: { id: true, seq: true },
    });

    if (messages.length === 0) {
      await prisma.conversation.update({
        where: { id: conv.id },
        data: { currentSeq: 0 },
      });
      continue;
    }

    // Skip if already complete (all messages have seq, contiguous from 1).
    const allNumbered =
      messages.every((m) => m.seq !== null) &&
      messages[messages.length - 1].seq === messages.length;

    if (allNumbered) {
      await prisma.conversation.update({
        where: { id: conv.id },
        data: { currentSeq: messages.length },
      });
      continue;
    }

    await prisma.$transaction(
      messages.map((m, i) =>
        prisma.message.update({
          where: { id: m.id },
          data: { seq: i + 1 },
        }),
      ),
    );

    await prisma.conversation.update({
      where: { id: conv.id },
      data: { currentSeq: messages.length },
    });

    totalUpdated += messages.length;
    console.log(`  ${conv.id}: ${messages.length} message(s)`);
  }

  console.log(`done — updated ${totalUpdated} message(s)`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
