import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { env, isProduction } from "../env";
import { logger } from "./logger";
import { tenantContext } from "../lib/tenant-context";

/**
 * Prisma singleton.
 *
 * - Uses the `@prisma/adapter-pg` native driver with an explicit `max`
 *   pool size (DB_POOL_MAX).
 * - globalThis-cached in dev to survive tsx watch's hot restart.
 * - Log events are bridged into pino so there's a single log stream.
 *
 * RLS extension: every model query issued while a tenant context is active
 * (set by `require-user-jwt`) is wrapped in a transaction that first sets
 * the `app.current_tenant_id` Postgres GUC, so the Row-Level Security
 * policies restrict it to that tenant (defense-in-depth beneath the
 * app-layer `WHERE tenant_id = ?` filters). Queries with no context, or
 * inside an app-managed interactive transaction, run unwrapped and rely on
 * the RLS fail-open-when-no-context policy — see lib/tenant-context.ts and
 * the row_level_security migration.
 */

const globalForPrisma = globalThis as unknown as { __prismaBase?: PrismaClient };

function createBaseClient(): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: env.DATABASE_URL,
    max: env.DB_POOL_MAX,
  });

  const client = new PrismaClient({
    adapter,
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

const base = globalForPrisma.__prismaBase ?? createBaseClient();
if (!isProduction) globalForPrisma.__prismaBase = base;

export const prisma = base.$extends({
  query: {
    $allModels: {
      async $allOperations({ args, query }) {
        const ctx = tenantContext.getStore();
        // No tenant context (system/cron/admin/boot, and auth-resolution
        // queries that run before request context is established) OR
        // already inside an app-managed interactive transaction: run
        // as-is. RLS is fail-open-when-no-context, so this is safe; the
        // app-layer tenant filters remain the primary control there.
        if (!ctx?.tenantId || ctx.inManagedTx) {
          return query(args);
        }
        // Set the tenant GUC (transaction-local) then run the query in the
        // same transaction so the RLS policy restricts it to this tenant.
        const [, result] = await base.$transaction([
          base.$executeRaw`SELECT set_config('app.current_tenant_id', ${ctx.tenantId}, true)`,
          query(args),
        ]);
        return result;
      },
    },
  },
});

/**
 * Interactive-transaction client type for the EXTENDED client (the `tx`
 * passed to `prisma.$transaction(async (tx) => ...)`). Mirrors
 * `Prisma.TransactionClient` but for the extended client — use this for
 * helpers that accept a `tx` (keeps `$executeRaw`/`$queryRaw` + model
 * delegates, drops client-lifecycle methods).
 */
export type TxClient = Omit<
  typeof prisma,
  "$connect" | "$disconnect" | "$extends" | "$transaction" | "$use"
>;
