/**
 * Sends a test Web Push to every stored subscription. Run this to verify
 * the VAPID → web-push → browser push service → service-worker pipeline
 * without needing another real user to send a message.
 *
 * Run: `npx tsx scripts/smoke-push.ts`
 */
import "dotenv/config";
import { prisma } from "../src/db";
import { pushToUsers, isPushConfigured } from "../src/lib/push";

async function main() {
  if (!isPushConfigured()) {
    console.error("❌ VAPID_* missing in .env. Cannot send push.");
    process.exit(1);
  }

  const subs = await prisma.pushSubscription.findMany({
    select: { id: true, userId: true, endpoint: true },
  });
  if (subs.length === 0) {
    console.log("⚠️  No push subscriptions in DB. Nothing to send.");
    return;
  }

  console.log(`Found ${subs.length} subscription(s):`);
  for (const s of subs) {
    console.log(`  - user=${s.userId} endpoint=${s.endpoint.slice(0, 60)}...`);
  }

  const userIds = Array.from(new Set(subs.map((s) => s.userId)));
  console.log(`\nSending test push to user ids: ${userIds.join(", ")}`);

  await pushToUsers(userIds, {
    title: "Smoke test",
    body: `Fired at ${new Date().toLocaleTimeString()}`,
    tag: "smoke-test",
    url: "/",
  });

  console.log(
    "\n✅ Push dispatched. Check your OS notifications (minimize the browser first — the SW suppresses when any tab is focused).",
  );
  console.log(
    "\nIf nothing appears: check server logs for `[lib/push] push send failed` lines.",
  );

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("\n❌ FAILED:", err);
  await prisma.$disconnect();
  process.exit(1);
});
