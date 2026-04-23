-- Add optional second-level scope to User for B2B2C isolation.
--
-- Tenants can now partition their users into contexts (project chats,
-- support tickets, deal rooms, per-client CRM spaces) without creating
-- a new tenant per context. A NULL scope means "tenant-wide" (admins,
-- support agents that span across scopes). A non-null scope restricts
-- discovery + add-member to users with the same scope or NULL scope.
--
-- Nullable + default NULL means the rollout is zero-downtime: every
-- existing user row becomes tenant-wide, matching pre-column behavior.
-- Tenants opt individual users into scopes by adding `scope` to the
-- JWT claim; the middleware re-materializes the column on next auth.

ALTER TABLE "user" ADD COLUMN "scope" TEXT;
CREATE INDEX "user_tenant_id_scope_idx" ON "user"("tenant_id", "scope");
