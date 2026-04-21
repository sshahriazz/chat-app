/**
 * Thin structured-logging wrapper. Writes JSON-ish lines to stdout/stderr
 * and redacts known-sensitive field names before logging. Deliberately
 * minimal — no pino/winston dependency — so it stays out of the hot path
 * and cheap to replace with a real logger when we move to production.
 *
 * Rules of thumb when using:
 *   - Prefer `logger.error("short message", { key: value })` over raw
 *     `console.error(err)`. Never log raw request bodies, message
 *     content, tokens, or cookie headers.
 *   - The `safeRedact` helper blanks any key listed in `SENSITIVE_KEYS`.
 *     Extend that list if you add new secrets.
 */

const SENSITIVE_KEYS = new Set([
  "content",
  "plainContent",
  "plain_content",
  "payload",
  "data",
  "token",
  "password",
  "secret",
  "cookie",
  "authorization",
  "Authorization",
  "p256dh",
  "auth",
  "accessToken",
  "refreshToken",
  "idToken",
]);

type Meta = Record<string, unknown>;

function safeRedact(meta: Meta | undefined): Meta | undefined {
  if (!meta) return undefined;
  const out: Meta = {};
  for (const [k, v] of Object.entries(meta)) {
    if (SENSITIVE_KEYS.has(k)) {
      out[k] = "[redacted]";
    } else if (v instanceof Error) {
      // Keep the error's name + message; strip the stack from structured
      // logs (still available via .stack if a caller wants to include it).
      out[k] = { name: v.name, message: v.message };
    } else {
      out[k] = v;
    }
  }
  return out;
}

function emit(level: "info" | "warn" | "error", msg: string, meta?: Meta) {
  const payload = { level, msg, ...(safeRedact(meta) ?? {}) };
  const line = JSON.stringify(payload);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (msg: string, meta?: Meta) => emit("info", msg, meta),
  warn: (msg: string, meta?: Meta) => emit("warn", msg, meta),
  error: (msg: string, meta?: Meta) => emit("error", msg, meta),
};
