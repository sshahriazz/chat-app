import { prisma } from "../db";
import { CACHE_NS, cacheDel, cacheGetOrSet } from "./cache";
import type { ConversationType } from "../generated/prisma/enums";

/**
 * Cached per-conversation metadata. Shape matches what handlers read
 * repeatedly when they don't need the full membership payload — e.g. the
 * rename endpoint only needs `type` to reject direct chats, the send
 * path only needs `version` to annotate events, and `createdBy` is
 * read for permission checks.
 *
 * Version-stamped: every mutation that changes conversation-level state
 * increments `version` in the same DB transaction. A cached value with
 * a stale `version` is still correct for read-only "what type is this?"
 * checks, but callers that depend on a consistent view should refetch
 * or re-read the live row. For caller simplicity we invalidate on every
 * version bump so the cached view is always the latest committed state.
 */

export interface CachedConversationMeta {
  id: string;
  type: ConversationType;
  name: string | null;
  version: number;
  createdBy: string;
}

export async function getConversationMeta(
  id: string,
): Promise<CachedConversationMeta | null> {
  return cacheGetOrSet(CACHE_NS.convMeta, id, async () => {
    const row = await prisma.conversation.findUnique({
      where: { id },
      select: {
        id: true,
        type: true,
        name: true,
        version: true,
        createdBy: true,
      },
    });
    return row;
  });
}

export async function invalidateConversationMeta(id: string): Promise<void> {
  await cacheDel(CACHE_NS.convMeta, id);
}
