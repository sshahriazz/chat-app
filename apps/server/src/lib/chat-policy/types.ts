/**
 * The permission model, as one readable artifact.
 *
 * "Who can add whom to a conversation" was answerable only by reading three
 * components that disagreed with each other: `ensureGeneralConversation` said
 * *shared, but only General*; `addNewAdminToGroupChats` said *shared,
 * everything*; the `joinedAt` fence said *private per member*. Nothing stated
 * the rule, so every enforcement point invented its own.
 *
 * This states it once. Enforcement comes later (CH-06) and must agree with
 * this file rather than reimplement it.
 */

/** Conversation roles, mirroring `MemberRole` in the chat server's schema. */
export type MemberRole = 'owner' | 'admin' | 'member';

/**
 * Who is asking.
 *
 * Derived from the membership row and the token's scope claim — never from
 * anything the request body says about itself. That is the whole point of the
 * type: a caller cannot claim to be an owner, because there is no constructor
 * here that takes an assertion.
 */
export interface ChatActor {
  userId: string;
  /** Absent when the actor is not a member of the conversation at all. */
  role: MemberRole | null;
  /**
   * `null` means a tenant-wide identity — OneSuite staff, who can see and be
   * seen by everyone in the tenant. A non-null scope confines the actor to
   * others sharing that exact scope, which is how one client is kept from
   * discovering another.
   */
  scope: string | null;
  /** When this actor joined. Absent for a non-member. */
  joinedAt?: Date;
}

export interface ChatConversation {
  id: string;
  type: 'direct' | 'group';
  /**
   * Scopes already present in the room, one per member.
   *
   * `null` is a tenant-wide identity — staff, who belong to the business
   * rather than to any one client. A non-null scope confines its holder to
   * others sharing it, which is how one client is kept from discovering
   * another.
   *
   * Needed because "may this person be added" is not answerable from the
   * actor and target alone. Staff are tenant-wide, so any actor-vs-target
   * check passes for them — and that is exactly the case where adding the
   * wrong person exposes one client's thread to another.
   */
  memberScopes?: (string | null)[];
  /**
   * Whether the tenant lets members read messages sent before they joined.
   * `Tenant.fullHistoryForNewMembers` — a business's client thread says yes,
   * a private group chat says no.
   */
  fullHistoryForNewMembers: boolean;
}

/** What is being acted on. Some actions need a target, some do not. */
export interface ChatResource {
  conversation: ChatConversation;
  /** The other party, for member actions. */
  targetMember?: { userId: string; role: MemberRole | null; scope: string | null };
  /** The message, for message actions. */
  targetMessage?: { senderId: string; deletedAt?: Date | null };
  /** When the message being read was created, for the history rule. */
  messageCreatedAt?: Date;
}

/**
 * Every action the chat surface can attempt.
 *
 * A closed union on purpose: `capabilities` is typed `Record<ChatAction, …>`,
 * so adding a member here without writing its rule fails the build rather
 * than silently defaulting to allow or deny.
 */
export type ChatAction =
  | 'conversation:create'
  | 'conversation:read'
  | 'conversation:rename'
  | 'member:add'
  | 'member:remove'
  | 'member:leave'
  | 'message:send'
  | 'message:edit'
  | 'message:delete'
  | 'reaction:toggle'
  | 'history:read-before-join';

/**
 * Why, not just whether.
 *
 * A bare boolean gives the UI nothing to say and gives an API a generic 403.
 * The reason code is what lets one enforcement point be compared against
 * another — the conformance table asserts on codes, so "denied for the wrong
 * reason" is a failure, not a pass.
 */
export type DenyReason =
  | 'not-a-member'
  | 'not-owner-or-admin'
  | 'direct-conversation'
  | 'not-the-author'
  | 'message-deleted'
  | 'scope-mismatch'
  | 'history-fenced';

export type Decision =
  | { allowed: true }
  | { allowed: false; reason: DenyReason };

export const allow: Decision = { allowed: true };
export const deny = (reason: DenyReason): Decision => ({
  allowed: false,
  reason,
});
