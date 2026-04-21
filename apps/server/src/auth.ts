import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { createAuthMiddleware, APIError } from "better-auth/api";
import { prisma } from "./db";
import { env } from "./env";
import { invalidateUserProfile } from "./lib/user-cache";
import {
  clearAuthFailures,
  isAccountLocked,
  recordAuthFailure,
} from "./lib/auth-lockout";
import { authLockoutsTotal } from "./infra/metrics";

/**
 * Only accept avatar URLs that originate from our own object-storage
 * bucket (or the empty string — meaning "remove avatar"). Without this,
 * a user could set `image` to an arbitrary URL; every client that
 * renders their avatar would leak its IP + User-Agent to that origin.
 */
function isAllowedAvatarUrl(url: string): boolean {
  if (url === "") return true;
  const base = env.S3_PUBLIC_URL_BASE?.replace(/\/$/, "");
  if (!base) return false; // storage isn't configured; reject everything
  return url.startsWith(base + "/");
}

const allowedOrigins: string[] = (
  env.CORS_ALLOWED_ORIGINS ?? "http://localhost:3000,http://192.168.0.101:3000"
)
  .split(",")
  .map((s: string) => s.trim())
  .filter(Boolean);

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  baseURL: env.BETTER_AUTH_URL,
  basePath: "/api/auth",
  secret: env.BETTER_AUTH_SECRET,
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
  },
  trustedOrigins: allowedOrigins,
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // refresh every 24h
  },
  hooks: {
    after: createAuthMiddleware(async (ctx) => {
      // Bust the profile cache whenever better-auth mutates the user row.
      // The `before` hook validates the inputs; this one fires after
      // persistence so replicas read the fresh data on next lookup.
      if (ctx.path === "/update-user") {
        const userId = ctx.context?.session?.user?.id;
        if (userId) await invalidateUserProfile(userId);
      }

      // Account-lockout bookkeeping. We only get here on a non-thrown
      // response — better-auth already produced a payload. Inspect the
      // context to decide success vs. failure. Successful sign-in
      // populates `newSession`; failures don't.
      if (ctx.path === "/sign-in/email") {
        const email = (ctx.body as { email?: unknown })?.email;
        if (typeof email === "string" && email.length > 0) {
          const returned = ctx.context?.returned as
            | { newSession?: unknown }
            | undefined;
          if (returned?.newSession) {
            await clearAuthFailures(email);
          } else {
            await recordAuthFailure(email);
          }
        }
      }
    }),
    before: createAuthMiddleware(async (ctx) => {
      // Check the account lockout counter before better-auth does any
      // DB work. Rejecting here keeps the timing side-channel consistent
      // (locked email fails with the same shape as a wrong password)
      // and spares the DB a lookup per attempt.
      if (ctx.path === "/sign-in/email") {
        const email = (ctx.body as { email?: unknown })?.email;
        if (typeof email === "string" && email.length > 0) {
          if (await isAccountLocked(email)) {
            authLockoutsTotal.inc();
            throw new APIError("TOO_MANY_REQUESTS", {
              message:
                "Too many failed sign-in attempts. Try again in 15 minutes.",
            });
          }
        }
      }

      // Defense-in-depth for avatar updates. Client-side validation in
      // settings/page.tsx covers the happy path; this rejects direct
      // `authClient.updateUser({ image: "…" })` calls from the console.
      if (ctx.path === "/update-user") {
        const image = (ctx.body as { image?: unknown })?.image;
        if (image !== undefined && image !== null) {
          if (typeof image !== "string" || !isAllowedAvatarUrl(image)) {
            throw new APIError("BAD_REQUEST", {
              message: "Avatar URL must come from the configured object storage",
            });
          }
          // Length cap — user-supplied column, cap matches a generous URL.
          if (image.length > 2048) {
            throw new APIError("BAD_REQUEST", {
              message: "Avatar URL too long",
            });
          }
        }
        const name = (ctx.body as { name?: unknown })?.name;
        if (name !== undefined && name !== null) {
          if (typeof name !== "string" || name.length === 0 || name.length > 64) {
            throw new APIError("BAD_REQUEST", {
              message: "Name must be 1-64 characters",
            });
          }
        }
      }
    }),
  },
});
