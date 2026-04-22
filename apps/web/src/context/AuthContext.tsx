"use client";

import { createContext, useContext, useEffect, type ReactNode } from "react";
import { authClient } from "@/lib/auth-client";
import { setAuthToken } from "@/lib/auth-token";
import type { User } from "@/lib/types";

interface AuthState {
  user: User | null;
  isLoading: boolean;
  signUp: (name: string, email: string, password: string) => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * After a successful better-auth sign-in the reference client mints a
 * short-lived tenant user JWT via `/api/dev/mint-token` and stashes it
 * in `auth-token.ts` so `api.ts` attaches it as a Bearer header on
 * every subsequent request. The server's dual-auth dispatcher then
 * prefers the JWT path — which is the real API surface a tenant would
 * wire up in production.
 *
 * The cookie session still exists alongside and works as a fallback
 * until PR 3 drops it. Minting targets the default tenant because
 * that's where every legacy user was backfilled.
 */
async function mintTenantJwt(user: User): Promise<string | null> {
  try {
    const res = await fetch("/api/dev/mint-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        tenantId: "default",
        externalId: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { token: string };
    return data.token;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { data: session, isPending } = authClient.useSession();

  const user: User | null = session?.user
    ? {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
        image: session.user.image ?? null,
      }
    : null;

  // Mint / refresh the tenant JWT whenever the better-auth session
  // settles on a user. Clears the token on sign-out. We intentionally
  // depend on the individual User fields rather than the object —
  // `user` gets a fresh identity on every render.
  const uid = user?.id;
  const uname = user?.name;
  const uimage = user?.image;
  useEffect(() => {
    let cancelled = false;
    if (!uid) {
      setAuthToken(null);
      return;
    }
    void mintTenantJwt({
      id: uid,
      name: uname ?? "",
      email: user?.email ?? "",
      image: uimage ?? null,
    }).then((token) => {
      if (!cancelled) setAuthToken(token);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, uname, uimage]);

  const signUp = async (name: string, email: string, password: string) => {
    const { error } = await authClient.signUp.email({ name, email, password });
    if (error) throw new Error(error.message);
  };

  const signIn = async (email: string, password: string) => {
    const { error } = await authClient.signIn.email({ email, password });
    if (error) throw new Error(error.message);
  };

  const signOut = async () => {
    await authClient.signOut();
    setAuthToken(null);
  };

  return (
    <AuthContext.Provider
      value={{ user, isLoading: isPending, signUp, signIn, signOut }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
