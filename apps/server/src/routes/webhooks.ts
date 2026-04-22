import { Router } from "express";
import { z } from "zod";
import "zod-openapi";
import { validate } from "../http/validate";
import {
  requireApiKey,
  type ApiKeyAuthenticatedRequest,
} from "../middleware/require-api-key";
import {
  applyTenantUserUpdate,
  deleteFederatedUser,
} from "../lib/user-federation";
import rateLimit from "express-rate-limit";
import RedisStore from "rate-limit-redis";
import { redis } from "../infra/redis";

const router: Router = Router();

// ─── Rate limiters ───────────────────────────────────────────
// Per-tenant bucket (100/min) blocks a compromised API key from
// broadcasting `user_updated` storms. Per (tenant, externalId) bucket
// (10/min) catches bugs in a tenant's backend that would re-push the
// same profile on every frame.

const tenantBucket = rateLimit({
  windowMs: 60_000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) =>
    `rl:webhook:tenant:${(req as ApiKeyAuthenticatedRequest).tenantId}`,
  store: new RedisStore({
    sendCommand: (...args: string[]) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (redis.call as any)(...args),
  }),
});

const userBucket = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => {
    const tid = (req as ApiKeyAuthenticatedRequest).tenantId;
    const ext = (req.body as { externalId?: unknown })?.externalId ?? "unknown";
    return `rl:webhook:user:${tid}:${String(ext)}`;
  },
  store: new RedisStore({
    sendCommand: (...args: string[]) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (redis.call as any)(...args),
  }),
});

// ─── Schemas ─────────────────────────────────────────────────

export const UsersUpdatedWebhookBodySchema = z
  .object({
    externalId: z.string().min(1).max(256),
    name: z.string().min(1).max(128),
    image: z.string().url().max(2048).nullable().optional(),
    email: z.string().email().max(254).nullable().optional(),
  })
  .meta({ id: "UsersUpdatedWebhookBody" });

export const UsersDeletedWebhookBodySchema = z
  .object({
    externalId: z.string().min(1).max(256),
  })
  .meta({ id: "UsersDeletedWebhookBody" });

// ─── POST /api/webhooks/users.updated ────────────────────────
//
// Idempotent: tenant sends the full desired state every time. We upsert
// the User row, invalidate the profile cache, and broadcast
// `user_updated` to live peers via Centrifugo. Responds 202 Accepted
// because the broadcast is fire-and-forget — the HTTP response doesn't
// wait for every peer to receive it.

router.post(
  "/users.updated",
  requireApiKey,
  tenantBucket,
  userBucket,
  validate({ body: UsersUpdatedWebhookBodySchema }),
  async (req, res) => {
    const { tenantId } = req as ApiKeyAuthenticatedRequest;
    const body = req.body as {
      externalId: string;
      name: string;
      image?: string | null;
      email?: string | null;
    };
    await applyTenantUserUpdate(tenantId, {
      externalId: body.externalId,
      name: body.name,
      image: body.image ?? null,
      email: body.email ?? null,
    });
    res.status(202).json({ accepted: true });
  },
);

// ─── POST /api/webhooks/users.deleted ────────────────────────
//
// Cascade-deletes the user + everything FK'd to them. S3 objects are
// reaped by the orphan-attachment GC (async) so this response is fast
// regardless of history size. 202 if the user existed, 404 if not —
// either is idempotent: retries land the same result.

router.post(
  "/users.deleted",
  requireApiKey,
  tenantBucket,
  userBucket,
  validate({ body: UsersDeletedWebhookBodySchema }),
  async (req, res) => {
    const { tenantId } = req as ApiKeyAuthenticatedRequest;
    const { externalId } = req.body as { externalId: string };
    const result = await deleteFederatedUser(tenantId, externalId);
    res.status(result.deleted ? 202 : 404).json({ deleted: result.deleted });
  },
);

export default router;
