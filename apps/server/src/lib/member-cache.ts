import { prisma } from "../db";

/**
 * In-process cache of `conversationId → userId[]` for realtime fan-out.
 *
 * Before this cache, every message / edit / delete / reaction / read / typing
 * event ran a `conversationMember.findMany` to resolve the fan-out channel
 * list. At high throughput that dominates DB load. This cache turns it into
 * a hash lookup.
 *
 * Correctness model:
 *  - Reads from cache; on miss, one DB SELECT and populate.
 *  - All mutations that change membership call `invalidate(conversationId)`
 *    from within the `withRealtime` transaction. On the happy path that's
 *    conversation create, member add, member remove, leave.
 *  - Membership changes ALSO emit `conversation_updated` / `conversation_left`
 *    events, so all clients resync naturally.
 *
 * Scaling notes:
 *  - Single-process cache: fine for one app instance. When we run multiple
 *    instances, swap for Redis (pub/sub invalidation by conversationId) or
 *    Centrifugo's broadcast feature.
 *  - Size-bounded to prevent memory leaks on servers with many conversations;
 *    LRU eviction via simple Map reinsertion on hit.
 */
const MAX_ENTRIES = 10_000;
const TTL_MS = 5 * 60_000;

interface Entry {
  userIds: string[];
  expiresAt: number;
}

const cache = new Map<string, Entry>();

function evictOldest() {
  const first = cache.keys().next();
  if (!first.done) cache.delete(first.value);
}

export async function getConversationMemberIds(
  conversationId: string,
): Promise<string[]> {
  const hit = cache.get(conversationId);
  const now = Date.now();
  if (hit && hit.expiresAt > now) {
    // LRU touch: re-insert to move to end of iteration order.
    cache.delete(conversationId);
    cache.set(conversationId, hit);
    return hit.userIds;
  }

  const rows = await prisma.conversationMember.findMany({
    where: { conversationId },
    select: { userId: true },
  });
  const userIds = rows.map((r) => r.userId);

  if (cache.size >= MAX_ENTRIES) evictOldest();
  cache.set(conversationId, { userIds, expiresAt: now + TTL_MS });
  return userIds;
}

export function invalidateConversation(conversationId: string) {
  cache.delete(conversationId);
}

export function invalidateAll() {
  cache.clear();
}
