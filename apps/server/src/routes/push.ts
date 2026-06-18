import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";
import { prisma } from "../db";
import { getVapidPublicKey, isPushConfigured } from "../lib/push";
import { validate } from "../http/validate";
import {
  PushSubscribeBodySchema,
  PushUnsubscribeBodySchema,
} from "../http/schemas";
import { ConflictError, ServiceUnavailableError } from "../http/errors";

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
// Inserts (or refreshes keys for) a push subscription owned by the
// authenticated user. We do NOT silently rebind endpoints across
// users: if `endpoint` already belongs to a different user we reject
// with 409. Reusing an endpoint owned by someone else would let an
// attacker who learned another user's endpoint (via leaked logs,
// device sharing, etc.) hijack push delivery.
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

    const existing = await prisma.pushSubscription.findUnique({
      where: { endpoint: body.endpoint },
      select: { userId: true, tenantId: true },
    });
    if (existing && (existing.userId !== user.id || existing.tenantId !== tenantId)) {
      throw new ConflictError("Push endpoint already registered to another user");
    }

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
        // Only the keys can change — userId/tenantId are pinned via the
        // ownership check above and intentionally not in this update.
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
      },
    });

    res.json({ ok: true });
  },
);

// POST /api/push/unsubscribe
// Scoped to the authenticated user — without userId, any tenant
// member who learned another user's endpoint could silently
// unsubscribe them (denial of notifications).
router.post(
  "/unsubscribe",
  requireAuth,
  validate({ body: PushUnsubscribeBodySchema }),
  async (req, res) => {
    const { user, tenantId } = req as AuthenticatedRequest;
    const { endpoint } = req.body as { endpoint: string };
    await prisma.pushSubscription
      .deleteMany({ where: { tenantId, userId: user.id, endpoint } })
      .catch(() => {});
    res.json({ ok: true });
  },
);

export default router;
