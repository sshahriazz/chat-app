import { Router } from "express";
import { validate } from "../http/validate";
import {
  AdminGrantMembershipBodySchema,
  CreateTenantBodySchema,
} from "../http/schemas";
import { requireMasterKey } from "../middleware/require-master-key";
import { createTenant, rotateApiKey, rotateJwtSecret } from "../lib/tenant";
import { writeAdminAudit } from "../lib/admin-audit";
import { BadRequestError, NotFoundError } from "../http/errors";
import { withRealtime } from "../lib/realtime";
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
    const { name, fullHistoryForNewMembers } = req.body as {
      name: string;
      fullHistoryForNewMembers?: boolean;
    };
    const tenant = await createTenant(name, { fullHistoryForNewMembers });
    // apiKey + jwtSecret are surfaced HERE and nowhere else. Caller
    // MUST persist both; re-rotation is the only recovery path.
    await writeAdminAudit(req, {
      action: "tenant.create",
      tenantId: tenant.id,
      details: { name, fullHistoryForNewMembers: !!fullHistoryForNewMembers },
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

/**
 * POST /api/admin/tenants/:tenantId/conversations/:id/members
 *
 * Grant membership on the tenant's behalf.
 *
 * This exists because OneSuite needs to place a newly-promoted administrator
 * into existing conversations, and the way it did that was to mint the
 * business creator's JWT and act as them. That is an attribution failure
 * rather than a permission one: the audit trail and the "X added Y" system
 * message both named someone who had not done it and may not have been
 * awake. Since H-1 it is also simply unreliable — the borrowed identity has to
 * be owner or admin of every conversation touched, which nothing guarantees.
 *
 * So the platform asks as the platform, says who asked and why, and both facts
 * are recorded where they can be read afterwards.
 *
 * Deliberately NOT bound by the membership policy: an operator grant is the
 * mechanism for repairing membership when the normal path cannot apply. The
 * scope invariant is still enforced, because that one protects tenants from
 * each other rather than protecting a conversation from its own members.
 */
router.post(
  "/tenants/:tenantId/conversations/:id/members",
  validate({ body: AdminGrantMembershipBodySchema }),
  async (req, res) => {
    // Same narrowing the routes above use: Express types a param as
    // `string | string[]`, and a repeated query-style param would otherwise
    // reach Prisma as an array.
    const one = (v: string | string[] | undefined): string =>
      Array.isArray(v) ? v[0] : (v ?? "");
    const tenantId = one(req.params.tenantId);
    const conversationId = one(req.params.id);
    const { userExternalIds, requestedBy, reason } = req.body as {
      userExternalIds: string[];
      requestedBy: string;
      reason: string;
    };

    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, tenantId },
      include: {
        members: { select: { userId: true, user: { select: { scope: true } } } },
      },
    });
    if (!conversation) throw new NotFoundError("Conversation not found");

    const users = await prisma.user.findMany({
      where: { tenantId, externalId: { in: userExternalIds } },
      select: { id: true, name: true, scope: true },
    });
    if (users.length !== userExternalIds.length) {
      throw new BadRequestError("One or more users are unknown in this tenant");
    }

    // H-2 still applies. A conversation belongs to at most one client, and
    // that is a guarantee to the tenants involved rather than a rule about
    // who is asking — an operator grant must not be a way around it.
    const existingClientScope =
      conversation.members.map((m) => m.user.scope).find((s) => s !== null) ??
      null;
    const offending = users.find(
      (u) => u.scope && existingClientScope && u.scope !== existingClientScope,
    );
    if (offending) {
      throw new BadRequestError(
        "That user belongs to a different client than this conversation",
      );
    }

    const alreadyIn = new Set(conversation.members.map((m) => m.userId));
    const toAdd = users.filter((u) => !alreadyIn.has(u.id));

    if (toAdd.length > 0) {
      await withRealtime(async (rt) => {
        await rt.tx.conversationMember.createMany({
          data: toAdd.map((u) => ({
            tenantId,
            conversationId,
            userId: u.id,
            role: "member" as const,
          })),
        });

        // Named for what it is. The people already in the room are entitled to
        // know someone new can read it, and to know it was not one of them who
        // did it.
        await rt.createSystemMessage(
          conversationId,
          toAdd[0].id,
          `${toAdd.map((u) => u.name).join(", ")} added by ${requestedBy}`,
        );
      });
    }

    await writeAdminAudit(req, {
      action: "conversation.members.grant",
      tenantId,
      details: {
        conversationId,
        requestedBy,
        reason,
        granted: toAdd.map((u) => u.id),
        alreadyMembers: users.length - toAdd.length,
      },
    });

    res.json({ granted: toAdd.length, alreadyMembers: users.length - toAdd.length });
  },
);

export default router;