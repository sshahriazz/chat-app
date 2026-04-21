import type { NextConfig } from "next";
import path from "node:path";

/**
 * Next.js' built-in `rewrites` proxy HTTP *and* WebSocket upgrades when
 * the destination is an external URL. That lets us route every browser
 * request through the web container and keep postgres/redis/server/
 * centrifugo/minio on the internal compose network with no host ports.
 *
 * Caveat: rewrites() is evaluated at `next build` time and serialized
 * into `.next/routes-manifest.json`. Destinations must therefore be
 * known at build time — they're supplied as Docker build args
 * (`API_PROXY_URL`, `WS_PROXY_URL`, `STORAGE_PROXY_URL`). Changing them
 * means rebuilding the image (Dokploy's "Deploy" does this automatically).
 *
 * - `output: "standalone"` keeps the runtime image small.
 * - `outputFileTracingRoot` is required so Next's file tracer walks
 *   out to the monorepo root and picks up hoisted deps.
 */
const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "..", ".."),
  allowedDevOrigins: ["192.168.0.101"],
  async rewrites() {
    const apiTarget = process.env.API_PROXY_URL || "http://localhost:3001";
    const wsTarget = process.env.WS_PROXY_URL || "http://localhost:8000";
    const storageTarget =
      process.env.STORAGE_PROXY_URL || "http://localhost:9000";
    const storageBucket = process.env.STORAGE_BUCKET || "chatapp";
    return [
      // Express backend
      {
        source: "/api/:path*",
        destination: `${apiTarget}/api/:path*`,
      },
      // Centrifugo WebSocket — Next proxies the upgrade automatically
      {
        source: "/connection/websocket",
        destination: `${wsTarget}/connection/websocket`,
      },
      // MinIO: browser reaches attachments at /<bucket>/<key>. Presigned
      // URLs must sign against the public host so SigV4 validates; we
      // preserve the path (no rewrite) and forward to MinIO internally.
      {
        source: `/${storageBucket}/:path*`,
        destination: `${storageTarget}/${storageBucket}/:path*`,
      },
    ];
  },
};

export default nextConfig;
