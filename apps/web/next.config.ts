import type { NextConfig } from "next";
import path from "node:path";

/**
 * Web is a pure presentation container. It serves the chat UI and
 * nothing else. Backend services (`server`, `centrifugo`, `minio`)
 * are reached directly via Traefik path/host rules in Dokploy — not
 * through Next.js rewrites — so third-party integrators can hit
 * `/api`, `/connection/websocket`, and `/chatapp` without depending
 * on `web` being up or in the request path.
 *
 * - `output: "standalone"` keeps the runtime image small.
 * - `outputFileTracingRoot` is required so Next's file tracer walks
 *   out to the monorepo root and picks up hoisted deps.
 */
const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "..", ".."),
  allowedDevOrigins: ["192.168.0.101"],
};

export default nextConfig;
