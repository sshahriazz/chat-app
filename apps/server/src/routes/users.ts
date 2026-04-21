import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";
import { generalLimiter, searchLimiter } from "../middleware/rate-limit";
import { prisma } from "../db";

const router: Router = Router();

// A user counts as "online" if they touched the app within this window.
const ONLINE_WINDOW_MS = 60_000;

function isOnline(lastActiveAt: Date | null | undefined): boolean {
  if (!lastActiveAt) return false;
  return Date.now() - new Date(lastActiveAt).getTime() < ONLINE_WINDOW_MS;
}

// ─── Search users by name or email ────────────────────────────

router.get("/search", requireAuth, searchLimiter, async (req, res) => {
  const { user } = req as AuthenticatedRequest;
  const q = ((req.query.q as string) || "").trim();

  if (q.length < 2 || q.length > 64) {
    res.status(400).json({ error: "Query must be 2-64 characters" });
    return;
  }

  const users = await prisma.user.findMany({
    where: {
      id: { not: user.id },
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
      ],
    },
    select: {
      id: true,
      name: true,
      email: true,
      image: true,
      lastActiveAt: true,
    },
    take: 20,
  });

  const results = users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    image: u.image,
    lastActiveAt: u.lastActiveAt,
    online: isOnline(u.lastActiveAt),
  }));

  res.json(results);
});

// ─── Get online status for a list of user IDs ─────────────────

router.post("/online", requireAuth, generalLimiter, async (req, res) => {
  const { userIds } = req.body as { userIds?: unknown };

  if (
    !Array.isArray(userIds) ||
    userIds.length === 0 ||
    userIds.length > 200 ||
    !userIds.every((v) => typeof v === "string" && v.length <= 128)
  ) {
    res.status(400).json({
      error: "userIds must be an array of 1-200 string ids (≤128 chars each)",
    });
    return;
  }

  const users = await prisma.user.findMany({
    where: { id: { in: userIds as string[] } },
    select: { id: true, lastActiveAt: true },
  });

  const onlineIds = users.filter((u) => isOnline(u.lastActiveAt)).map((u) => u.id);
  res.json({ online: onlineIds });
});

export default router;
