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
import { apiReference } from "@scalar/express-api-reference";
import { getOpenApiDocument } from "./http/openapi";

const app = express();

const allowedOrigins: string[] = (
  env.CORS_ALLOWED_ORIGINS ?? "http://localhost:3000,http://192.168.0.103:3000"
)
  .split(",")
  .map((s: string) => s.trim())
  .filter(Boolean);

// --- Boot-time hardening ----------------------------------------------------

// Don't leak framework identity in the Server header.
app.disable("x-powered-by");
// Trust the first reverse-proxy hop's X-Forwarded-* headers so req.ip
// reflects the real client rather than the LB.
app.set("trust proxy", env.TRUST_PROXY);

// --- Observability ----------------------------------------------------------

// Request id first, before the logger so every log line carries it.
app.use(requestId);

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

// --- API documentation ------------------------------------------------------
//
// Zod schemas → OpenAPI 3.1 document → Scalar UI. Registered before auth so
// the docs are reachable without a session. Kept unauthenticated on purpose:
// the server's HTTP surface is not a secret and having the docs 401 breaks
// the ergonomic case of cURLing a route by clicking "Try it".
app.get("/openapi.json", (_req, res) => {
  res.json(getOpenApiDocument());
});
// Scalar's shell pulls its bundle from jsdelivr and injects an inline
// bootstrap script; the app-wide strict CSP blocks both. Scope a relaxed
// CSP to `/docs` only so the rest of the server keeps the hardened default.
app.use(
  "/docs",
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "script-src": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
        "script-src-elem": [
          "'self'",
          "'unsafe-inline'",
          "https://cdn.jsdelivr.net",
        ],
        "style-src": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
        "img-src": ["'self'", "data:", "https:"],
        "font-src": ["'self'", "data:", "https://cdn.jsdelivr.net"],
        "connect-src": ["'self'"],
        "worker-src": ["'self'", "blob:"],
      },
    },
  }),
  apiReference({
    url: "/openapi.json",
    theme: "default",
  }),
);

// better-auth catch-all reads the raw request stream, so must come BEFORE
// express.json(). Brute-force limiter in front of sign-in + sign-up.
app.use(["/api/auth/sign-in", "/api/auth/sign-up"], authLimiter);
app.all("/api/auth/*splat", toNodeHandler(auth));

// Body cap = 1 MB. Anything bigger than a chat message with attachments
// already rejects server-side; this is the outer envelope.
app.use(express.json({ limit: "1mb" }));

// --- Route tree -------------------------------------------------------------

app.use("/api/centrifugo", centrifugoRoutes);
app.use("/api/users", userRoutes);
app.use("/api/attachments", attachmentRoutes);
app.use("/api/push", pushRoutes);
app.use("/api", chatRoutes);

// --- Terminal error sink ----------------------------------------------------
//
// A minimal fallback handler — the full DomainError → AppError pipeline
// from the bootstrap guide is a separate sprint (module refactor). For
// now we ensure uncaught errors are JSON-shaped, logged with request
// correlation, and don't leak stacks to clients.
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const e = err as { status?: number; message?: string; name?: string };
  const status = typeof e.status === "number" ? e.status : 500;
  req.log?.error(
    { err: { name: e.name, message: e.message }, status },
    "unhandled error",
  );
  if (!res.headersSent) {
    res.status(status).json({
      status,
      error: status >= 500 ? "Internal Server Error" : (e.message ?? "Error"),
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
