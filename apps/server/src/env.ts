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
  // Public base URL of the deployed app (used for OpenAPI server
  // listing + absolute-URL links). Previously named BETTER_AUTH_URL;
  // kept under that name for backwards-compat with existing deploys
  // via an alias below.
  PUBLIC_URL: z.string().url().optional(),
  BETTER_AUTH_URL: z.string().url().optional(),
  CENTRIFUGO_API_KEY: z.string().min(1),
  CENTRIFUGO_TOKEN_SECRET: z.string().min(1),
  CENTRIFUGO_URL: z.url(),

  // Observability / runtime
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .optional(),
  TRUST_PROXY: z.coerce.number().int().nonnegative().default(1),

  // Tenancy (PR 1 onward).
  //
  // MASTER_API_KEY gates `POST /api/admin/tenants` and the key/secret
  // rotation endpoints. In production this MUST be set; the optional()
  // below is only for dev / tests where admin endpoints aren't mounted.
  MASTER_API_KEY: z.string().min(32).optional(),
  // Optional comma-separated allowlist for `/api/admin/*` sources.
  // Each entry is an IPv4/IPv6 address. Requests from outside this
  // list are rejected with 403 regardless of master-key validity.
  // Leave unset to allow any source (master-key is the only gate).
  ADMIN_IP_ALLOWLIST: z.string().optional(),
  // Optional base64-encoded 32-byte key. When set, Tenant.jwtSecret
  // is AES-256-GCM wrapped at rest. The server still needs plaintext
  // in memory to verify HMAC JWTs — this is a DB-leak defense only.
  JWT_SECRET_ENCRYPTION_KEY: z.string().optional(),
  // When "true", every `POST /api/webhooks/*` request must carry a
  // valid `X-Chat-Signature` header (HMAC-SHA256 of the raw request
  // body signed with the tenant's apiKey). Off by default; opt in
  // once your tenants have shipped the signer.
  WEBHOOK_SIGNATURE_REQUIRED: z.coerce.boolean().default(false),
  // Auth dispatch mode. `both` accepts either the legacy cookie
  // session or a tenant-issued Bearer JWT (preferred during the
  // dual-auth cutover window). `jwt` rejects cookie requests outright
  // — set this once PR 3 lands and you're ready for the cutover.
  // `session` is a rollback path that forces legacy-only.
  // PR 3 onwards the server only accepts JWT — `session`/`both` are
  // kept in the enum as explicit rollback escape hatches (set the env
  // var to re-enable the cookie path temporarily). The dispatcher in
  // middleware/auth.ts is now just the JWT path; if you flip this,
  // you'll also need to revert the middleware.
  AUTH_MODE: z.enum(["both", "session", "jwt"]).default("jwt"),
  // Dev-only: opt-in switch that mounts `POST /api/dev/mint-token`
  // outside non-production. Stays false in prod unless explicitly
  // enabled (e.g. staging envs where you want to e2e-test end-to-end).
  DEV_MINT_ENABLED: z.coerce.boolean().default(false),
  // When dev mint is enabled in production, ONLY these tenant ids can
  // be minted for. Comma-separated. Prevents a leaked flag from
  // becoming a tenant-impersonation backdoor.
  ALLOW_DEV_MINT_TENANTS: z.string().optional(),
  // Seconds of clock skew tolerated when verifying tenant-signed user
  // JWTs. Defaults to a conservative 30s; raise if tenants run on
  // systems with unsynced clocks.
  TENANT_JWT_CLOCK_SKEW_SEC: z.coerce.number().int().nonnegative().default(30),
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
 * Resolved public base URL. Prefers `PUBLIC_URL`, falls back to
 * `BETTER_AUTH_URL` for deploys that haven't renamed their env var yet.
 */
export const publicUrl: string | undefined =
  env.PUBLIC_URL ?? env.BETTER_AUTH_URL;

if (isProduction && !publicUrl) {
  console.error(
    "[env] PUBLIC_URL (or BETTER_AUTH_URL) is required in production.",
  );
  process.exit(1);
}

/**
 * Production hard-fail on known dev-only secrets. Compose ships with
 * placeholder defaults so `docker compose up` works out of the box in
 * development; shipping those to production silently would be a major
 * finding in any security review. Enumerate the exact dev values below
 * and refuse to boot if any of them leak into a prod deploy.
 */
if (isProduction) {
  const DEV_SECRETS: Array<{ key: string; value: string | undefined; bad: string }> = [
    {
      key: "CENTRIFUGO_TOKEN_SECRET",
      value: env.CENTRIFUGO_TOKEN_SECRET,
      bad: "dev-secret-change-in-production",
    },
    {
      key: "CENTRIFUGO_API_KEY",
      value: env.CENTRIFUGO_API_KEY,
      bad: "dev-api-key",
    },
    {
      key: "S3_SECRET_ACCESS_KEY",
      value: env.S3_SECRET_ACCESS_KEY,
      bad: "chatapp-dev-only",
    },
  ];
  const tripped = DEV_SECRETS.filter((s) => s.value === s.bad);
  if (tripped.length > 0) {
    console.error(
      "[env] refusing to boot: the following env vars are set to their dev-default values:",
      tripped.map((t) => t.key).join(", "),
    );
    process.exit(1);
  }
  const dbUrl = env.DATABASE_URL;
  // Only fail on the EXACT dev-default `chatapp:chatapp` pair — using
  // `chatapp` as the username with a strong rotated password is fine,
  // and penalising that combination just makes production redeploys
  // painful when the PG volume was initialised with the legacy user.
  if (/\/\/chatapp:chatapp@/.test(dbUrl)) {
    console.error(
      "[env] refusing to boot: DATABASE_URL is using the dev-default `chatapp:chatapp` credentials. Rotate POSTGRES_PASSWORD.",
    );
    process.exit(1);
  }
}

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
