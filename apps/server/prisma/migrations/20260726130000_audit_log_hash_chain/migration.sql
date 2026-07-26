-- Tamper-evident hash chain for the admin audit log.
--
-- Each new row stores the SHA-256 of (prev_hash || canonical content of
-- this row). Any edit, deletion, or reorder of a historical row breaks
-- every subsequent hash, which a verifier detects by re-walking the chain
-- (see lib/admin-audit.ts `verifyAuditChain`). `prev_hash` is NULL for the
-- genesis row; both columns are NULL for legacy rows written before this
-- migration (the verifier starts the chain at the first hashed row).
ALTER TABLE "admin_audit_log" ADD COLUMN "prev_hash" TEXT;
ALTER TABLE "admin_audit_log" ADD COLUMN "hash" TEXT;
