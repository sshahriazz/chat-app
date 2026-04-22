/**
 * Module-level JWT holder. `api.ts` attaches it as `Authorization:
 * Bearer …` on every request; `AuthContext` keeps it fresh by minting
 * a new one after each successful sign-in via `authClient.signIn`.
 *
 * Post-cutover this is the ONLY auth source: the server's requireAuth
 * middleware expects a Bearer token and the cookie session path no
 * longer exists.
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
