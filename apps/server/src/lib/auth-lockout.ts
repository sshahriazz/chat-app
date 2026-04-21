import { redis } from "../infra/redis";
import { logger } from "../infra/logger";

/**
 * Account-keyed auth lockout.
 *
 * The existing `authLimiter` in `middleware/rate-limit.ts` is IP-keyed,
 * which stops brute-force from a single client but does nothing against
 * credential stuffing distributed across a botnet (every attempt comes
 * from a different IP, but every attempt targets the *same* email).
 *
 * This module adds a parallel counter keyed on the normalized email.
 * After N failures in a sliding TTL window the account is soft-locked —
 * new sign-in attempts are rejected at the `before` hook before better-
 * auth even looks up the user, so the DB isn't touched and the timing
 * side-channel is silent.
 *
 * Successful sign-ins clear the counter so legitimate users don't lock
 * themselves out by typing their password wrong twice in a row.
 *
 * Fail-open: Redis failures swallow to "not locked out" so a Redis
 * outage can't deny logins to the whole user base.
 */

export const AUTH_LOCKOUT_THRESHOLD = 10;
export const AUTH_LOCKOUT_WINDOW_SEC = 15 * 60; // 15 minutes

function key(email: string): string {
  return `auth:lockout:${email.toLowerCase().trim()}`;
}

/**
 * Returns `true` if the email is currently over the failed-attempt
 * threshold and should be rejected.
 */
export async function isAccountLocked(email: string): Promise<boolean> {
  try {
    const raw = await redis.get(key(email));
    if (!raw) return false;
    const n = Number(raw);
    if (!Number.isFinite(n)) return false;
    return n >= AUTH_LOCKOUT_THRESHOLD;
  } catch (err) {
    logger.warn(
      { err: { message: (err as Error).message } },
      "[auth-lockout] redis get failed (fail-open)",
    );
    return false;
  }
}

/**
 * Increments the failure counter and (re)applies the TTL so the window
 * slides with each attempt. Uses MULTI to keep the two ops atomic.
 */
export async function recordAuthFailure(email: string): Promise<void> {
  try {
    await redis
      .multi()
      .incr(key(email))
      .expire(key(email), AUTH_LOCKOUT_WINDOW_SEC)
      .exec();
  } catch (err) {
    logger.warn(
      { err: { message: (err as Error).message } },
      "[auth-lockout] redis incr failed",
    );
  }
}

/** Clears the counter after a successful sign-in. */
export async function clearAuthFailures(email: string): Promise<void> {
  try {
    await redis.del(key(email));
  } catch (err) {
    logger.warn(
      { err: { message: (err as Error).message } },
      "[auth-lockout] redis del failed",
    );
  }
}
