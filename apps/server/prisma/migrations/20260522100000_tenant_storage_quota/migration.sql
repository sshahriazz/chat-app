-- Phase 3.9: optional per-tenant aggregate attachment-storage cap (bytes).
-- NULL = no tenant-level cap (the per-user cap still applies). Enforced
-- atomically at presign time under a per-tenant advisory lock alongside
-- the per-user quota check.
ALTER TABLE "tenant" ADD COLUMN "storage_quota_bytes" BIGINT;
