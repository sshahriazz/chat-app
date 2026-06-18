import { Router, type Request, type Response } from "express";
import { prisma } from "../infra/prisma";
import { redis } from "../infra/redis";

const router: Router = Router();

/**
 * Runs the dependency checks in parallel so a slow one doesn't serialize
 * the others. Each check has its own try/catch — a hung connection on
 * one dep mustn't take down the health-check response.
 */
async function checkDependencies(): Promise<{
  db: "ok" | "fail";
  redis: "ok" | "fail";
  healthy: boolean;
}> {
  const [dbResult, redisResult] = await Promise.all([
    prisma
      .$queryRaw`SELECT 1`
      .then(() => "ok" as const)
      .catch(() => "fail" as const),
    redis
      .ping()
      .then((pong) => (pong === "PONG" ? ("ok" as const) : ("fail" as const)))
      .catch(() => "fail" as const),
  ]);
  return {
    db: dbResult,
    redis: redisResult,
    healthy: dbResult === "ok" && redisResult === "ok",
  };
}

/**
 * Liveness probe. Always returns 200 while the process is up. The
 * payload is intentionally minimal (`{ status: "ok" }`) — it's an
 * unauthenticated endpoint, so it must not advertise which dependency
 * is up/down to anyone who curls it. Per-dependency detail lives on the
 * readiness probe (used by the LB) and /metrics (gated).
 *
 * `/health` is a legacy alias some probes (IDE live-check, generic uptime
 * monitors) still default to.
 */
async function livenessHandler(_req: Request, res: Response): Promise<void> {
  res.json({ status: "ok" });
}

router.get("/livez", livenessHandler);
router.get("/health", livenessHandler);

/**
 * Readiness probe: mirrors dep health into the HTTP status code so a
 * load-balancer knows to pull this instance out of rotation until its
 * dependencies recover.
 */
router.get("/readyz", async (_req: Request, res: Response) => {
  const deps = await checkDependencies();
  // Status code carries the signal the LB needs; the body stays minimal
  // (no per-dependency detail) since this is unauthenticated. Detailed
  // dep health is on the gated /metrics endpoint.
  res.status(deps.healthy ? 200 : 503).json({
    status: deps.healthy ? "ok" : "degraded",
  });
});

export default router;
