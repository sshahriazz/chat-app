import { prisma } from "../db";
import {
  CACHE_NS,
  cacheBatchGetOrSet,
  cacheDel,
  cacheGetOrSet,
} from "./cache";

/**
 * Cached user profile lookups. The `{ id, name, email, image }` tuple is
 * referenced all over the hot path — every `message_added` event embeds
 * a senderName, `/api/users/search` renders avatars, group membership
 * payloads include each member's profile. Caching here cuts a SELECT on
 * every one of those reads.
 *
 * Invalidation: every code path that can change `name` / `image` calls
 * `invalidateUserProfile` — better-auth's `update-user` hook (via
 * `auth.ts`) and the `/api/me/broadcast-profile` endpoint. Email is
 * treated as read-only post-signup so it's safe to cache longer.
 */

export interface CachedUserProfile {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

export async function getUserProfile(
  id: string,
): Promise<CachedUserProfile | null> {
  return cacheGetOrSet(CACHE_NS.userProfile, id, async () => {
    const row = await prisma.user.findUnique({
      where: { id },
      select: { id: true, name: true, email: true, image: true },
    });
    return row;
  });
}

export async function getUserProfiles(
  ids: string[],
): Promise<Map<string, CachedUserProfile>> {
  return cacheBatchGetOrSet(CACHE_NS.userProfile, ids, async (misses) => {
    const rows = await prisma.user.findMany({
      where: { id: { in: misses } },
      select: { id: true, name: true, email: true, image: true },
    });
    const out = new Map<string, CachedUserProfile>();
    for (const r of rows) out.set(r.id, r);
    return out;
  });
}

export async function invalidateUserProfile(id: string): Promise<void> {
  await cacheDel(CACHE_NS.userProfile, id);
}
