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
 * Liveness probe. Always returns 200 while the process is up — dependency
 * status is included for visibility but does NOT influence the HTTP code.
 * If a dep is flapping, k8s restarting the pod won't help and usually
 * makes things worse; that's readiness's job (below).
 *
 * `/health` is a legacy alias some probes (IDE live-check, generic uptime
 * monitors) still default to.
 */
async function livenessHandler(_req: Request, res: Response): Promise<void> {
  const deps = await checkDependencies();
  res.json({ status: "ok", db: deps.db, redis: deps.redis });
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
  res.status(deps.healthy ? 200 : 503).json({
    status: deps.healthy ? "ok" : "degraded",
    db: deps.db,
    redis: deps.redis,
  });
});

export default router;
