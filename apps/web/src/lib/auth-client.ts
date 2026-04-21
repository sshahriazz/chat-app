import { createAuthClient } from "better-auth/react";

/**
 * Same-origin by default — auth endpoints at `/api/auth/*` are proxied
 * through Next.js rewrites to the Express server. Browsers stay on one
 * origin (no CORS, session cookie lives on one domain, one TLS cert).
 *
 * Override with `NEXT_PUBLIC_API_BASE_URL` if you need cross-origin
 * requests (e.g. the API is on a separate subdomain).
 */
const baseURL =
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  (typeof window !== "undefined" ? window.location.origin : "");

export const authClient = createAuthClient({
  baseURL,
});
