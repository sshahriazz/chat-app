import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";
import { prisma } from "../db";
import { getVapidPublicKey, isPushConfigured } from "../lib/push";
import { validate } from "../http/validate";
import {
  PushSubscribeBodySchema,
  PushUnsubscribeBodySchema,
} from "../http/schemas";
import { ServiceUnavailableError } from "../http/errors";

const router: Router = Router();

// GET /api/push/vapid-public-key
// Exposes the public half of the VAPID keypair for the client's
// `pushManager.subscribe` call. Fails loudly if VAPID isn't configured so
// the client can show a helpful error instead of silently not working.
router.get("/vapid-public-key", requireAuth, (_req, res) => {
  const key = getVapidPublicKey();
  if (!key) {
    throw new ServiceUnavailableError(
      "Push not configured. Set VAPID_* in apps/server/.env.",
    );
  }
  res.json({ key });
});

// POST /api/push/subscribe
// Upserts on endpoint (unique) so the same browser re-subscribing doesn't
// leave stale rows. Also rebinds an endpoint to a different user if that
// browser signs in as someone else.
router.post(
  "/subscribe",
  requireAuth,
  validate({ body: PushSubscribeBodySchema }),
  async (req, res) => {
    if (!isPushConfigured()) {
      throw new ServiceUnavailableError(
        "Push not configured. Set VAPID_* in apps/server/.env.",
      );
    }
    const { user, tenantId } = req as AuthenticatedRequest;
    const body = req.body as {
      endpoint: string;
      keys: { p256dh: string; auth: string };
    };

    await prisma.pushSubscription.upsert({
      where: { endpoint: body.endpoint },
      create: {
        tenantId,
        userId: user.id,
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
      },
      update: {
        tenantId,
        userId: user.id,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
      },
    });

    res.json({ ok: true });
  },
);

// POST /api/push/unsubscribe
router.post(
  "/unsubscribe",
  requireAuth,
  validate({ body: PushUnsubscribeBodySchema }),
  async (req, res) => {
    const { tenantId } = req as AuthenticatedRequest;
    const { endpoint } = req.body as { endpoint: string };
    await prisma.pushSubscription
      .deleteMany({ where: { tenantId, endpoint } })
      .catch(() => {});
    res.json({ ok: true });
  },
);

export default router;
