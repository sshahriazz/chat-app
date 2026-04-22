/**
 * Module-level JWT holder. `api.ts` attaches it as `Authorization:
 * Bearer …` on every request; `AuthContext` keeps it fresh by minting
 * a new one after each successful better-auth sign-in.
 *
 * This is the bridge between the cookie-based UI (still here in PR 2)
 * and the JWT-federated API path (new in PR 1). In PR 3 the cookie UI
 * goes away and this holder becomes the only auth source.
 */

let token: string | null = null;
const listeners = new Set<(t: string | null) => void>();

export function setAuthToken(next: string | null): void {
  if (token === next) return;
  token = next;
  try {
    if (typeof window !== "undefined") {
      if (next) localStorage.setItem("chat_auth_jwt", next);
      else localStorage.removeItem("chat_auth_jwt");
    }
  } catch {
    // localStorage disabled (private browsing etc.) — memory is still fine.
  }
  for (const cb of listeners) cb(next);
}

export function getAuthToken(): string | null {
  if (token) return token;
  if (typeof window === "undefined") return null;
  try {
    const stored = localStorage.getItem("chat_auth_jwt");
    if (stored) token = stored;
    return token;
  } catch {
    return null;
  }
}

export function onAuthTokenChange(cb: (t: string | null) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
