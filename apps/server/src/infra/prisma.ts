import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { env, isProduction } from "../env";
import { logger } from "./logger";

/**
 * Prisma singleton.
 *
 * - Uses the `@prisma/adapter-pg` native driver with an explicit
 *   `max` pool size (DB_POOL_MAX). Default Prisma pool sizing is
 *   CPU-dependent; being explicit makes capacity planning predictable.
 * - globalThis-cached in dev to survive tsx watch's hot restart.
 * - Log events are bridged into pino so there's a single log stream
 *   (no separate stdout lines from Prisma's default logger).
 */

const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient };

function createPrismaClient(): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: env.DATABASE_URL,
    max: env.DB_POOL_MAX,
  });

  const client = new PrismaClient({
    adapter,
    // Emit log events rather than writing them directly so pino owns the
    // output format. In prod we only care about errors; in dev we surface
    // warnings and queries too for debuggability.
    log: isProduction
      ? [{ emit: "event", level: "error" }]
      : [
          { emit: "event", level: "error" },
          { emit: "event", level: "warn" },
        ],
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).$on("error", (e: { message: string; target?: string }) => {
    logger.error({ target: e.target }, `[prisma] ${e.message}`);
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).$on("warn", (e: { message: string; target?: string }) => {
    logger.warn({ target: e.target }, `[prisma] ${e.message}`);
  });

  return client;
}

export const prisma: PrismaClient =
  globalForPrisma.__prisma ?? createPrismaClient();
if (!isProduction) globalForPrisma.__prisma = prisma;
