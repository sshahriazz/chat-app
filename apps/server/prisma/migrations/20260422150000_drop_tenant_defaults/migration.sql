-- Drop the column-level DEFAULT 'default' on every tenant_id.
--
-- The defaults existed because PR 1 needed to backfill existing rows
-- to a "default" tenant without rewriting every INSERT in the codebase
-- in the same change. Now that all routes set tenantId explicitly
-- (audit completed 2026-04-22), keeping the default is a footgun:
-- any future raw SQL or new code path that forgets tenantId would
-- silently land in the "default" tenant and cross-contaminate it.
--
-- Removing the default forces every insert to provide tenantId at the
-- type system level (Prisma) and at the DB level (NOT NULL stays). The
-- "default" tenant row itself is left in place — legacy users still
-- belong to it.

ALTER TABLE "user"                 ALTER COLUMN "tenant_id" DROP DEFAULT;
ALTER TABLE "conversations"        ALTER COLUMN "tenant_id" DROP DEFAULT;
ALTER TABLE "conversation_members" ALTER COLUMN "tenant_id" DROP DEFAULT;
ALTER TABLE "messages"             ALTER COLUMN "tenant_id" DROP DEFAULT;
ALTER TABLE "reactions"            ALTER COLUMN "tenant_id" DROP DEFAULT;
ALTER TABLE "attachments"          ALTER COLUMN "tenant_id" DROP DEFAULT;
ALTER TABLE "push_subscriptions"   ALTER COLUMN "tenant_id" DROP DEFAULT;
