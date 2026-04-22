-- Tenancy foundations (PR 1 of 4).
--
-- Introduces the Tenant model and scopes every chat entity to a tenant.
-- Zero-downtime: all columns are added nullable, backfilled with a seeded
-- "default" tenant, then locked down to NOT NULL + unique.
--
-- After this migration ships, the existing cookie-based auth flow still
-- works unchanged (better-auth still owns sign-in). The JWT federation
-- middleware and webhook endpoints are dormant until routes opt in
-- (PR 2 dual-auth, PR 3 cutover).

-- ─── Step 1: additive schema ──────────────────────────────────
CREATE TABLE "tenant" (
  "id"            TEXT PRIMARY KEY,
  "name"          TEXT NOT NULL,
  "api_key_hash"  TEXT NOT NULL,
  "jwt_secret"    TEXT NOT NULL,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMP(3) NOT NULL
);

-- Seed the default tenant. `api_key_hash` and `jwt_secret` are
-- placeholders — rotated via `POST /api/admin/tenants/default/api-keys`
-- and `.../jwt-secret/rotate` immediately after deploy. The placeholders
-- are harmless: Argon2 verify against an unknown format always fails,
-- so no request can authenticate with a random api key against
-- `PLACEHOLDER`.
INSERT INTO "tenant" ("id", "name", "api_key_hash", "jwt_secret", "created_at", "updated_at")
VALUES (
  'default',
  'Default (legacy)',
  'PLACEHOLDER_ROTATE_AFTER_MIGRATION',
  'PLACEHOLDER_ROTATE_AFTER_MIGRATION',
  now(), now()
);

-- Every scoped table gains a nullable `tenant_id` column so existing
-- rows can continue to exist while the backfill runs.
ALTER TABLE "user"                ADD COLUMN "tenant_id"   TEXT,
                                  ADD COLUMN "external_id" TEXT;
ALTER TABLE "conversations"       ADD COLUMN "tenant_id"   TEXT;
ALTER TABLE "conversation_members" ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "messages"            ADD COLUMN "tenant_id"   TEXT;
ALTER TABLE "reactions"           ADD COLUMN "tenant_id"   TEXT;
ALTER TABLE "attachments"         ADD COLUMN "tenant_id"   TEXT;
ALTER TABLE "push_subscriptions"  ADD COLUMN "tenant_id"   TEXT;

-- ─── Step 2: backfill ─────────────────────────────────────────
-- Assign every pre-existing row to the 'default' tenant. `User.external_id`
-- defaults to the current server-internal id so existing FK relationships
-- keep working; tenants onboarded later pick their own externalIds.
UPDATE "user"                SET "tenant_id" = 'default', "external_id" = "id";
UPDATE "conversations"       SET "tenant_id" = 'default';
UPDATE "conversation_members" SET "tenant_id" = 'default';
UPDATE "messages"            SET "tenant_id" = 'default';
UPDATE "reactions"           SET "tenant_id" = 'default';
UPDATE "attachments"         SET "tenant_id" = 'default';
UPDATE "push_subscriptions"  SET "tenant_id" = 'default';

-- ─── Step 3: lock down ────────────────────────────────────────
-- NOT NULL + FK constraints + indexes. Safe to do last because the
-- backfill populated every row.
ALTER TABLE "user"
  ALTER COLUMN "tenant_id"   SET NOT NULL,
  ALTER COLUMN "tenant_id"   SET DEFAULT 'default',
  ALTER COLUMN "external_id" SET NOT NULL,
  ADD CONSTRAINT "user_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE;
CREATE UNIQUE INDEX "user_tenant_id_external_id_key"
  ON "user"("tenant_id", "external_id");
CREATE INDEX "user_tenant_id_idx" ON "user"("tenant_id");

ALTER TABLE "conversations"
  ALTER COLUMN "tenant_id" SET NOT NULL,
  ALTER COLUMN "tenant_id" SET DEFAULT 'default',
  ADD CONSTRAINT "conversations_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE;
CREATE INDEX "conversations_tenant_id_idx" ON "conversations"("tenant_id");

ALTER TABLE "conversation_members"
  ALTER COLUMN "tenant_id" SET NOT NULL,
  ALTER COLUMN "tenant_id" SET DEFAULT 'default',
  ADD CONSTRAINT "conversation_members_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE;
CREATE INDEX "conversation_members_tenant_id_idx" ON "conversation_members"("tenant_id");

ALTER TABLE "messages"
  ALTER COLUMN "tenant_id" SET NOT NULL,
  ALTER COLUMN "tenant_id" SET DEFAULT 'default',
  ADD CONSTRAINT "messages_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE;
CREATE INDEX "messages_tenant_id_idx" ON "messages"("tenant_id");

ALTER TABLE "reactions"
  ALTER COLUMN "tenant_id" SET NOT NULL,
  ALTER COLUMN "tenant_id" SET DEFAULT 'default',
  ADD CONSTRAINT "reactions_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE;
CREATE INDEX "reactions_tenant_id_idx" ON "reactions"("tenant_id");

ALTER TABLE "attachments"
  ALTER COLUMN "tenant_id" SET NOT NULL,
  ALTER COLUMN "tenant_id" SET DEFAULT 'default',
  ADD CONSTRAINT "attachments_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE;
CREATE INDEX "attachments_tenant_id_idx" ON "attachments"("tenant_id");

ALTER TABLE "push_subscriptions"
  ALTER COLUMN "tenant_id" SET NOT NULL,
  ALTER COLUMN "tenant_id" SET DEFAULT 'default',
  ADD CONSTRAINT "push_subscriptions_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE;
CREATE INDEX "push_subscriptions_tenant_id_idx" ON "push_subscriptions"("tenant_id");
