// Load `.env` from the repo root, not from the server's cwd. There's one
// canonical .env per workspace; the server reads from that single file
// regardless of where `pnpm dev` is invoked from. In docker the file
// doesn't exist and compose-injected process.env wins.
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";
loadEnv({
  path: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../.env",
  ),
});
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { env, publicUrl } from "./env";
import { logger } from "./infra/logger";
import { prisma } from "./infra/prisma";
import { redis } from "./infra/redis";
import { requestId } from "./middleware/request-id";
import { preAuthIpLimiter } from "./middleware/rate-limit";
import healthRoutes from "./routes/health";
import centrifugoRoutes from "./routes/centrifugo";
import chatRoutes from "./routes/chat";
import userRoutes from "./routes/users";
import attachmentRoutes from "./routes/attachments";
import pushRoutes from "./routes/push";
import webhookRoutes from "./routes/webhooks";
import adminRoutes from "./routes/admin";
import devRoutes from "./routes/dev";
import { apiReference } from "@scalar/express-api-reference";
import { getPublicOpenApiDocument } from "./http/openapi";
import { httpMetrics } from "./middleware/metrics";
import { outboxDepth, outboxOldestAgeSeconds, registry as metricsRegistry } from "./infra/metrics";

const app = express();

/**
 * CORS allowlist resolution order:
 *   1. `CORS_ALLOWED_ORIGINS` env (comma-separated) — explicit override
 *   2. `publicUrl` — the app's `PUBLIC_URL`. Must be the browser's
 *      origin since everything is same-origin behind the Next.js proxy.
 *      Falling back to it means "I set the public URL, origins Just Work".
 *   3. Dev fallback
 *
 * env.ts already hard-fails at boot if CORS_ALLOWED_ORIGINS is unset
 * AND NODE_ENV=production, so in prod we always have an explicit value.
 * The fallback chain below covers the dev + mis-configured cases.
 */
const allowedOrigins: string[] = (
  env.CORS_ALLOWED_ORIGINS ??
  publicUrl ??
  "http://localhost:3000,http://192.168.0.103:3000"
)
  .split(",")
  .map((s: string) => s.trim())
  .filter(Boolean);

logger.info(
  {
    nodeEnv: env.NODE_ENV,
    publicUrl,
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
// Trust proxy. Prefer an explicit CIDR/IP allowlist (TRUST_PROXY_CIDRS,
// comma-separated) so X-Forwarded-* is only honored from the known
// reverse proxy — a numeric hop count (the TRUST_PROXY fallback) trusts
// "the Nth from the right" and is easy to mis-count, letting a client
// spoof X-Forwarded-For (→ rate-limit / IP-allowlist bypass). Document
// the deployed proxy CIDR in .env.example.
if (env.TRUST_PROXY_CIDRS) {
  const cidrs = env.TRUST_PROXY_CIDRS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  app.set("trust proxy", cidrs);
} else {
  app.set("trust proxy", env.TRUST_PROXY);
}

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
        // Log the path only — strip the query string so search terms
        // (`?q=...`), cursors, and any other potentially sensitive
        // query params never land in logs.
        url: typeof req.url === "string" ? req.url.split("?")[0] : req.url,
      }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
  }),
);

// --- Security middleware ----------------------------------------------------

app.use(
  helmet({
    // The Next.js app loads our API from a different origin; allow the
    // relevant CORP default but keep the rest of helmet's hardening.
    crossOriginResourcePolicy: { policy: "cross-origin" },
    // 2-year HSTS + preload eligibility. The stack always terminates TLS
    // at the edge proxy in prod.
    strictTransportSecurity: {
      maxAge: 63072000,
      includeSubDomains: true,
      preload: true,
    },
    // Pure JSON API: nothing should ever be loaded from a server
    // response. `default-src 'none'` is the tightest sane policy; the
    // /docs route overrides this with a Scalar-specific policy below.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        "default-src": ["'none'"],
        "frame-ancestors": ["'none'"],
        "base-uri": ["'none'"],
        "form-action": ["'none'"],
      },
    },
  }),
);

// Permissions-Policy: deny powerful features the API/docs never use.
// helmet doesn't set this header, so add it explicitly.
app.use((_req, res, next) => {
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  );
  next();
});

app.use(
  cors({
    origin: allowedOrigins,
    // No cookies are used (bearer-token auth only), so credentialed CORS
    // is unnecessary. Dropping it avoids the footgun where a future
    // cookie + a permissive origin would expose authenticated requests.
    credentials: false,
  }),
);

// Health probes before auth + body parsing — they must be dependency-cheap
// and bypass every middleware that could 401 or fail. Also mounted under
// `/api` so deploys that expose the server under a path prefix (e.g.
// Traefik rewriting `/chat-api/*` → `/api/*`) can reach the probes too.
app.use(healthRoutes);
app.use("/api", healthRoutes);

// Prometheus scrape target. When METRICS_TOKEN is set, require it as a
// bearer — the registry leaks per-tenant outbox depth / per-route
// latencies that are useful recon. When unset, the endpoint is open and
// MUST be firewalled to an internal network (documented in .env.example).
app.get("/metrics", async (req, res) => {
  if (env.METRICS_TOKEN) {
    const header = req.headers.authorization;
    const match =
      typeof header === "string" ? header.match(/^Bearer\s+(.+)$/) : null;
    const provided = match ? match[1] : "";
    const a = crypto.createHash("sha256").update(provided).digest();
    const b = crypto.createHash("sha256").update(env.METRICS_TOKEN).digest();
    if (!crypto.timingSafeEqual(a, b)) {
      res.status(404).end(); // opaque: don't advertise the endpoint
      return;
    }
  }
  res.set("Content-Type", metricsRegistry.contentType);
  res.end(await metricsRegistry.metrics());
});

// --- API documentation ------------------------------------------------------
//
// Zod schemas → OpenAPI 3.1 document → Scalar UI. Registered before auth so
// the docs are reachable without a session. Kept unauthenticated on purpose:
// the server's HTTP surface is not a secret and having the docs 401 breaks
// the ergonomic case of cURLing a route by clicking "Try it".
const openapiHandler = (_req: express.Request, res: express.Response) => {
  // Public doc: admin/dev routes are stripped so an unauthenticated
  // visitor can't enumerate operator-only endpoints + their shapes.
  res.json(getPublicOpenApiDocument());
};
app.get("/openapi.json", openapiHandler);
app.get("/api/openapi.json", openapiHandler);

// Scalar's shell pulls its bundle from jsdelivr, uses eval internally,
// and (by default) talks to api.scalar.com. Rather than removing CSP
// entirely (which would let ANY origin's script run if the page were
// ever injected), apply a TIGHT policy that whitelists exactly the
// Scalar CDN + registry. Every real API route keeps `default-src
// 'none'` from the global helmet config.
const docsCsp =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net; " +
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
  "img-src 'self' data: https://cdn.jsdelivr.net; " +
  "font-src 'self' data: https://cdn.jsdelivr.net; " +
  "connect-src 'self' https://cdn.jsdelivr.net https://api.scalar.com; " +
  "worker-src 'self' blob:; " +
  "frame-ancestors 'none'; base-uri 'self'";
const stripCsp: express.RequestHandler = (_req, res, next) => {
  // Replace the global `default-src 'none'` with the Scalar-scoped
  // policy for the docs renderer only.
  res.setHeader("Content-Security-Policy", docsCsp);
  next();
};
// Relative `./openapi.json` resolves from whichever mount the browser
// landed on (`/docs` → `/openapi.json`, `/api/docs` → `/api/openapi.json`),
// so path-prefix deploys like Traefik's `/chat-api/*` → `/api/*` rewrite
// keep working without baking the external prefix into the server.
const docsHandler = apiReference({ url: "./openapi.json", theme: "default" });
app.use("/docs", stripCsp, docsHandler);
app.use("/api/docs", stripCsp, docsHandler);

// Authentication: Tenants present a user JWT as `Authorization: Bearer`;
// `requireAuth` in middleware/auth.ts verifies it + upserts the local
// User row. Server-to-server ops (webhooks, admin) use a tenant API key
// instead — also Bearer-style.

// --- Route tree -------------------------------------------------------------
//
// Body-size limits are tuned per route-tree rather than a single global
// cap. A tight limit on low-churn endpoints (push subs, tokens, user
// search) costs nothing and shrinks the DoS surface if the app-level
// rate limiter ever fails open. Only the chat catch-all gets a 512 KB
// ceiling because rich Tiptap JSON for a long message can legitimately
// serialize above the global default.
// `preAuthIpLimiter` (60 req/min/IP) runs BEFORE any router whose
// first gate is an expensive crypto verify — Argon2 for tenant API
// keys, HMAC + AES-GCM unwrap for JWTs, SHA-256 master-key compare.
// Without this, an attacker can spray random bearer tokens and force
// the server to run those verifies on every request, pegging CPU
// regardless of credential validity. The cap is generous for legit
// callers (webhooks are tenant-backend → us, not user-driven).
app.use("/api/centrifugo", preAuthIpLimiter, express.json({ limit: "4kb" }), centrifugoRoutes);
app.use("/api/users", express.json({ limit: "32kb" }), userRoutes);
app.use("/api/attachments", express.json({ limit: "8kb" }), attachmentRoutes);
app.use("/api/push", express.json({ limit: "4kb" }), pushRoutes);
// Tenancy: webhooks (tenant backends → us) + admin (operator → us).
// Webhooks get a body parser that stashes the raw bytes on `req.rawBody`
// so `requireWebhookSignature` (inside the router) can HMAC the
// unmodified payload with the tenant's apiKey.
app.use(
  "/api/webhooks",
  preAuthIpLimiter,
  express.json({
    limit: "8kb",
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: Buffer }).rawBody = buf;
    },
  }),
  webhookRoutes,
);
app.use("/api/admin", preAuthIpLimiter, express.json({ limit: "4kb" }), adminRoutes);
// Dev-only mint-token endpoint. Router-level middleware returns 404
// in prod unconditionally; pre-auth limit applies in non-prod to
// keep abuse manageable on shared staging environments.
app.use("/api/dev", preAuthIpLimiter, express.json({ limit: "4kb" }), devRoutes);
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
  // Best-effort audit: warn loudly if any tenant rows still have
  // NULL apiKeyPrefix, since those widen the Argon2 cost on every
  // unauthenticated webhook probe. Fire-and-forget — failure here
  // must not block the listener.
  import("./lib/tenant")
    .then(({ auditLegacyApiKeyPrefixes }) => auditLegacyApiKeyPrefixes())
    .catch((err) =>
      logger.warn({ err: (err as Error).message }, "tenant audit failed"),
    );
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
