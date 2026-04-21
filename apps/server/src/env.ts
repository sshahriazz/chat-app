import { z } from "zod";

/**
 * Single source of truth for environment configuration.
 *
 * Validated with Zod at boot so a malformed or missing value fails loudly
 * before the server accepts any traffic. Production boot is `process.exit(1)`
 * on validation failure — we do not want silent misconfiguration.
 *
 * Non-infra integration secrets (e.g. S3_*, VAPID_*, CENTRIFUGO_*) stay in
 * this file for now because moving them demands a module registry refactor
 * we're doing separately. When that ships, those fields migrate to per-
 * module `*.config.ts` files.
 */
const EnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3001),

  // Core infra (required)
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(1),
  BETTER_AUTH_URL: z.string().url(),
  CENTRIFUGO_API_KEY: z.string().min(1),
  CENTRIFUGO_TOKEN_SECRET: z.string().min(1),
  CENTRIFUGO_URL: z.url(),

  // Observability / runtime
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .optional(),
  TRUST_PROXY: z.coerce.number().int().nonnegative().default(1),
  SHUTDOWN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15_000),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),

  // Redis — used by rate limiter + (future) outbox worker + caches
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),

  // CORS allowlist (comma separated). Falls back to dev defaults.
  CORS_ALLOWED_ORIGINS: z.string().optional(),

  // Optional — S3-compatible object storage. Attachments endpoint
  // throws a clear error if accessed without these set.
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_PUBLIC_URL_BASE: z.string().optional(),

  // Optional — Web Push (VAPID). Push endpoints 503 if missing.
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // Avoid leaking full env; print only the Zod error tree which names
  // the invalid fields without their values.
  console.error(
    "Invalid environment variables:",
    JSON.stringify(parsed.error.format(), null, 2),
  );
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";

/**
 * Production hard-fail: CORS_ALLOWED_ORIGINS must be set explicitly. The
 * dev fallback in `auth.ts` / `index.ts` hardcodes localhost origins,
 * which would silently accept cross-origin requests from any localhost-
 * served attacker tool when shipped to prod. Exiting here forces the
 * operator to set an explicit allowlist at deploy time.
 */
if (isProduction) {
  const origins = (env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (origins.length === 0) {
    console.error(
      "[env] CORS_ALLOWED_ORIGINS is required in production (comma-separated list of origins).",
    );
    process.exit(1);
  }
}

/**
 * Enforce UTC at startup. Consistent timezones keep logs + DB timestamps
 * + cron schedules predictable across deploys. In prod we hard-fail;
 * in dev we just warn so a developer can keep working.
 */
{
  const requestedTz = process.env["TZ"];
  const resolvedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (requestedTz !== "UTC" || resolvedTz !== "UTC") {
    if (isProduction) {
      console.error(
        `[env] process must run with TZ=UTC (requested=${requestedTz ?? "unset"}, resolved=${resolvedTz}).`,
      );
      process.exit(1);
    } else {
      console.warn(
        `[env] process timezone is not UTC (resolved=${resolvedTz}). Run with TZ=UTC for parity with production.`,
      );
    }
  }
}
