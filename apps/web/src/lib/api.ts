/**
 * API client base URL.
 *
 * Production (Traefik-direct): leave empty. Requests go to `/api/...`
 * relative to the page origin (e.g. `chat.technext.it/api/...`).
 * Traefik on the Dokploy host routes that path to the `server`
 * container directly — the `web` container is not in the request
 * path. Same-origin means no CORS preflights.
 *
 * Local dev: set to `http://localhost:3001` (passed as a build arg
 * by `compose.dev.yml`). The browser at `localhost:3000` calls
 * `localhost:3001/api/...` cross-origin; the server's CORS middleware
 * allows it via the dev origin in `CORS_ALLOWED_ORIGINS`.
 *
 * Value is baked into the client bundle at `next build` time.
 */
import { getAuthToken } from "./auth-token";

const BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

export const API_BASE_URL = BASE_URL;

interface RequestOpts {
  signal?: AbortSignal;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: RequestOpts = {},
): Promise<T> {
  const token = getAuthToken();
  const headers: Record<string, string> = {};
  if (body) headers["Content-Type"] = "application/json";
  // Bearer header is the JWT path; server middleware dispatches to
  // requireUserJwt when present. credentials:include keeps the legacy
  // cookie-session path working in parallel during the dual-auth
  // window (AUTH_MODE=both, default) — dropped in PR 3.
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "include",
    signal: opts.signal,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }

  return res.json();
}

export const api = {
  get: <T>(path: string, opts?: RequestOpts) => request<T>("GET", path, undefined, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOpts) =>
    request<T>("POST", path, body, opts),
  put: <T>(path: string, body?: unknown, opts?: RequestOpts) =>
    request<T>("PUT", path, body, opts),
  delete: <T>(path: string, opts?: RequestOpts) =>
    request<T>("DELETE", path, undefined, opts),
};
