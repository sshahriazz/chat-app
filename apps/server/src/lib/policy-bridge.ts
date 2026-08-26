import { can } from "./chat-policy";
import type {
  ChatAction,
  ChatActor,
  ChatResource,
  Decision,
  DenyReason,
  MemberRole,
} from "./chat-policy";
import { ForbiddenError, NotFoundError } from "../http/errors";

/**
 * Enforcement side of the vendored policy.
 *
 * The policy says what the rules are; this makes them load-bearing at the
 * route. Keeping the two apart is deliberate — a route that hand-rolls its own
 * comparison is how `member:add` and `member:remove` came to disagree about
 * the same question, and how the history fence ended up enforced in
 * `/messages` and skipped in `/search`.
 *
 * Nothing here decides anything. It shapes a request into the policy's inputs
 * and turns a `Decision` into an HTTP error.
 */

/** What the route already has in hand after loading the membership row. */
export interface MembershipRow {
  role: MemberRole;
  joinedAt: Date;
}

export function actorFrom(
  userId: string,
  scope: string | null,
  membership: MembershipRow | null
): ChatActor {
  return {
    userId,
    role: membership?.role ?? null,
    scope,
    joinedAt: membership?.joinedAt,
  };
}

/**
 * Deny reasons that describe *why* rather than *whether*, mapped to statuses.
 *
 * `not-a-member` is a 404, not a 403. Telling someone a conversation exists
 * but is closed to them is itself a disclosure — it confirms the id is real.
 * Every other reason presupposes membership, so the caller already knows the
 * conversation exists and a 403 gives away nothing new.
 */
export function policyError(reason: DenyReason): Error {
  if (reason === "not-a-member") {
    return new NotFoundError("Conversation not found");
  }
  return new ForbiddenError(MESSAGES[reason]);
}

const MESSAGES: Record<Exclude<DenyReason, "not-a-member">, string> = {
  "not-owner-or-admin": "Only owners and admins can do this",
  "direct-conversation": "Not valid for a direct conversation",
  "not-the-author": "Only the author can edit this message",
  "message-deleted": "This message has been deleted",
  "scope-mismatch": "That user cannot be added to this conversation",
  "history-fenced": "That message predates your membership",
};

/**
 * Throw unless the policy allows it.
 *
 * Returns the decision on success so a caller that wants the allow branch for
 * something else does not have to ask twice.
 */
export function authorize(
  actor: ChatActor,
  action: ChatAction,
  resource: ChatResource
): Decision {
  const decision = can(actor, action, resource);
  if (!decision.allowed) throw policyError(decision.reason);
  return decision;
}
