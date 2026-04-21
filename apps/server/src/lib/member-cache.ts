import { prisma } from "../db";
import { CACHE_NS, cacheDel, cacheGetOrSet } from "./cache";

/**
 * Redis-backed cache of `conversationId → userId[]` for realtime fan-out.
 *
 * Before this cache, every message / edit / delete / reaction / read /
 * typing event ran a `conversationMember.findMany` to resolve the
 * fan-out channel list. That dominates DB load at high throughput.
 *
 * Correctness model:
 *  - Reads through Redis; on miss, one DB SELECT populates the entry
 *    with `CACHE_NS.convMembers.ttlSec` TTL.
 *  - All mutations that change membership call `invalidateConversation`
 *    from within `withRealtime`. On the happy path that's conversation
 *    create, member add, member remove, leave.
 *  - Because `withRealtime`'s outbox broadcast is committed atomically
 *    with the DB change, the ordering is: DB commit → invalidate → event
 *    delivery. Replicas that miss the invalidate still get the
 *    `conversation_updated` event and resync.
 *  - Membership changes ALSO emit `conversation_updated` /
 *    `conversation_left` events, so all clients resync naturally.
 *
 * Fail-open: cache.ts swallows Redis errors, so if Redis flaps we fall
 * through to the DB read path instead of breaking the message loop.
 */

export async function getConversationMemberIds(
  conversationId: string,
): Promise<string[]> {
  return cacheGetOrSet(CACHE_NS.convMembers, conversationId, async () => {
    const rows = await prisma.conversationMember.findMany({
      where: { conversationId },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  });
}

export async function invalidateConversation(
  conversationId: string,
): Promise<void> {
  await cacheDel(CACHE_NS.convMembers, conversationId);
}
