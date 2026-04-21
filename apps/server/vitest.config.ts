import { defineConfig } from "vitest/config";

/**
 * Vitest setup.
 *
 * - Unit tests live next to source under `src/**\/*.test.ts`.
 * - Integration tests — which need Postgres/Redis — go under `test/**`
 *   and are tagged with `// @vitest-environment node` + a custom
 *   `it.skipIf(!process.env.DATABASE_URL)` guard so CI can opt in.
 * - `globals: false` to keep imports explicit; makes refactoring safer.
 */
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    setupFiles: ["test/setup.ts"],
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/generated/**",
        "src/**/*.test.ts",
        "src/index.ts",
        "src/http/openapi.ts",
      ],
    },
  },
});
