-- Add api_key_prefix column + index so API-key authentication scales.
--
-- Before: findTenantByApiKey iterated every Tenant row and Argon2-verified
-- against each one. O(N tenants) Argon2 ops per request = a DoS vector and
-- a latency cliff at scale.
--
-- After: we look up by the first 8 chars of the raw key (stored unhashed
-- because they aren't by themselves a credential — they just narrow the
-- candidate set), then Argon2-verify the one row that matched. O(log N)
-- index probe + 1 verify.
--
-- Nullable for backwards-compat: legacy rows created before this column
-- existed still authenticate via the full-scan fallback and pick up a
-- prefix the next time their API key is rotated.

ALTER TABLE "tenant" ADD COLUMN "api_key_prefix" TEXT;
CREATE INDEX "tenant_api_key_prefix_idx" ON "tenant"("api_key_prefix");
