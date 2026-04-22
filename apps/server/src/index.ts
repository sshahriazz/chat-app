import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./auth";
import { env } from "./env";
import { logger } from "./infra/logger";
import { prisma } from "./infra/prisma";
import { redis } from "./infra/redis";
import { requestId } from "./middleware/request-id";
import { authLimiter } from "./middleware/rate-limit";
import healthRoutes from "./routes/health";
import centrifugoRoutes from "./routes/centrifugo";
import chatRoutes from "./routes/chat";
import userRoutes from "./routes/users";
import attachmentRoutes from "./routes/attachments";
import pushRoutes from "./routes/push";
import webhookRoutes from "./routes/webhooks";
import adminRoutes from "./routes/admin";
import { apiReference } from "@scalar/express-api-reference";
import { getOpenApiDocument } from "./http/openapi";
import { httpMetrics } from "./middleware/metrics";
import { outboxDepth, outboxOldestAgeSeconds, registry as metricsRegistry } from "./infra/metrics";

const app = express();

/**
 * CORS allowlist resolution order:
 *   1. `CORS_ALLOWED_ORIGINS` env (comma-separated) — explicit override
 *   2. `BETTER_AUTH_URL` — the app's public URL, which is required and
 *      must also be the browser's origin since everything is same-origin
 *      behind the Next.js proxy. Falling back to it means "I set the
 *      public URL, origins Just Work"
 *   3. Dev fallback
 *
 * env.ts already hard-fails at boot if CORS_ALLOWED_ORIGINS is unset
 * AND NODE_ENV=production, so in prod we always have an explicit value.
 * The fallback chain below covers the dev + mis-configured cases.
 */
const allowedOrigins: string[] = (
  env.CORS_ALLOWED_ORIGINS ??
  env.BETTER_AUTH_URL ??
  "http://localhost:3000,http://192.168.0.103:3000"
)
  .split(",")
  .map((s: string) => s.trim())
  .filter(Boolean);

logger.info(
  {
    nodeEnv: env.NODE_ENV,
    publicUrl: env.BETTER_AUTH_URL,
    corsAllowedOrigins: allowedOrigins,
    trustProxy: env.TRUST_PROXY,
    s3Endpoint: env.S3_ENDPOINT,
    s3PublicUrlBase: env.S3_PUBLIC_URL_BASE,
  },
  "startup config",
);

// --- Boot-time hardening ----------------------------------------------------

// Don't leak framework identity in the Server header.
app.disable("x-powered-by");
// Trust the first reverse-proxy hop's X-Forwarded-* headers so req.ip
// reflects the real client rather than the LB.
app.set("trust proxy", env.TRUST_PROXY);

// --- Observability ----------------------------------------------------------

// Request id first, before the logger so every log line carries it.
app.use(requestId);

// HTTP timing + count Prometheus metrics. Mounted before all routers so
// the observer catches the full handler duration, including middleware
// like auth + validate.
app.use(httpMetrics);

// Structured request logs via pino-http, piggy-backing on our pino
// instance so there's a single log stream. Health probes are noisy; drop
// them to debug so prod logs stay readable.
app.use(
  pinoHttp({
    logger,
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      if (res.statusCode >= 300) return "info";
      return "info";
    },
    customProps: (req) => {
      const id = req.headers["x-request-id"];
      return typeof id === "string" ? { reqId: id } : {};
    },
    autoLogging: {
      ignore: (req) => req.url === "/livez" || req.url === "/readyz",
    },
    serializers: {
      req: (req) => ({
        method: req.method,
        url: req.url,
      }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
  }),
);

// --- Security middleware ----------------------------------------------------

app.use(
  helmet({
    // The Next.js app loads our API from a different origin; allow the
    // relevant CORP/COEP defaults but keep the rest of helmet's hardening.
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  }),
);

// Health probes before auth + body parsing — they must be dependency-cheap
// and bypass every middleware that could 401 or fail.
app.use(healthRoutes);

// Prometheus scrape target. Unauthenticated on purpose (standard
// convention); protect by binding to an internal network, firewall, or
// service-mesh mTLS in production. Kept next to health probes so it's
// available without auth or body parsing running first.
app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", metricsRegistry.contentType);
  res.end(await metricsRegistry.metrics());
});

// --- API documentation ------------------------------------------------------
//
// Zod schemas → OpenAPI 3.1 document → Scalar UI. Registered before auth so
// the docs are reachable without a session. Kept unauthenticated on purpose:
// the server's HTTP surface is not a secret and having the docs 401 breaks
// the ergonomic case of cURLing a route by clicking "Try it".
app.get("/openapi.json", (_req, res) => {
  res.json(getOpenApiDocument());
});
// Scalar's shell pulls its bundle from jsdelivr, uses eval internally,
// fetches source maps, and (by default) talks to api.scalar.com for a
// curated registry. The app-wide strict CSP blocks all of that. Disable
// CSP on `/docs` alone — every real API route keeps the hardened default,
// and the docs page is a third-party renderer whose attack surface is
// already a function of trusting Scalar's CDN.
app.use(
  "/docs",
  (_req, res, next) => {
    // The global helmet() above already stamped CSP; per-route helmet
    // can't un-set a header an upstream middleware added. Strip it here
    // so Scalar's CDN bundle + inline bootstrap + eval-based runtime
    // + api.scalar.com fetches all work.
    res.removeHeader("Content-Security-Policy");
    next();
  },
  apiReference({
    url: "/openapi.json",
    theme: "default",
  }),
);

// better-auth catch-all reads the raw request stream, so must come BEFORE
// express.json(). Brute-force limiter in front of sign-in + sign-up.
app.use(["/api/auth/sign-in", "/api/auth/sign-up"], authLimiter);
app.all("/api/auth/*splat", toNodeHandler(auth));

// --- Route tree -------------------------------------------------------------
//
// Body-size limits are tuned per route-tree rather than a single global
// cap. A tight limit on low-churn endpoints (push subs, tokens, user
// search) costs nothing and shrinks the DoS surface if the app-level
// rate limiter ever fails open. Only the chat catch-all gets a 512 KB
// ceiling because rich Tiptap JSON for a long message can legitimately
// serialize above the global default.
app.use("/api/centrifugo", express.json({ limit: "4kb" }), centrifugoRoutes);
app.use("/api/users", express.json({ limit: "32kb" }), userRoutes);
app.use("/api/attachments", express.json({ limit: "8kb" }), attachmentRoutes);
app.use("/api/push", express.json({ limit: "4kb" }), pushRoutes);
// Tenancy: webhooks (tenant backends → us) + admin (operator → us).
// Both dormant in PR 1 — mounted but no existing user/session code paths
// reach them yet.
app.use("/api/webhooks", express.json({ limit: "8kb" }), webhookRoutes);
app.use("/api/admin", express.json({ limit: "4kb" }), adminRoutes);
// Chat catch-all registered last so more specific prefixes above match
// first. 512 KB covers the worst-case serialized Tiptap doc (50K plain
// chars × ~3× markup overhead) plus request-shape overhead.
app.use("/api", express.json({ limit: "512kb" }), chatRoutes);

// --- Terminal error sink ----------------------------------------------------
//
// Any error thrown (or passed to `next(err)`) by a handler lands here.
// DomainError subclasses carry their own status/code/details; everything
// else is treated as an unhandled 500 and logged with full context so the
// stack is still reachable in logs without leaking to clients.
import { isDomainError } from "./http/errors";
import { ERROR_CODES } from "./http/openapi-shared";

app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const requestId =
    typeof req.headers["x-request-id"] === "string"
      ? (req.headers["x-request-id"] as string)
      : undefined;

  if (isDomainError(err)) {
    // 4xx is a warn, 5xx is an error. DomainError should never be 5xx
    // under normal use — if we add one, update this branch.
    const logLevel = err.httpStatus >= 500 ? "error" : "warn";
    req.log?.[logLevel](
      {
        err: { name: err.name, code: err.code, message: err.message },
        status: err.httpStatus,
      },
      "domain error",
    );
    res.status(err.httpStatus).json({
      status: err.httpStatus,
      error: err.message,
      code: err.code,
      requestId,
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }

  // Recognize errors thrown by built-in middleware (express.json's
  // body-parser, for example) that carry a numeric status. Map to the
  // canonical envelope rather than leaking a 500.
  const e = err as {
    message?: string;
    name?: string;
    stack?: string;
    status?: number;
    statusCode?: number;
    type?: string;
  };
  const parserStatus = e.status ?? e.statusCode;
  if (typeof parserStatus === "number" && parserStatus >= 400 && parserStatus < 500) {
    const code =
      parserStatus === 413
        ? ERROR_CODES.PAYLOAD_TOO_LARGE
        : parserStatus === 415
          ? ERROR_CODES.UNSUPPORTED_MEDIA_TYPE
          : ERROR_CODES.BAD_REQUEST;
    req.log?.warn(
      { err: { name: e.name, message: e.message, type: e.type }, status: parserStatus },
      "framework error",
    );
    if (!res.headersSent) {
      res.status(parserStatus).json({
        status: parserStatus,
        error: e.message ?? "Bad request",
        code,
        requestId,
      });
    }
    return;
  }

  req.log?.error(
    { err: { name: e.name, message: e.message, stack: e.stack }, status: 500 },
    "unhandled error",
  );
  if (!res.headersSent) {
    res.status(500).json({
      status: 500,
      error: "Internal Server Error",
      code: ERROR_CODES.INTERNAL_ERROR,
      requestId,
    });
  }
});

// --- Boot + graceful shutdown -----------------------------------------------

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "server listening");
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutdown starting");

  // Arm the hard-kill timer only once we've actually received a signal.
  // Arming it at boot would fire after SHUTDOWN_TIMEOUT_MS of normal
  // runtime — `.unref()` only stops the timer from keeping the loop
  // alive, not from firing when the loop is alive for other reasons
  // (HTTP server, Redis socket, cron).
  const killTimer = setTimeout(() => {
    logger.error(
      { timeoutMs: env.SHUTDOWN_TIMEOUT_MS },
      "shutdown timeout exceeded, forcing exit",
    );
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS);
  killTimer.unref();

  // Stop accepting new connections. Existing ones drain up to the
  // SHUTDOWN_TIMEOUT_MS cap enforced above.
  server.close((err) => {
    if (err) logger.error({ err: { message: err.message } }, "server close failed");
  });

  try {
    await Promise.all([prisma.$disconnect(), redis.quit()]);
    logger.info("dependencies disconnected");
  } catch (err) {
    logger.error(
      { err: { message: (err as Error).message } },
      "dependency disconnect failed",
    );
  }

  clearTimeout(killTimer);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// --- Background jobs --------------------------------------------------------
//
// Only register when this process owns them. Under a multi-instance
// deploy this is safe per-instance because gcOrphanAttachments is
// idempotent (row deletes race harmlessly).
import("node-cron").then(({ default: cron }) => {
  import("./lib/attachments-gc").then(({ gcOrphanAttachments }) => {
    cron.schedule("5 */6 * * *", async () => {
      try {
        const result = await gcOrphanAttachments();
        if (result.deleted > 0 || result.s3Errors > 0) {
          logger.info(
            { deleted: result.deleted, s3Errors: result.s3Errors },
            "cron attachments-gc",
          );
        }
      } catch (err) {
        logger.error(
          { err: { message: (err as Error).message } },
          "cron attachments-gc failed",
        );
      }
    });
  });
});

// --- Outbox depth sampler ---------------------------------------------------
//
// Samples `chat_outbox` every 10s into Prometheus gauges so we can page
// when Centrifugo's PG consumer falls behind. Healthy steady state is
// depth ≈ 0 and oldest-age ≈ 0; sustained non-zero values indicate the
// consumer is down or lagging.
setInterval(async () => {
  try {
    const rows = await prisma.$queryRaw<
      { depth: bigint; oldest_age_seconds: number | null }[]
    >`
      SELECT COUNT(*)::bigint AS depth,
             EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))::float AS oldest_age_seconds
      FROM chat_outbox
    `;
    const row = rows[0];
    if (row) {
      outboxDepth.set(Number(row.depth));
      outboxOldestAgeSeconds.set(row.oldest_age_seconds ?? 0);
    }
  } catch (err) {
    // Sampler failures are non-fatal; they'd be visible as gauges
    // going stale rather than the app falling over.
    logger.warn(
      { err: { message: (err as Error).message } },
      "outbox sampler failed",
    );
  }
}, 10_000).unref();
