import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";
import {
  generateConnectionToken,
  generateSubscriptionToken,
} from "../lib/centrifugo";
import { prisma } from "../db";
import { validate } from "../http/validate";
import { SubscriptionTokenBodySchema } from "../http/schemas";
import { ForbiddenError } from "../http/errors";

const router: Router = Router();

// ─── Connection token ────────────────────────────────────────
// Client calls this on boot (and auto-refresh). JWT auto-subscribes
// the user to `user:{userId}` via the `subs` claim. No connect proxy.

router.post("/connection-token", requireAuth, (req, res) => {
  const { user } = req as AuthenticatedRequest;

  const token = generateConnectionToken(user.id, {
    name: user.name,
    email: user.email,
  });

  
  res.json({ token });
});

// ─── Subscription token for presence channels ────────────────
// Only `presence:conv_{id}` is token-subscribed. The user's own
// `user:{userId}` channel is auto-subscribed via the connection
// token's `subs` claim, so it does not go through here.

router.post(
  "/subscription-token",
  requireAuth,
  validate({ body: SubscriptionTokenBodySchema }),
  async (req, res) => {
    const { user, tenantId } = req as AuthenticatedRequest;
    const { channel } = req.body as { channel: string };

    const match = channel.match(/^presence:conv_(.+)$/);
    if (!match) throw new ForbiddenError("forbidden channel");

    const conversationId = match[1];

    // findFirst with the conversation.tenantId filter is belt-and-
    // braces: cross-tenant memberships can't be forged after the
    // add-member fix, but this keeps the token issuer honest in case
    // of future drift.
    const member = await prisma.conversationMember.findFirst({
      where: {
        conversationId,
        userId: user.id,
        conversation: { tenantId },
      },
    });

    if (!member) throw new ForbiddenError("not a member");

    const token = generateSubscriptionToken(user.id, channel);
    res.json({ token });
  },
);

export default router;
