import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";
import { prisma } from "../db";
import { getVapidPublicKey, isPushConfigured } from "../lib/push";

const router: Router = Router();

// GET /api/push/vapid-public-key
// Exposes the public half of the VAPID keypair for the client's
// `pushManager.subscribe` call. Fails loudly if VAPID isn't configured so
// the client can show a helpful error instead of silently not working.
router.get("/vapid-public-key", requireAuth, (_req, res) => {
  const key = getVapidPublicKey();
  if (!key) {
    res.status(503).json({
      error: "Push not configured. Set VAPID_* in apps/server/.env.",
    });
    return;
  }
  res.json({ key });
});

interface SubscribeBody {
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
}

// POST /api/push/subscribe
// Upserts on endpoint (unique) so the same browser re-subscribing doesn't
// leave stale rows. Also rebinds an endpoint to a different user if that
// browser signs in as someone else.
router.post("/subscribe", requireAuth, async (req, res) => {
  if (!isPushConfigured()) {
    res.status(503).json({
      error: "Push not configured. Set VAPID_* in apps/server/.env.",
    });
    return;
  }
  const { user } = req as AuthenticatedRequest;
  const body = req.body as SubscribeBody;

  if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
    res.status(400).json({ error: "endpoint + keys.p256dh + keys.auth required" });
    return;
  }

  await prisma.pushSubscription.upsert({
    where: { endpoint: body.endpoint },
    create: {
      userId: user.id,
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
    },
    update: {
      userId: user.id,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
    },
  });

  res.json({ ok: true });
});

// POST /api/push/unsubscribe
router.post("/unsubscribe", requireAuth, async (req, res) => {
  const { endpoint } = req.body as { endpoint?: string };
  if (!endpoint) {
    res.status(400).json({ error: "endpoint required" });
    return;
  }
  await prisma.pushSubscription
    .deleteMany({ where: { endpoint } })
    .catch(() => {});
  res.json({ ok: true });
});

export default router;
