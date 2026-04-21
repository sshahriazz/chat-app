import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  platform: "node",
  target: "node22",
  format: "esm",
  clean: true,
  sourcemap: true,
  // Keep node_modules external; bundle only our own src/ tree into dist/index.js.
  // (tsdown's default behaviour for platform:"node" already externalises deps.)
});
