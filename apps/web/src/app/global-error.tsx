"use client";

import { useEffect } from "react";

/**
 * Root-level error boundary — ONLY fires when the root layout itself
 * throws. Must include its own <html>/<body>. This is the last resort
 * before the browser shows a generic error page, so keep it styled
 * with inline CSS (Mantine isn't guaranteed to be mounted here) and
 * focused on letting the user reload.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[global error]", error);
  }, [error]);

  return (
    <html>
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui, -apple-system, sans-serif",
          background: "#0a0a0a",
          color: "#ededed",
        }}
      >
        <div style={{ maxWidth: 420, padding: 24, textAlign: "center" }}>
          <h2 style={{ fontSize: 20, marginBottom: 8 }}>Something went wrong</h2>
          <p style={{ opacity: 0.7, fontSize: 14, marginBottom: 20 }}>
            {error.message || "An unexpected error occurred."}
          </p>
          <button
            onClick={reset}
            style={{
              padding: "8px 16px",
              borderRadius: 6,
              background: "#fff",
              color: "#000",
              border: 0,
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
