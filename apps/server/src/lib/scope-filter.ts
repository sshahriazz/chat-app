import type { Prisma } from "../generated/prisma/client";

/**
 * Canonical Prisma `where` fragment for enforcing User.scope isolation
 * within a tenant.
 *
 * Semantics:
 *   - A tenant-wide requester (scope = null) sees every user in the
 *     tenant → no constraint added.
 *   - A scoped requester (scope = "X") sees users whose scope is the
 *     same "X" OR null (tenant-wide users, e.g. support agents).
 *
 * This is the ONLY place scope visibility is decided. Every route that
 * resolves User rows from untrusted ids (search, add-member, online
 * batch check, conversation create) composes this into its where clause
 * — so a future change to the visibility rule is a one-file edit.
 */
export function userScopeFilter(
  requesterScope: string | null,
): Prisma.UserWhereInput {
  if (requesterScope === null) return {};
  return { OR: [{ scope: null }, { scope: requesterScope }] };
}
