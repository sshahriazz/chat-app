"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getAuthToken,
  setAuthToken,
  onAuthTokenChange,
} from "./auth-token";

/**
 * Minimal JWT-federation auth client. Replaces the better-auth React
 * SDK that lived here before the PR 3 cutover.
 *
 * The chat server trusts tenant-signed user JWTs and has no built-in
 * sign-in flow. The "login" the reference client exposes here is
 * purely a dev simulation of what a tenant's own backend would do in
 * production: it mints a JWT through `/api/dev/mint-token` under the
 * `default` tenant, then fetches `/api/me` to resolve the internal
 * user id. Real tenants wire up their own password flow on their own
 * backend; only the JWT + upsert contract ends at this server.
 *
 * Same-origin base URL — the Next.js server proxies `/api/*` through
 * to the Express backend, so no CORS and no explicit API host needed.
 */

const baseURL =
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  (typeof window !== "undefined" ? window.location.origin : "");

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

export interface SessionState {
  user: SessionUser;
}

interface SessionHookResult {
  data: SessionState | null;
  isPending: boolean;
}

/** Key for remembering the most recent sign-in's externalId / name so a
 *  page reload after refresh lands the user back where they were. */
const SESSION_META_KEY = "chat_session_meta";

interface SessionMeta {
  tenantId: string;
  externalId: string;
  name: string;
  email: string;
  image?: string | null;
  /** Optional second-level partition. Set by persona sign-in; the
   *  email/password form leaves this unset so those users stay
   *  tenant-wide under `default`. */
  scope?: string | null;
  /** Pretty tenant name for UI display. Not sent to the server. */
  tenantLabel?: string;
}

function readSessionMeta(): SessionMeta | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SESSION_META_KEY);
    return raw ? (JSON.parse(raw) as SessionMeta) : null;
  } catch {
    return null;
  }
}

function writeSessionMeta(meta: SessionMeta | null): void {
  if (typeof window === "undefined") return;
  try {
    if (meta) window.localStorage.setItem(SESSION_META_KEY, JSON.stringify(meta));
    else window.localStorage.removeItem(SESSION_META_KEY);
  } catch {
    /* storage unavailable */
  }
}

async function mintToken(input: {
  tenantId: string;
  externalId: string;
  name: string;
  email?: string;
  image?: string | null;
  scope?: string | null;
}): Promise<string> {
  const payload: Record<string, unknown> = {
    tenantId: input.tenantId,
    externalId: input.externalId,
    name: input.name,
    email: input.email,
    image: input.image,
  };
  // Only send `scope` when the caller explicitly supplied it — `undefined`
  // tells the server "leave existing scope alone," while an explicit
  // `null` promotes the user to tenant-wide.
  if (input.scope !== undefined) payload.scope = input.scope;
  const res = await fetch(`${baseURL}/api/dev/mint-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "Mint failed");
  }
  const { token } = (await res.json()) as { token: string };
  return token;
}

async function fetchMe(token: string): Promise<SessionUser> {
  const res = await fetch(`${baseURL}/api/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("Session lookup failed");
  const data = (await res.json()) as {
    id: string;
    name: string;
    email: string | null;
    image: string | null;
  };
  return {
    id: data.id,
    name: data.name,
    email: data.email ?? "",
    image: data.image ?? null,
  };
}

/** Open a session by upserting a tenant user + fetching /api/me. */
async function openSession(meta: SessionMeta): Promise<SessionUser> {
  const token = await mintToken({
    tenantId: meta.tenantId,
    externalId: meta.externalId,
    name: meta.name,
    email: meta.email,
    image: meta.image ?? null,
    // Only forward `scope` when the meta actually has the key — same
    // semantics as mintToken above. Re-authing on mount preserves the
    // stored scope without clobbering it.
    ...(Object.prototype.hasOwnProperty.call(meta, "scope")
      ? { scope: meta.scope }
      : {}),
  });
  setAuthToken(token);
  writeSessionMeta(meta);
  return fetchMe(token);
}

/**
 * useSession — React hook mirroring better-auth's shape so consumer
 * code (`AuthContext` etc.) doesn't need to change.
 */
function useSession(): SessionHookResult {
  const [state, setState] = useState<SessionHookResult>({
    data: null,
    isPending: true,
  });

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      const token = getAuthToken();
      const meta = readSessionMeta();
      if (!token || !meta) {
        if (!cancelled) setState({ data: null, isPending: false });
        return;
      }
      // Refresh the token + materialize user on every mount. Cheap;
      // keeps claims in sync with anything the user changed via the
      // settings page in a previous session.
      try {
        const user = await openSession(meta);
        if (!cancelled) setState({ data: { user }, isPending: false });
      } catch {
        setAuthToken(null);
        writeSessionMeta(null);
        if (!cancelled) setState({ data: null, isPending: false });
      }
    }

    void boot();

    const unsub = onAuthTokenChange((t) => {
      if (t === null) {
        // Sign-out
        setState({ data: null, isPending: false });
      }
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  return state;
}

export interface PersonaLoginInput {
  tenantId: string;
  tenantLabel: string;
  externalId: string;
  name: string;
  image?: string | null;
  scope?: string | null;
}

/** Public read of the current session metadata — used by the chat
 *  header to render the tenant + scope badge. Returns null when
 *  unauthenticated. */
export function getSessionMeta(): {
  tenantId: string;
  tenantLabel: string | null;
  externalId: string;
  scope: string | null;
} | null {
  const m = readSessionMeta();
  if (!m) return null;
  return {
    tenantId: m.tenantId,
    tenantLabel: m.tenantLabel ?? null,
    externalId: m.externalId,
    scope: m.scope ?? null,
  };
}

export const authClient = {
  useSession,

  signIn: {
    /**
     * Dev-demo sign-in. Treats the email as the externalId (stable per
     * user across sessions). Password is ignored — this reference
     * client is not a real auth backend.
     */
    email: async ({
      email,
      password: _password,
    }: {
      email: string;
      password: string;
    }): Promise<{ error: { message: string } | null }> => {
      try {
        await openSession({
          tenantId: "default",
          externalId: email.toLowerCase().trim(),
          name:
            readSessionMeta()?.email === email
              ? readSessionMeta()!.name
              : email.split("@")[0],
          email,
        });
        return { error: null };
      } catch (err) {
        return {
          error: { message: (err as Error).message || "Sign in failed" },
        };
      }
    },
  },

  /**
   * Persona sign-in — used by the demo picker. Mints a token for the
   * target tenant + scope + externalId. Unlike email/password login
   * (which always uses tenant `default`), this flow exercises the
   * tenant isolation + scope machinery end-to-end.
   */
  signInAsPersona: async (
    input: PersonaLoginInput,
  ): Promise<{ error: { message: string } | null }> => {
    try {
      // Seed demo tenants on first run — idempotent, cheap.
      await fetch(`${baseURL}/api/dev/seed-demo`, { method: "POST" }).catch(
        () => {
          /* non-fatal; mint-token will 404 if tenant is missing */
        },
      );
      await openSession({
        tenantId: input.tenantId,
        tenantLabel: input.tenantLabel,
        externalId: input.externalId,
        name: input.name,
        email: "",
        image: input.image ?? null,
        scope: input.scope ?? null,
      });
      return { error: null };
    } catch (err) {
      return {
        error: { message: (err as Error).message || "Sign in failed" },
      };
    }
  },

  signUp: {
    email: async ({
      name,
      email,
      password: _password,
    }: {
      name: string;
      email: string;
      password: string;
    }): Promise<{ error: { message: string } | null }> => {
      try {
        await openSession({
          tenantId: "default",
          externalId: email.toLowerCase().trim(),
          name,
          email,
        });
        return { error: null };
      } catch (err) {
        return {
          error: { message: (err as Error).message || "Sign up failed" },
        };
      }
    },
  },

  signOut: async (): Promise<void> => {
    setAuthToken(null);
    writeSessionMeta(null);
  },

  /**
   * Update the current user's profile. Re-mints the JWT with the new
   * claims so the next authenticated request triggers `upsertFederatedUser`
   * on the server — name/image propagate through all HTTP responses on
   * the following fetch. Live realtime broadcast (`user_updated`) stays
   * with the server-to-server webhook path which real tenants' backends
   * hit from their own backend.
   */
  updateUser: async (input: {
    name?: string;
    image?: string | null;
  }): Promise<{ error: { message: string } | null }> => {
    const current = readSessionMeta();
    if (!current) return { error: { message: "Not signed in" } };
    const next: SessionMeta = {
      ...current,
      name: input.name ?? current.name,
      image: input.image !== undefined ? input.image : current.image,
    };
    try {
      await openSession(next);
      return { error: null };
    } catch (err) {
      return {
        error: { message: (err as Error).message || "Update failed" },
      };
    }
  },

  /** Direct reference — same-origin fetch helper for the rare caller
   *  that needs the base URL at runtime. */
  _internal: { baseURL, mintToken, fetchMe },
};

const useCallbackKeepStaticRef = useCallback;
export { useCallbackKeepStaticRef };
