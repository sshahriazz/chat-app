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

// `'unsafe-eval'` is required by React ONLY in development (eval-based
// debugging / error reconstruction); never in a production build.
const isDev = process.env.NODE_ENV !== "production";

// Content-Security-Policy for the browser-facing app. This is a
// config-level (static) policy, so it can't use per-request nonces —
// script/style therefore need 'unsafe-inline' for Next's hydration
// (external script injection is still blocked: no host is allowed in
// script-src). The high-value directives are strict:
//   - frame-ancestors 'none'  → clickjacking defense
//   - object-src 'none'       → no plugins/embeds
//   - base-uri / form-action 'self'
// connect-src / img-src stay broad (https:/wss:/ws:) so the policy is
// deploy-agnostic — same-origin (Traefik) AND cross-origin (dev: API on
// :3001, Centrifugo ws on :8000, MinIO on :9000) both work without
// per-environment tuning. Tighten these to explicit origins if desired.
const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "object-src 'none'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  // `http:` is included so the cross-origin dev stack (API :3001,
  // Centrifugo ws :8000, MinIO :9000, all http) works; on a prod HTTPS
  // page the browser's mixed-content rules block http: anyway, so this
  // effectively means https/wss-only in prod. Tighten to explicit
  // origins per-deploy if you want stricter exfil control.
  "img-src 'self' data: blob: http: https:",
  "font-src 'self' data:",
  "connect-src 'self' http: https: ws: wss:",
  "worker-src 'self' blob:",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  // 2-year HSTS + preload, matching the API. Ignored by browsers over
  // plain http (dev), enforced once served over TLS (prod edge).
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Belt-and-suspenders with CSP frame-ancestors for older browsers.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  },
];

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "..", ".."),
  allowedDevOrigins: ["192.168.0.101"],
  // Drop the `X-Powered-By: Next.js` version/tech-stack disclosure.
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
