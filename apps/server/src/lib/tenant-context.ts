import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request tenant context, propagated via AsyncLocalStorage.
 *
 * The auth middleware (`require-user-jwt`) establishes it for the duration
 * of each authenticated request. The Prisma extension (`infra/prisma.ts`)
 * reads it to set the `app.current_tenant_id` Postgres GUC, which the
 * Row-Level Security policies use to restrict queries to the tenant
 * (defense-in-depth beneath the app-layer `WHERE tenant_id = ?` filters).
 *
 * `inManagedTx` marks that execution is inside an app-managed interactive
 * transaction (`withRealtime`, the attachment-quota tx). The extension
 * then skips its own per-query transaction wrapper — wrapping a query that
 * already runs inside an interactive transaction would open a SECOND,
 * separate transaction and break atomicity. Those paths rely on the
 * RLS fail-open-when-no-context policy (and the app-layer filters) instead.
 */
export interface TenantContext {
  tenantId: string;
  inManagedTx?: boolean;
}

export const tenantContext = new AsyncLocalStorage<TenantContext>();

/** Run `fn` with the given tenant as the ambient context. */
export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  return tenantContext.run({ tenantId }, fn);
}

/** Current tenant id, or undefined outside an authenticated request. */
export function getTenantId(): string | undefined {
  return tenantContext.getStore()?.tenantId;
}

/**
 * Run `fn` marked as inside an app-managed interactive transaction so the
 * Prisma extension does not wrap its queries in a nested transaction.
 * No-op (preserving behavior) when there is no ambient tenant context.
 */
export function runInManagedTx<T>(fn: () => Promise<T>): Promise<T> {
  const cur = tenantContext.getStore();
  if (!cur) return fn();
  return tenantContext.run({ ...cur, inManagedTx: true }, fn);
}
