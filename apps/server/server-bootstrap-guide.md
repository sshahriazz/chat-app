# Server Bootstrap Guide

A Claude Code instruction set to scaffold a new TypeScript backend that mirrors the eb-auth patterns: OpenAPI docs, Zod validation, Better Auth security, and pino telemetry.

**How to use**: Save this file in the new project root (or feed it to Claude Code as a prompt). Claude Code will create the full scaffold by following this guide.

---

## Prompt to give Claude Code

> "Bootstrap a new TypeScript backend using the patterns in `docs/server-bootstrap-guide.md`. Set up the toolchain, install dependencies, create the directory structure, and scaffold example modules following every convention in that file. After setup, run `pnpm typecheck && pnpm lint && pnpm test && pnpm build` and confirm all four pass."

---

## 1. Toolchain (non-negotiable)

| Concern | Tool | Version |
|---------|------|---------|
| Runtime | Node | 24+ |
| Package manager | pnpm | 10+ |
| Language | TypeScript | 5.7+ |
| Module system | ESM only | — |
| Dev runner | tsx | `tsx watch --clear-screen=false src/http/server.ts` |
| Prod bundler | tsdown (Rolldown) | `tsdown src/http/server.ts --format esm --target node24 --sourcemap` |
| Type checker | tsc | `tsc --noEmit` |
| Test runner | Vitest | NOT Jest — ESM support |
| Linter | ESLint 10 | flat config (`eslint.config.js`) |
| Formatter | Prettier 3 | — |
| Git hooks | husky + lint-staged | auto-fix on commit |
| ORM | Prisma 7 | `prisma-client` provider (no Rust engine) |
| Auto Zod | prisma-zod-generator | derive Zod schemas from Prisma |
| DB adapter | @prisma/adapter-pg | native Postgres driver |
| HTTP framework | Express 5 | — |
| Validation | Zod 4 | — |
| OpenAPI | zod-openapi + Scalar | — |
| Auth | Better Auth 1.6 | — |
| Cache/rate limit | ioredis + redis-rate-limit | — |
| Logging | pino + pino-http + pino-pretty (dev) | structured JSON in prod |

### tsconfig.json requirements

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noPropertyAccessFromIndexSignature": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true
  }
}
```

- Imports MUST have no `.js` extension
- Use bracket access for index signatures (`process.env["FOO"]`, not `.FOO`)

---

## 2. Directory Structure

```
src/
├── config/
│   └── env.ts                 # Zod-validated env, single source
├── infra/
│   ├── prisma.ts              # Prisma singleton with adapter-pg
│   ├── redis.ts               # ioredis singleton with logging
│   ├── logger.ts              # pino + getLogger() request-scoped
│   └── request-context.ts     # AsyncLocalStorage for reqId/userId
├── middleware/
│   ├── auth-guard.ts          # Better Auth session check
│   ├── validate.ts            # Zod validation → req.validated
│   ├── async-handler.ts       # async error forwarding
│   ├── rate-limit.ts          # Redis-backed
│   ├── cors.ts                # allowlist from env
│   ├── request-id.ts          # X-Request-Id injection
│   └── error-handler.ts       # ONLY place that writes error responses
├── errors/
│   ├── app-error.ts           # AppError + factories (notFound, conflict, etc.)
│   └── domain.ts              # DomainError base + per-module errors
├── http/
│   ├── app.ts                 # createApp() — testable, no listen()
│   ├── server.ts              # bootstrap + graceful shutdown
│   ├── openapi.ts             # merges per-module paths
│   └── openapi-shared.ts      # ERROR_CODES, errorResponseSchema, paginatedResponse
├── modules/
│   ├── index.ts               # AppModule interface + registry array
│   ├── auth/                  # Better Auth catch-all (rawBody: true)
│   ├── health/                # /livez, /readyz (bypassRateLimit: true)
│   └── <feature>/             # Feature modules (see section 5)
└── generated/                 # .gitignored — Prisma client + auto Zod
```

---

## 3. Central env config (`src/config/env.ts`)

One file. Zod-validated. Exit process if invalid. Enforce UTC timezone.

```ts
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  CORS_ORIGIN: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  REDIS_URL: z.string().min(1),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).optional(),
  TRUST_PROXY: z.coerce.number().int().nonnegative().default(1),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  OUTBOUND_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment variables:", z.treeifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";

// Enforce UTC at startup — CRITICAL for consistent timestamps
{
  const requestedTz = process.env["TZ"];
  const resolvedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (requestedTz !== "UTC" || resolvedTz !== "UTC") {
    if (isProduction) process.exit(1);
    else console.warn(`Process timezone is not UTC (resolved: ${resolvedTz}). Run with TZ=UTC.`);
  }
}
```

**Rule**: Every module that needs env vars that are NOT core (API keys for external services) gets its own `<m>.config.ts` with local Zod validation. NEVER add integration env vars to central env.

---

## 4. Logging & Telemetry (`src/infra/logger.ts`)

pino with:
- Request ID + user ID correlation via AsyncLocalStorage
- Secret redaction (`authorization`, `cookie`, `password`, `token`, `secret`)
- pino-pretty in dev, JSON in prod
- pino-http for automatic request logging

```ts
import pino, { type Logger } from "pino";
import { env, isProduction } from "../config/env";
import { getRequestContext } from "./request-context";

export const logger: Logger = pino({
  level: env.LOG_LEVEL ?? (isProduction ? "info" : "debug"),
  base: { service: "your-service-name", env: env.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: ["req.headers.authorization", "req.headers.cookie", "*.password", "*.token", "*.secret"],
    remove: true,
  },
  ...(isProduction
    ? { transport: { target: "pino/file", options: { destination: 1 } } }
    : { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss.l" } } }),
});

/** Request-scoped logger with reqId + userId. ALWAYS use this, never bare `logger`. */
export function getLogger(): Logger {
  const ctx = getRequestContext();
  if (!ctx) return logger;
  return logger.child({ reqId: ctx.requestId, ...(ctx.userId ? { userId: ctx.userId } : {}) });
}
```

**`src/infra/request-context.ts`**:
```ts
import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  requestId: string;
  userId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function setUserId(userId: string): void {
  const store = storage.getStore();
  if (store) store.userId = userId;
}
```

**Rules**:
- NEVER `console.log` — ESLint should forbid it
- ALWAYS `getLogger()` not bare `logger` (so requests auto-correlate)
- Bridge Prisma logs into pino (see prisma singleton below)
- Bridge Redis connection events into pino

---

## 5. Module Pattern

Two module types, both follow the same shape.

### Feature module (owns DB tables)

```
src/modules/<feature>/
├── index.ts                   # Public barrel — exports router + openapi ONLY
├── <feature>.schema.ts        # Zod input validation (derived from generated models)
├── <feature>.dto.ts           # Response DTOs + mapper functions
├── <feature>.service.ts       # Business logic — throws DomainError
├── <feature>.repository.ts    # Thin Prisma wrapper
├── <feature>.controller.ts    # req → service → res adapters
├── <feature>.routes.ts        # Express router + middleware chain
└── <feature>.openapi.ts       # OpenAPI paths + response schemas
```

### Integration module (external API wrapper, fully detachable)

```
src/modules/<integration>/
├── index.ts                   # create<I>Module(): AppModule | null
├── <i>.config.ts              # module-local env Zod schema
├── <i>.client.ts              # HTTP client
├── <i>.errors.ts              # DomainError subclasses + mapDomainError()
├── <i>.cache.ts               # Redis cache (silent failures)
├── <i>.routes.ts              # Express router
└── <i>.openapi.ts             # OpenAPI paths
```

**The core contract** — integration modules are detachable:
1. `rm -rf src/modules/<integration>`
2. Remove 3 lines from `src/modules/index.ts` (import + call + push)
3. Zero edits to `env.ts`, `error-handler.ts`, `app.ts`, `auth.ts`

### Module registry (`src/modules/index.ts`)

```ts
export interface AppModule {
  mountPath: string;
  router: Router;
  openapi?: ZodOpenApiPathsObject;
  rawBody?: boolean;              // Skip body parser (for webhooks, auth catch-all)
  bypassRateLimit?: boolean;      // For k8s health probes
  mapDomainError?: (err: DomainError) => AppError | undefined;
}

export const modules: AppModule[] = [
  { mountPath: "/", router: healthRouter, bypassRateLimit: true },
  { mountPath: "/api/auth", router: authRouter, rawBody: true },
  // ...feature modules
];

// Optional integration modules — each returns null if disabled
const optionalModules: AppModule[] = [];
const stripe = createStripeModule();
if (stripe) optionalModules.push(stripe);
modules.push(...optionalModules);
```

---

## 6. Data Validation

### Single source of truth: `prisma/schema.prisma`

Every Zod schema for DB-shaped data is built from `ModelModelSchema` (auto-generated) via `.pick()` + `.extend()`. **NEVER hand-write `z.object({ id, ... })` for a DB table.**

```ts
// ✅ Correct
import { DeviceModelSchema } from "../../generated/zod/schemas/variants/pure";

export const createDeviceSchema = DeviceModelSchema.pick({
  deviceId: true,
  rfid: true,
}).extend({
  deviceId: z.string().trim().min(1).max(100),
  rfid: z.string().trim().min(1),
});
```

### `validate()` middleware + `ValidatedRequest` generic

Every endpoint goes through `validate({ body?, query?, params? })`. Handlers read `req.validated.body` (etc.).

```ts
// src/middleware/validate.ts
export interface ValidatedRequest<Body = unknown, Query = unknown, Params = unknown> extends Request {
  validated: { body: Body; query: Query; params: Params };
}

export function validate(schemas: { body?: ZodType; query?: ZodType; params?: ZodType }): RequestHandler {
  return (req, _res, next) => {
    const result: { body?: unknown; query?: unknown; params?: unknown } = {};
    if (schemas.body) {
      const parsed = schemas.body.safeParse(req.body);
      if (!parsed.success) return next(validationError(parsed.error));
      result.body = parsed.data;
    }
    // ... same for query, params
    (req as ValidatedRequest).validated = result as never;
    next();
  };
}
```

**Rule**: NEVER `schema.parse(req.body)` inside a controller — that's what the middleware prevents.

### Typed responses

Every controller types `Response<T>` where `T` comes from the OpenAPI schema. This gives compile-time safety between spec and wire.

```ts
create: async (req: Request, res: Response<DeviceCreateResponse>): Promise<void> => {
  const body = (req as ValidatedRequest<CreateDeviceInput>).validated.body;
  const device = await devicesService.create(body, req.user!.id);
  res.status(201).json(toDeviceDTO(device));
},
```

---

## 7. Error Handling

**One place writes error responses**: `src/middleware/error-handler.ts`. Everywhere else THROWS.

### Three layers

1. **Services throw `DomainError`** (no HTTP semantics)
2. **Per-module `mapDomainError()`** converts to `AppError` (HTTP-shaped)
3. **Central error handler** catches `AppError`, writes JSON response

```ts
// src/errors/domain.ts — base
export abstract class DomainError extends Error {
  abstract readonly kind: string;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// per-module
export class DeviceNotFoundError extends DomainError {
  readonly kind = "DeviceNotFoundError" as const;
  constructor(public readonly id: string) { super(`Device ${id} not found.`); }
}
```

### Error response shape

```ts
// src/http/openapi-shared.ts
export const ERROR_CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  BAD_REQUEST: "BAD_REQUEST",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
} as const;

export const errorResponseSchema = z.object({
  status: z.number().int(),
  code: z.enum(Object.values(ERROR_CODES) as [string, ...string[]]),
  message: z.string(),
  requestId: z.string().optional(),
  details: z.array(fieldErrorSchema).optional(),
}).meta({ id: "ErrorResponse" });
```

**Rules**:
- Inside any middleware/handler → `next(notFound("..."))`, never `res.status(404).json(...)`
- Inside services → `throw new SomeDomainError(...)`, never `throw new AppError(...)`
- New error codes → add to `ERROR_CODES`, then factory in `app-error.ts`

---

## 8. OpenAPI Documentation

### Per-module paths, merged globally

```ts
// src/modules/devices/devices.openapi.ts
export const devicesPaths: ZodOpenApiPathsObject = {
  "/api/devices": {
    post: {
      tags: ["devices"],
      summary: "Register a new device",
      security: [{ bearerAuth: [] }],
      requestBody: { content: { "application/json": { schema: createDeviceSchema } } },
      responses: {
        "201": { description: "Created", content: { "application/json": { schema: deviceDTOSchema } } },
        "400": { description: "Validation error", content: { "application/json": { schema: errorResponseSchema } } },
      },
    },
  },
};
```

### Global doc builder

```ts
// src/http/openapi.ts
import { createDocument } from "zod-openapi";
import { modules } from "../modules";

export function buildOpenApiDocument() {
  const paths = modules.reduce((acc, m) => ({ ...acc, ...(m.openapi ?? {}) }), {});
  return createDocument({
    openapi: "3.1.0",
    info: { title: "API", version: "1.0.0" },
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    },
  });
}
```

### Scalar UI mount

```ts
// in src/http/app.ts
import { apiReference } from "@scalar/express-api-reference";

app.get("/openapi.json", (_, res) => res.json(buildOpenApiDocument()));
app.use("/docs", apiReference({ url: "/openapi.json" }));
```

---

## 9. Security

### Auth: Better Auth with session cookies

- Mount at `/api/auth` with `rawBody: true` (Better Auth reads raw stream)
- `authGuard` middleware reads session from cookie + sets `req.user`
- Session cookie is `better-auth.session_token`

### Rate limiting (Redis-backed)

```ts
// src/middleware/rate-limit.ts
export const globalRateLimit = rateLimit({
  store: new RedisStore({ sendCommand: (...args) => redis.call(...args) }),
  windowMs: 60_000,
  limit: 100,
});
```

Apply globally in `app.ts` but skip modules with `bypassRateLimit: true`.

### CORS allowlist from env

Never use `origin: "*"` in prod. Comma-separated list in `CORS_ORIGIN`.

### Additional hardening

```ts
app.disable("x-powered-by");                    // Don't leak framework
app.set("trust proxy", env.TRUST_PROXY);        // Behind LB
app.use(helmet());                              // Security headers
app.use(express.json({ limit: "1mb" }));        // Body size cap
```

### Credentials never in responses

Integration modules (e.g. EPC, Octopus) inject credentials **server-side** via HTTP Basic/Bearer. Flutter/web clients never see the external service's auth.

---

## 10. Infrastructure singletons

### Prisma (`src/infra/prisma.ts`)

```ts
const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient };

function createPrismaClient(): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: env.DATABASE_URL,
    max: env.DB_POOL_MAX,
  });
  const client = new PrismaClient({
    adapter,
    log: isProduction
      ? [{ emit: "event", level: "error" }]
      : [{ emit: "event", level: "error" }, { emit: "event", level: "warn" }, { emit: "event", level: "query" }],
  });
  client.$on("error" as never, (e: LogEvent) => {
    logger.error({ target: e.target, msg: e.message }, "[prisma] error");
  });
  return client;
}

export const prisma: PrismaClient = globalForPrisma.__prisma ?? createPrismaClient();
if (!isProduction) globalForPrisma.__prisma = prisma;
```

### Redis (`src/infra/redis.ts`)

```ts
const client = new Redis(env.REDIS_URL, {
  lazyConnect: false,
  maxRetriesPerRequest: 3,
  reconnectOnError: (err) => err.message.includes("READONLY"),
  connectTimeout: 5_000,
  connectionName: "your-service",
  retryStrategy: (times) => Math.min(times * 200, 5_000),
});
client.on("error", (err) => logger.error({ err }, "[redis] connection error"));
client.on("ready", () => logger.info("[redis] ready"));
```

---

## 11. Health Checks

Two endpoints, both bypass rate limiting:

- `GET /livez` — dependency-free, returns 200 if process is up
- `GET /readyz` — checks Postgres + Redis, returns 503 if any dep is down

```ts
// src/modules/health/health.routes.ts
router.get("/livez", (_, res) => res.json({ status: "ok" }));

router.get("/readyz", async (_, res) => {
  try {
    await Promise.all([prisma.$queryRaw`SELECT 1`, redis.ping()]);
    res.json({ status: "ok", db: "ok", redis: "ok" });
  } catch (err) {
    res.status(503).json({ status: "degraded", error: String(err) });
  }
});
```

---

## 12. Docker / Production

### Multi-stage Dockerfile

```dockerfile
# Stage 1: Install all deps
FROM node:24-alpine AS deps
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml prisma ./
RUN pnpm install --frozen-lockfile --prod=false

# Stage 2: Build
FROM deps AS build
COPY tsconfig.json tsdown.config.ts ./
COPY src ./src
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
RUN pnpm prisma generate && pnpm run build

# Stage 3: Runtime
FROM node:24-alpine AS runtime
RUN corepack enable && corepack prepare pnpm@10 --activate
RUN apk add --no-cache wget
WORKDIR /app
COPY package.json pnpm-lock.yaml prisma ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/generated ./src/generated
ENV NODE_ENV=production TZ=UTC NODE_OPTIONS=--enable-source-maps
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -q --spider http://localhost:3000/livez || exit 1
# CRITICAL: run migrations before starting server
CMD ["sh", "-c", "pnpm prisma migrate deploy && node dist/server.mjs"]
```

### Graceful shutdown

```ts
// src/http/server.ts
const server = app.listen(env.PORT, () => logger.info({ port: env.PORT }, "Server listening"));

async function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down...");
  server.close();
  await Promise.all([prisma.$disconnect(), redis.quit()]);
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
setTimeout(() => process.exit(1), env.SHUTDOWN_TIMEOUT_MS).unref();
```

### If deploying to Dokploy/Railway: use Docker/Dockerfile build type, NOT Railpack/Nixpacks — Railpack ignores the Dockerfile's CMD and skips migrations.

---

## 13. CLAUDE.md Template

Once the scaffold is up, drop a CLAUDE.md at the project root with these rules:

```markdown
# Instructions for Claude

## Hard rules
1. Single source of truth for DB shapes: prisma/schema.prisma → generated Zod
2. Errors are THROWN, never written (only error-handler.ts writes)
3. Module boundaries enforced via barrels — no deep imports
4. Every endpoint goes through validate()
5. Every controller types Response<T>
6. No .js extensions on imports (Bundler resolution)
7. Bracket access for index signatures (req.params["id"], not .id)
8. Use getLogger(), not bare logger (for request correlation)
9. Comments explain WHY, not WHAT
10. Don't add async if the function doesn't await

## Don't
- Replace Vitest with Jest (ESM rules out Jest)
- Hand-write z.object({}) for a DB shape
- Add error codes inline as strings
- Edit src/generated/ (auto-generated)
- Use `any` — define narrow interface and cast through it
- res.status(...).json(...) for errors
- throw new AppError from a service
- Add integration env vars to src/config/env.ts
- Edit error-handler.ts when adding an integration

## Verify before "done"
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

---

## 14. Minimal starter prompt

Paste this to Claude Code in the target project directory:

```
Set up a new TypeScript backend following the bootstrap guide in
docs/server-bootstrap-guide.md. Specifically:

1. Initialize package.json with pnpm, Node 24 engine, type:"module"
2. Install all dependencies listed in section 1
3. Create tsconfig.json with the strict options from section 1
4. Create the directory structure from section 2
5. Implement the central env config (section 3)
6. Implement logger + request context (section 4)
7. Create the module registry pattern (section 5)
8. Implement validate() middleware + ValidatedRequest (section 6)
9. Implement the 3-layer error system (section 7)
10. Set up OpenAPI + Scalar (section 8)
11. Implement Better Auth + authGuard + rate limiting (section 9)
12. Create Prisma + Redis singletons (section 10)
13. Add /livez + /readyz health endpoints (section 11)
14. Create the Dockerfile + graceful shutdown (section 12)
15. Drop CLAUDE.md at the project root (section 13)

Then scaffold ONE example feature module (e.g. "items" with CRUD) and
ONE example integration module (e.g. "weather" calling a public API)
that demonstrate both patterns end-to-end.

Verify with: pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

---

## 15. What you get

After Claude Code runs through this, you have:

- **Documentation**: auto-generated OpenAPI at `/openapi.json`, interactive Scalar UI at `/docs`, response schemas derived from code (no drift possible)
- **Validation**: every request validated by Zod middleware, typed `req.validated`, field-level errors in responses
- **Security**: Better Auth sessions, Redis rate limiting, CORS allowlist, secret redaction in logs, server-side credential injection for integrations
- **Telemetry**: pino structured JSON logs in prod, pretty logs in dev, request/user correlation via AsyncLocalStorage, Prisma + Redis bridged into pino
- **Type safety**: Prisma → generated Zod → module schemas → typed responses (end-to-end)
- **Detachable integrations**: delete a folder + 3 lines = module gone, no core file edits
- **Deployable**: Dockerfile with migrations in CMD, health checks, graceful shutdown, UTC-pinned timezone
