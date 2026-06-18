import { Router } from "express";
import { validate } from "../http/validate";
import { CreateTenantBodySchema } from "../http/schemas";
import { requireMasterKey } from "../middleware/require-master-key";
import { createTenant, rotateApiKey, rotateJwtSecret } from "../lib/tenant";
import { writeAdminAudit } from "../lib/admin-audit";
import { NotFoundError } from "../http/errors";
import { prisma } from "../db";

/**
 * Admin endpoints — gated by `MASTER_API_KEY` env var, meant for the
 * operator (you) to onboard tenants and rotate their credentials.
 * No UI yet; curl from a trusted machine.
 *
 * Tenants never touch these endpoints; their own dashboard would.
 */

const router: Router = Router();

router.use(requireMasterKey);

// POST /api/admin/tenants
router.post(
  "/tenants",
  validate({ body: CreateTenantBodySchema }),
  async (req, res) => {
    const { name } = req.body as { name: string };
    const tenant = await createTenant(name);
    // apiKey + jwtSecret are surfaced HERE and nowhere else. Caller
    // MUST persist both; re-rotation is the only recovery path.
    await writeAdminAudit(req, {
      action: "tenant.create",
      tenantId: tenant.id,
      details: { name },
    });
    res.status(201).json(tenant);
  },
);

// GET /api/admin/tenants — list tenants (hashes + secrets are masked)
router.get("/tenants", async (_req, res) => {
  const tenants = await prisma.tenant.findMany({
    select: { id: true, name: true, createdAt: true, updatedAt: true },
    orderBy: { createdAt: "asc" },
  });
  res.json({ tenants });
});

// POST /api/admin/tenants/:id/api-keys — rotate API key
router.post("/tenants/:id/api-keys", async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const tenant = await prisma.tenant.findUnique({
    where: { id },
    select: { id: true, apiKeyPrefix: true },
  });
  if (!tenant) throw new NotFoundError("Tenant not found");
  const apiKey = await rotateApiKey(id);
  await writeAdminAudit(req, {
    action: "tenant.rotateApiKey",
    tenantId: id,
    // Record the previous key prefix only — never the raw key, even at
    // the moment of rotation. The new key is returned to the caller and
    // never reaches the audit log.
    details: { previousApiKeyPrefix: tenant.apiKeyPrefix ?? null },
  });
  res.status(200).json({ apiKey, rotatedAt: new Date().toISOString() });
});

// POST /api/admin/tenants/:id/jwt-secret/rotate — rotate jwt-signing secret
router.post("/tenants/:id/jwt-secret/rotate", async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const tenant = await prisma.tenant.findUnique({ where: { id } });
  if (!tenant) throw new NotFoundError("Tenant not found");
  const jwtSecret = await rotateJwtSecret(id);
  await writeAdminAudit(req, {
    action: "tenant.rotateJwtSecret",
    tenantId: id,
    // No previous-secret data captured — the secret never reaches the
    // audit log, even hashed. Rotation alone is the audited event.
    details: {},
  });
  res.status(200).json({ jwtSecret, rotatedAt: new Date().toISOString() });
});

export default router;
