-- PR 3 cutover: drop better-auth tables + columns.
--
-- After PR 1 backfilled tenancy + PR 2 migrated the UI to use JWTs,
-- the sessions, accounts, and verification tables are dead weight and
-- the `email_verified` + `email_unique` constraints no longer apply:
-- email is display-only under the federated identity model, and
-- uniqueness is now `(tenant_id, external_id)`.
--
-- Irreversible locally. To roll back, restore from the snapshot taken
-- before this migration (see the deploy runbook).

-- Tables that were FK'd to user via better-auth only.
DROP TABLE IF EXISTS "session";
DROP TABLE IF EXISTS "account";
DROP TABLE IF EXISTS "verification";

-- email was globally unique + NOT NULL because better-auth used it as
-- the login identifier. Under JWT federation it's just display, keyed
-- by (tenant, externalId). Allow NULL + drop the uniqueness.
DROP INDEX IF EXISTS "user_email_key";
ALTER TABLE "user"
  DROP COLUMN IF EXISTS "email_verified",
  ALTER COLUMN "email" DROP NOT NULL;
