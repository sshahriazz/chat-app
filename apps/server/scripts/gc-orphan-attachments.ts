/**
 * Manual trigger for orphan-attachment GC. The same routine runs on a
 * 6-hourly schedule inside the long-running server; this script exists
 * for backfills and for one-off cleanups during operations work.
 *
 * Run:
 *   pnpm -F @chat-app/server exec tsx scripts/gc-orphan-attachments.ts
 */
import "dotenv/config";
import { prisma } from "../src/db";
import { gcOrphanAttachments } from "../src/lib/attachments-gc";

async function main() {
  const result = await gcOrphanAttachments();
  console.log(
    `orphan-attachments gc: deleted=${result.deleted} s3Errors=${result.s3Errors}`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
