import {
  allow,
  deny,
  type ChatAction,
  type ChatActor,
  type ChatConversation,
  type ChatResource,
  type Decision,
} from './types';

/**
 * The matrix, as data.
 *
 * A rule returns a `Decision`, or `null` meaning "no opinion — ask the next
 * one". The first rule to have an opinion wins, and a list that runs out
 * without one denies. Ordering therefore matters and is deliberate:
 * membership is checked before role, role before ownership of the thing.
 */
export type Rule = (
  actor: ChatActor,
  resource: ChatResource
) => Decision | null;

/* ---- Shared predicates ------------------------------------------------ */

const mustBeMember: Rule = (actor) =>
  actor.role === null ? deny('not-a-member') : null;

const mustBeGroup: Rule = (_actor, resource) =>
  resource.conversation.type === 'direct' ? deny('direct-conversation') : null;

const mustManageMembers: Rule = (actor) =>
  actor.role === 'owner' || actor.role === 'admin'
    ? null
    : deny('not-owner-or-admin');

/**
 * Two identities may interact when either is tenant-wide, or when both carry
 * the same scope.
 *
 * This is what stops one client discovering another: clients are scoped
 * `client_<id>`, staff are scoped `null`. Staff reach everyone; clients reach
 * only staff and themselves.
 */
const scopesCompatible = (a: string | null, b: string | null) =>
  a === null || b === null || a === b;

/**
 * The client scope a conversation already belongs to, if any.
 *
 * Staff carry `null` and belong to the business, so they never define which
 * client a room is about. At most one scoped identity should ever be present.
 */
const clientScopeOf = (conversation: ChatConversation): string | null =>
  conversation.memberScopes?.find((s) => s !== null) ?? null;

/* ---- The matrix -------------------------------------------------------- */

export const capabilities: Record<ChatAction, Rule[]> = {
  /**
   * Anyone authenticated may start a conversation. The constraint on *who
   * with* is `scope`, enforced when members are added rather than here.
   */
  'conversation:create': [() => allow],

  'conversation:read': [mustBeMember, () => allow],

  /**
   * Renaming covers the emoji and colour too — one endpoint, one permission.
   * A direct conversation has no name to change: it is titled by whoever the
   * other participant is.
   */
  'conversation:rename': [mustBeMember, mustBeGroup, mustManageMembers, () => allow],

  /**
   * H-1. This is the rule the chat server does not currently enforce: any
   * member can add anyone. `member:remove` has always required owner/admin,
   * so today a plain member cannot remove someone but can add them — which
   * makes the pairing incoherent and lets any participant widen the audience
   * of a conversation without the others knowing.
   *
   * The scope check is H-2: staff carry `scope: null`, which is what makes
   * them tenant-wide, and it must not be read as "may add anybody to
   * anything". A client can never be added to another client's conversation
   * because their scopes differ.
   */
  'member:add': [
    mustBeMember,

    /**
     * Role is required for a group, and deliberately not for a direct
     * conversation.
     *
     * Adding someone to a 1:1 is how it becomes a group, and a direct
     * conversation has no owner to appeal to — both participants are equal.
     * Requiring owner/admin there would mean a 1:1 could never be promoted at
     * all. An earlier version modelled this as "cannot add to a direct
     * conversation", which forced the route to special-case promotion around
     * the policy — the exact thing this file exists to prevent.
     */
    (actor, resource) =>
      resource.conversation.type === 'group' ? mustManageMembers(actor, resource) : null,

    /**
     * H-2, actor against target. A client cannot reach past their own scope.
     */
    (actor, resource) =>
      resource.targetMember &&
      !scopesCompatible(actor.scope, resource.targetMember.scope)
        ? deny('scope-mismatch')
        : null,

    /**
     * H-2, and the half the role check cannot reach.
     *
     * Requiring owner/admin stops a bystander widening the room. It does not
     * stop the owner adding the *wrong* person, and for staff that check
     * passes trivially: `userScopeFilter(null)` returns `{}`, so a tenant-wide
     * identity has no restriction on who they may add.
     *
     * The invariant that closes it is a property of the room, not of the two
     * people: a conversation belongs to at most one client. Staff are
     * tenant-wide and never define which client a room is about; a second
     * distinct client scope is what turns one customer's thread into a place
     * another customer can read.
     *
     * D-1 made this sharper rather than milder. With full history on, a
     * wrongly-added client would not merely see what comes next — they would
     * see the entire relationship.
     *
     * Applies to promotion too: promoting a 1:1 that belongs to one client by
     * adding another is the same leak wearing a different hat.
     */
    (_actor, resource) => {
      const target = resource.targetMember;
      if (!target?.scope) return null;
      const existing = clientScopeOf(resource.conversation);
      return existing && existing !== target.scope
        ? deny('scope-mismatch')
        : null;
    },
    () => allow,
  ],

  /** Leaving is always yours to do; removing someone else needs the role. */
  'member:remove': [
    mustBeMember,
    mustBeGroup,
    (actor, resource) =>
      resource.targetMember?.userId === actor.userId ? allow : null,
    mustManageMembers,
    () => allow,
  ],

  'member:leave': [mustBeMember, mustBeGroup, () => allow],

  'message:send': [mustBeMember, () => allow],

  /**
   * Editing is the author's alone — an admin may remove a message but may not
   * put words in someone's mouth. Deleted messages are not editable back into
   * existence.
   */
  'message:edit': [
    mustBeMember,
    (_actor, resource) =>
      resource.targetMessage?.deletedAt ? deny('message-deleted') : null,
    (actor, resource) =>
      resource.targetMessage && resource.targetMessage.senderId !== actor.userId
        ? deny('not-the-author')
        : null,
    () => allow,
  ],

  /** The author, or someone who manages the room. */
  'message:delete': [
    mustBeMember,
    (actor, resource) =>
      resource.targetMessage?.senderId === actor.userId ? allow : null,
    mustManageMembers,
    () => allow,
  ],

  'reaction:toggle': [mustBeMember, () => allow],

  /**
   * D-1. Whether a member may read what was said before they joined.
   *
   * The tenant decides. A private group chat says no — joining a room does
   * not retroactively grant you what was said in it. A business's shared
   * client conversation says yes — it belongs to the company, and a successor
   * who inherits the relationship needs the relationship rather than a blank
   * thread.
   */
  'history:read-before-join': [
    mustBeMember,
    (_actor, resource) =>
      resource.conversation.fullHistoryForNewMembers ? allow : null,
    (actor, resource) =>
      actor.joinedAt &&
      resource.messageCreatedAt &&
      resource.messageCreatedAt < actor.joinedAt
        ? deny('history-fenced')
        : null,
    () => allow,
  ],
};
