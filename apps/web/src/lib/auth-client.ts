import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  baseURL:
    typeof window !== "undefined"
      ? `${window.location.protocol}//${window.location.hostname}:3001`
      : "http://localhost:3001",
});
