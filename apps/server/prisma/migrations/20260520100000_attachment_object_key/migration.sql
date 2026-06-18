-- Phase 3 (security hardening): persist the authoritative S3 object key
-- alongside the public URL so reads/deletes never reverse-engineer the
-- key from the URL via string-prefix matching (fragile under
-- S3_PUBLIC_URL_BASE rotation; a key-confusion surface).
ALTER TABLE "attachments" ADD COLUMN "object_key" TEXT;
