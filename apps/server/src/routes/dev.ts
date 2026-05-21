import crypto from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import argon2 from "argon2";
import { z } from "zod";
import "zod-openapi";
import { validate } from "../http/validate";
import { env } from "../env";
import { NotFoundError, UnauthorizedError } from "../http/errors";
import { mintUserToken, MAX_TENANT_TOKEN_TTL_SEC } from "../http/jwt-tenant";
import { getTenantById, wrapSecret } from "../lib/tenant";
import { prisma } from "../db";
import { DEMO_TENANTS } from "../lib/demo-personas";

/**
 * Dev-only helper: mint a tenant-signed user JWT using the target
 * tenant's stored jwtSecret so the reference client (apps/web) can
 * simulate what a real tenant's backend would do in production.
 *
 * Gate model (defense-in-depth):
 *   1. Hard kill-switch — if NODE_ENV === "production" the entire
 *      router returns 404 unconditionally. The previous
 *      `DEV_MINT_ENABLED` prod opt-in is gone: there is no toggle
 *      that exposes these routes in a production build.
 *   2. If `MASTER_API_KEY` is set, every request must carry it as
 *      `Authorization: Bearer …`. This protects non-prod environments
 *      that happen to be reachable from the internet (staging, etc.)
 *      from anonymous abuse. Local dev with no MASTER_API_KEY remains
 *      unauthenticated for the reference web client's persona picker.
 */

const router: Router = Router();

router.use((_req, _res, next) => {
  if (env.NODE_ENV === "production") {
    next(new NotFoundError("Dev mint disabled"));
    return;
  }
  next();
});

// Constant-time bearer compare against MASTER_API_KEY when configured.
// Mirrors `require-master-key.ts` so an operator who sets a master key
// gets the same protection on dev routes as on admin routes.
function requireDevAuth(req: Request, _res: Response, next: NextFunction) {
  const expected = env.MASTER_API_KEY;
  if (!expected) {
    next();
    return;
  }
  const header = req.headers.authorization;
  const match = typeof header === "string" ? header.match(/^Bearer\s+(.+)$/) : null;
  const provided = match ? match[1] : null;
  if (!provided) {
    next(new UnauthorizedError("Missing master key"));
    return;
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    next(new UnauthorizedError("Invalid master key"));
    return;
  }
  next();
}
router.use(requireDevAuth);

const MintTokenBodySchema = z
  .object({
    tenantId: z.string().min(1).default("default"),
    externalId: z.string().min(1).max(256),
    name: z.string().min(1).max(128),
    image: z.string().url().max(2048).nullable().optional(),
    email: z.string().email().max(254).nullable().optional(),
    // Optional second-level partition inside the tenant. Non-null
    // restricts user discovery + add-member to same-scope + tenant-wide
    // peers. Null/absent = tenant-wide (admin-style).
    scope: z.string().min(1).max(128).nullable().optional(),
    // Cap matches the server-enforced verify ceiling — minting a token
    // longer than MAX_TENANT_TOKEN_TTL_SEC would just be rejected on the
    // next request.
    ttlSeconds: z
      .number()
      .int()
      .positive()
      .max(MAX_TENANT_TOKEN_TTL_SEC)
      .optional(),
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
      scope?: string | null;
      ttlSeconds?: number;
    };

    // `getTenantById` handles AES-GCM unwrap when JWT_SECRET_ENCRYPTION_KEY
    // is set. Reading the `jwt_secret` column directly would hand us the
    // `enc:v1:…` ciphertext and every minted token would fail verify.
    const tenant = await getTenantById(body.tenantId);
    if (!tenant) throw new NotFoundError("Tenant not found");

    const token = mintUserToken(tenant.id, tenant.jwtSecret, {
      externalId: body.externalId,
      name: body.name,
      image: body.image ?? null,
      email: body.email ?? null,
      // `scope: undefined` → omitted from the token, so upsertFederatedUser
      // will leave any existing scope alone. Explicit null → tenant-wide.
      ...(body.scope !== undefined ? { scope: body.scope } : {}),
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

// ─── Demo personas + seed ─────────────────────────────────────
//
// The reference web client ships a persona-picker sign-in screen that
// demonstrates tenant + scope isolation end-to-end. These two routes
// back it:
//
//   GET  /api/dev/personas    → list the pre-defined demo personas
//   POST /api/dev/seed-demo   → idempotently create the backing
//                               Tenant rows so /mint-token can sign
//                               tokens for them.
//
// The demo tenants carry random apiKey/jwtSecret values — nobody
// actually uses the apiKey side (no webhook flows in the demo) and
// the JWT flow only needs jwtSecret server-side. We never surface
// these values to the client; persona login goes through mint-token
// which reads them internally.

const ARGON2_OPTS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

router.get("/personas", (_req, res) => {
  res.json({ tenants: DEMO_TENANTS });
});

router.post("/seed-demo", async (_req, res) => {
  const results: Array<{ tenantId: string; created: boolean }> = [];
  for (const t of DEMO_TENANTS) {
    const existing = await prisma.tenant.findUnique({ where: { id: t.tenantId } });
    if (existing) {
      results.push({ tenantId: t.tenantId, created: false });
      continue;
    }
    const rawApiKey = crypto.randomBytes(32).toString("base64url");
    const rawJwtSecret = crypto.randomBytes(32).toString("base64url");
    await prisma.tenant.create({
      data: {
        id: t.tenantId,
        name: t.tenantLabel,
        apiKeyHash: await argon2.hash(rawApiKey, ARGON2_OPTS),
        apiKeyPrefix: rawApiKey.slice(0, 8),
        jwtSecret: wrapSecret(rawJwtSecret),
      },
    });
    results.push({ tenantId: t.tenantId, created: true });
  }
  res.json({ results });
});

export default router;
