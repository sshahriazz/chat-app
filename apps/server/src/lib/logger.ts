/**
 * Back-compat shim. The canonical logger lives at `src/infra/logger.ts`
 * and follows pino's native `(mergingObj, msg)` signature. Old call sites
 * passed `(msg, meta)` — this shim accepts both orders during the
 * migration window. Once all call sites have been flipped, import from
 * `../infra/logger` directly and delete this file.
 */
import { getLogger } from "../infra/logger";

type Meta = Record<string, unknown> | undefined;

function writeAtLevel(
  level: "info" | "warn" | "error",
  msg: string,
  meta: Meta,
) {
  const log = getLogger();
  if (meta) log[level](meta, msg);
  else log[level](msg);
}

export const logger = {
  info: (msg: string, meta?: Meta) => writeAtLevel("info", msg, meta),
  warn: (msg: string, meta?: Meta) => writeAtLevel("warn", msg, meta),
  error: (msg: string, meta?: Meta) => writeAtLevel("error", msg, meta),
};
