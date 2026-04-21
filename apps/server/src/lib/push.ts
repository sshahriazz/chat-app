import webpush, { type PushSubscription as WPSubscription } from "web-push";
import { env } from "../env";
import { prisma } from "../db";
import { logger } from "./logger";

/**
 * Web Push dispatch. Kept lazy so the server can boot without VAPID
 * configured — push endpoints fail loudly, message delivery is unaffected.
 */

let configured = false;

function ensureConfigured() {
  if (configured) return true;
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
    return false;
  }
  webpush.setVapidDetails(
    env.VAPID_SUBJECT,
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY,
  );
  configured = true;
  return true;
}

export function isPushConfigured() {
  return ensureConfigured();
}

export function getVapidPublicKey() {
  return env.VAPID_PUBLIC_KEY ?? null;
}

export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  url?: string;
}

/**
 * Fan-out push to every subscription registered for a set of user ids.
 * Expired (404/410) subscriptions are removed so the list stays clean.
 * Failures are logged but never thrown — push is best-effort.
 */
export async function pushToUsers(
  userIds: string[],
  payload: PushPayload,
): Promise<void> {
  if (userIds.length === 0) return;
  if (!ensureConfigured()) return;

  const subs = await prisma.pushSubscription.findMany({
    where: { userId: { in: userIds } },
  });
  if (subs.length === 0) return;

  const body = JSON.stringify(payload);

  await Promise.all(
    subs.map(async (s) => {
      const subscription: WPSubscription = {
        endpoint: s.endpoint,
        keys: { p256dh: s.p256dh, auth: s.auth },
      };
      try {
        await webpush.sendNotification(subscription, body);
      } catch (err: unknown) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          // Gone — clean up so we stop trying.
          await prisma.pushSubscription
            .delete({ where: { id: s.id } })
            .catch(() => {});
        } else {
          logger.error("push send failed", {
            subscriptionId: s.id,
            statusCode: status,
            err: err as Error,
          });
        }
      }
    }),
  );
}
