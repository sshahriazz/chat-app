/**
 * API client base URL.
 *
 * Defaults to empty string → same-origin. Requests go to `/api/...` and
 * Next.js rewrites (next.config.ts) proxy them to the backend at
 * `API_PROXY_URL`. Benefits: no CORS, the session cookie lives on one
 * domain, and Dokploy only needs one domain routed at the web service.
 *
 * Override via `NEXT_PUBLIC_API_BASE_URL` if you need cross-origin
 * requests (e.g. local dev without the rewrite, or a split deployment
 * where web and server live on separate domains). Value is baked into
 * the client bundle at build time.
 */
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
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
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
