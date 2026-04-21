"use client";

import { createContext, useContext, type ReactNode } from "react";
import { authClient } from "@/lib/auth-client";
import type { User } from "@/lib/types";

interface AuthState {
  user: User | null;
  isLoading: boolean;
  signUp: (name: string, email: string, password: string) => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

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

  const signUp = async (name: string, email: string, password: string) => {
    const { error } = await authClient.signUp.email({
      name,
      email,
      password,
    });
    if (error) throw new Error(error.message);
  };

  const signIn = async (email: string, password: string) => {
    const { error } = await authClient.signIn.email({ email, password });
    if (error) throw new Error(error.message);
  };

  const signOut = async () => {
    await authClient.signOut();
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
