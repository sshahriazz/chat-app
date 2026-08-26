import { capabilities } from './capabilities';
import {
  deny,
  type ChatAction,
  type ChatActor,
  type ChatResource,
  type Decision,
} from './types';

/**
 * May this actor do this, to this?
 *
 * Runs the action's rules in order and returns the first opinion. A list that
 * produces no opinion denies — the default is no, so a rule set that forgets
 * a case fails closed rather than open.
 */
export function can(
  actor: ChatActor,
  action: ChatAction,
  resource: ChatResource
): Decision {
  for (const rule of capabilities[action]) {
    const decision = rule(actor, resource);
    if (decision) return decision;
  }
  // Unreachable for every action currently in the matrix — each ends with an
  // unconditional allow. Kept because the alternative is `undefined` leaking
  // into a caller that treats it as truthy.
  return deny('not-a-member');
}

/** Convenience for render-time gating, where the reason is not shown. */
export function allowed(
  actor: ChatActor,
  action: ChatAction,
  resource: ChatResource
): boolean {
  return can(actor, action, resource).allowed;
}
