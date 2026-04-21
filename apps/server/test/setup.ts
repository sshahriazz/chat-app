/**
 * Global Vitest setup. Loads a test-friendly env before any module under
 * test imports the Zod-validated `env.ts`. The values here don't need
 * to be real — they just have to satisfy the schema so the module
 * doesn't `process.exit(1)` during test collection.
 */
process.env["NODE_ENV"] = process.env["NODE_ENV"] ?? "test";
process.env["TZ"] = "UTC";
process.env["DATABASE_URL"] =
  process.env["DATABASE_URL"] ?? "postgresql://test:test@localhost:5433/test";
process.env["BETTER_AUTH_SECRET"] =
  process.env["BETTER_AUTH_SECRET"] ?? "test-secret-at-least-32-chars-long-ok";
process.env["BETTER_AUTH_URL"] =
  process.env["BETTER_AUTH_URL"] ?? "http://localhost:3001";
process.env["CENTRIFUGO_API_KEY"] =
  process.env["CENTRIFUGO_API_KEY"] ?? "test-key";
process.env["CENTRIFUGO_TOKEN_SECRET"] =
  process.env["CENTRIFUGO_TOKEN_SECRET"] ?? "test-token-secret";
process.env["CENTRIFUGO_URL"] =
  process.env["CENTRIFUGO_URL"] ?? "http://localhost:8000";
process.env["REDIS_URL"] =
  process.env["REDIS_URL"] ?? "redis://localhost:6379/15";
