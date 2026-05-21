-- Phase 2 (security hardening): token revocation + GDPR delete tombstones.

-- User.tokens_valid_after — token revocation epoch. JWTs whose `iat`
-- is strictly less than this timestamp are rejected on verify. Bumped
-- on DELETE /me and on POST /me/revoke. NULL means "no horizon" (epoch 0).
ALTER TABLE "user" ADD COLUMN "tokens_valid_after" TIMESTAMP(3);

-- DeletedExternalId — tombstone table consulted by requireUserJwt before
-- federated-upsert. Prevents a JWT from silently re-materializing a user
-- the operator already deleted under GDPR. Rows past `expires_at` are
-- garbage-collected nightly, freeing the (tenantId, externalId) pair
-- for legitimate re-registration.
CREATE TABLE "deleted_external_id" (
    "tenant_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "deleted_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "deleted_external_id_pkey" PRIMARY KEY ("tenant_id", "external_id")
);

CREATE INDEX "deleted_external_id_expires_at_idx" ON "deleted_external_id"("expires_at");

ALTER TABLE "deleted_external_id"
    ADD CONSTRAINT "deleted_external_id_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
