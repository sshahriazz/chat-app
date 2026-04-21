const BASE_URL =
  typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.hostname}:3001`
    : "http://localhost:3001";

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
