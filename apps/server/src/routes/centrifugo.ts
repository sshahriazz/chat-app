import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";
import {
  generateConnectionToken,
  generateSubscriptionToken,
} from "../lib/centrifugo";
import { prisma } from "../db";

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

router.post("/subscription-token", requireAuth, async (req, res) => {
  const { user } = req as AuthenticatedRequest;
  const { channel } = req.body as { channel?: string };

  if (!channel) {
    res.status(400).json({ error: "channel is required" });
    return;
  }

  const match = channel.match(/^presence:conv_(.+)$/);
  if (!match) {
    res.status(403).json({ error: "forbidden channel" });
    return;
  }

  const conversationId = match[1];

  const member = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId: user.id } },
  });

  if (!member) {
    res.status(403).json({ error: "not a member" });
    return;
  }

  const token = generateSubscriptionToken(user.id, channel);
  res.json({ token });
});

export default router;
