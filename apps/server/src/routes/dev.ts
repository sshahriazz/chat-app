import { Router } from "express";
import { z } from "zod";
import "zod-openapi";
import { validate } from "../http/validate";
import { env } from "../env";
import { ForbiddenError, NotFoundError } from "../http/errors";
import { prisma } from "../db";
import { mintUserToken } from "../http/jwt-tenant";

/**
 * Dev-only helper: mint a tenant-signed user JWT using the target
 * tenant's stored jwtSecret so the reference client (apps/web) can
 * simulate what a real tenant's backend would do in production.
 *
 * Gated on `NODE_ENV !== "production"` OR explicit `DEV_MINT_ENABLED=true`.
 * Real customer deployments never enable this — their tenant's own
 * backend owns JWT minting.
 */

const router: Router = Router();

// Hard kill switch — returns 404 if the env doesn't opt in.
router.use((_req, _res, next) => {
  const enabled =
    env.NODE_ENV !== "production" || env.DEV_MINT_ENABLED === true;
  if (!enabled) {
    next(new NotFoundError("Dev mint disabled"));
    return;
  }
  next();
});

const MintTokenBodySchema = z
  .object({
    tenantId: z.string().min(1).default("default"),
    externalId: z.string().min(1).max(256),
    name: z.string().min(1).max(128),
    image: z.string().url().max(2048).nullable().optional(),
    email: z.string().email().max(254).nullable().optional(),
    ttlSeconds: z.number().int().positive().max(24 * 60 * 60).optional(),
  })
  .meta({ id: "DevMintTokenBody" });

// POST /api/dev/mint-token — returns { token, tenantId, externalId, expiresIn }
router.post(
  "/mint-token",
  validate({ body: MintTokenBodySchema }),
  async (req, res) => {
    const body = req.body as {
      tenantId: string;
      externalId: string;
      name: string;
      image?: string | null;
      email?: string | null;
      ttlSeconds?: number;
    };

    // Extra guard in prod: even if DEV_MINT_ENABLED=true accidentally
    // leaks out, require an ALLOW_DEV_MINT_TENANTS env allowlist so
    // operators have to opt-in per tenant.
    if (env.NODE_ENV === "production") {
      const allowed = (env.ALLOW_DEV_MINT_TENANTS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (!allowed.includes(body.tenantId)) {
        throw new ForbiddenError(
          "Dev mint not allowed for this tenant in production",
        );
      }
    }

    const tenant = await prisma.tenant.findUnique({
      where: { id: body.tenantId },
      select: { id: true, jwtSecret: true },
    });
    if (!tenant) throw new NotFoundError("Tenant not found");

    const token = mintUserToken(tenant.id, tenant.jwtSecret, {
      externalId: body.externalId,
      name: body.name,
      image: body.image ?? null,
      email: body.email ?? null,
      ttlSeconds: body.ttlSeconds,
    });

    res.status(200).json({
      token,
      tenantId: tenant.id,
      externalId: body.externalId,
      expiresIn: body.ttlSeconds ?? 3600,
    });
  },
);

export default router;
