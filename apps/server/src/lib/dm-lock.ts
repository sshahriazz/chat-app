import type { Prisma } from "../generated/prisma/client";

/**
 * Serialize concurrent direct-chat creation for the same (tenantId, userPair).
 *
 * Without this, two concurrent POSTs from the same pair — double-click on
 * "Start chat", retry after a 499, two tabs, React Strict Mode double-fire
 * in dev — race past the `findFirst` dedup check and each insert a new
 * Conversation row, leaving the user with two parallel DMs.
 *
 * Postgres `pg_advisory_xact_lock` gives us per-pair serialization
 * without a schema change. The lock is released automatically when the
 * enclosing transaction commits or rolls back, so there's no janitor
 * path to get wrong.
 *
 * Key derivation:
 *   - Sort the two user ids before hashing so (A, B) and (B, A) hash
 *     to the same slot. No dedup check would catch it otherwise.
 *   - Scope the key by tenantId so unrelated tenants can't interfere
 *     with each other's lock slots.
 *   - `hashtextextended(text, 0)` is a 64-bit Postgres hash. Accidental
 *     collisions between unrelated DM pairs cost a tiny bit of extra
 *     serialization but don't corrupt data — the subsequent find-or-
 *     create still reads the correct row under READ COMMITTED.
 *
 * MUST be called inside the same transaction that performs the find-or-
 * create; otherwise there's nothing the lock protects.
 */
export async function acquireDmLock(
  tx: Prisma.TransactionClient,
  tenantId: string,
  userA: string,
  userB: string,
): Promise<void> {
  const [a, b] = [userA, userB].sort();
  const key = `dm:${tenantId}:${a}:${b}`;
  // Use `$executeRaw`, not `$queryRaw`: `pg_advisory_xact_lock` returns
  // `void`, and Prisma's query engine refuses to deserialize a void
  // column ("Failed to deserialize column of type 'void'"). `$executeRaw`
  // doesn't try to materialize rows, so it's the right primitive for a
  // statement we only call for its side effect.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}::text, 0))`;
}
