import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request context carried through async boundaries. The only two
 * fields we attach everywhere are requestId (always) and userId (filled
 * after auth). Add more only if every handler genuinely needs it —
 * otherwise prefer passing values explicitly.
 */
export interface RequestContext {
  requestId: string;
  userId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(
  ctx: RequestContext,
  fn: () => T,
): T {
  return storage.run(ctx, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Attach the authenticated user's id to the current request context. */
export function setUserId(userId: string): void {
  const store = storage.getStore();
  if (store) store.userId = userId;
}
