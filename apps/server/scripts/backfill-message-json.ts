/**
 * One-off: converts every `messages.content` (legacy HTML string) into
 * `content_json` (Tiptap JSON) + `plain_content` (extracted text for search).
 *
 * Idempotent: rows whose `content_json IS NOT NULL` are skipped. Safe to
 * re-run if the process dies halfway through.
 *
 * Run once, in the order below:
 *   1. ALTER TABLE messages ADD COLUMN content_json JSONB …          (done manually)
 *   2. pnpm -F @chat-app/server exec tsx scripts/backfill-message-json.ts
 *   3. ALTER TABLE messages ALTER content_json SET NOT NULL;
 *      DROP COLUMN content; RENAME content_json TO content;
 */
import "dotenv/config";
import { prisma } from "../src/db";
import {
  canonicalizeFromHtml,
  extractPlainText,
} from "../src/lib/message-content";

async function main() {
  // Use raw SQL — the legacy `content` column still exists and Prisma's
  // generated client doesn't know about `content_json` yet.
  const rows = await prisma.$queryRaw<
    Array<{ id: string; content: string; content_json: unknown }>
  >`
    SELECT id, content, content_json
    FROM messages
    WHERE content_json IS NULL
    ORDER BY created_at ASC
  `;

  console.log(`backfilling ${rows.length} message(s)`);
  let n = 0;

  for (const row of rows) {
    try {
      const json = canonicalizeFromHtml(row.content ?? "");
      const plain = extractPlainText(json);
      await prisma.$executeRaw`
        UPDATE messages
        SET content_json = ${JSON.stringify(json)}::jsonb,
            plain_content = ${plain}
        WHERE id = ${row.id}
      `;
      n += 1;
      if (n % 50 === 0) console.log(`  ${n}/${rows.length}`);
    } catch (err) {
      console.error(`  skipped ${row.id}:`, (err as Error).message);
    }
  }

  console.log(`done — migrated ${n}/${rows.length}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
