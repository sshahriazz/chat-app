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

/**
 * Error thrown for any non-2xx HTTP response. Carries the status code +
 * the parsed error payload so callers can branch on it (e.g. 410 → "your
 * account was deleted, take the user to a sign-out screen"; 409 → "this
 * push endpoint is registered to another user"). Previous behavior
 * collapsed everything into `new Error(message)` and lost the status.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
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
  // Bearer-only: every authenticated request carries `Authorization:
  // Bearer <jwt>`. There are no cookies — `credentials: "include"` was
  // dropped because the server now sends `Access-Control-Allow-
  // Credentials: false` and including credentials with a non-credentialed
  // CORS allowlist throws a browser error.
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: opts.signal,
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({ error: res.statusText }));
    const msg =
      (typeof errBody === "object" &&
        errBody &&
        typeof (errBody as { error?: unknown }).error === "string"
        ? (errBody as { error: string }).error
        : res.statusText) || res.statusText;
    throw new ApiError(res.status, msg, errBody);
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
