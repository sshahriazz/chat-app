import Redis from "ioredis";
import { env } from "../env";
import { logger } from "./logger";

/**
 * ioredis singleton. Connects eagerly so a misconfigured REDIS_URL fails
 * loudly at boot rather than at first use.
 *
 * globalThis-cached during dev to survive tsx watch's hot restart without
 * leaking sockets.
 */

const globalForRedis = globalThis as unknown as { __redis?: Redis };

function createClient(): Redis {
  const client = new Redis(env.REDIS_URL, {
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    reconnectOnError: (err) => err.message.includes("READONLY"),
    connectTimeout: 5_000,
    connectionName: "chat-app-server",
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });

  client.on("error", (err) =>
    logger.error({ err: { name: err.name, message: err.message } }, "[redis] connection error"),
  );
  client.on("ready", () => logger.info("[redis] ready"));
  client.on("end", () => logger.warn("[redis] connection ended"));
  client.on("reconnecting", (ms: number) =>
    logger.warn({ inMs: ms }, "[redis] reconnecting"),
  );

  return client;
}

export const redis: Redis = globalForRedis.__redis ?? createClient();
if (env.NODE_ENV !== "production") globalForRedis.__redis = redis;
