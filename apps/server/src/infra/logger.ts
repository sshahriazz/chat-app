import pino, { type Logger } from "pino";
import { env, isProduction } from "../env";
import { getRequestContext } from "./request-context";

/**
 * pino-backed structured logger.
 *
 * Rules:
 * - Always call `getLogger()` from inside request handlers / services so
 *   the log line auto-carries `reqId` (+ `userId` after auth).
 * - Bare `logger` is only for boot-time code that runs before any request
 *   has been established.
 * - Sensitive fields are redacted at the pino config level; the redact
 *   paths cover the common names we'd accidentally log.
 */
export const logger: Logger = pino({
  level: env.LOG_LEVEL ?? (isProduction ? "info" : "debug"),
  base: { service: "chat-app-server", env: env.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "headers.authorization",
      "headers.cookie",
      "*.password",
      "*.token",
      "*.secret",
      "*.p256dh",
      "*.auth",
      "*.accessToken",
      "*.refreshToken",
      "*.idToken",
      "*.content",
      "*.plainContent",
      "*.payload",
    ],
    remove: true,
  },
  ...(isProduction
    ? {
        // In prod we write JSON lines directly to stdout (fd 1); the
        // platform log collector picks them up.
        transport: {
          target: "pino/file",
          options: { destination: 1 },
        },
      }
    : {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss.l",
            singleLine: true,
          },
        },
      }),
});

/**
 * Request-scoped logger. Returns a child logger with `reqId` + (when set)
 * `userId` attached so every line is correlated without each call site
 * having to remember.
 */
export function getLogger(): Logger {
  const ctx = getRequestContext();
  if (!ctx) return logger;
  return logger.child({
    reqId: ctx.requestId,
    ...(ctx.userId ? { userId: ctx.userId } : {}),
  });
}
