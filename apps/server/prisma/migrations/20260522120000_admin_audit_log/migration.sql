-- Phase 7.2: append-only audit trail for admin (operator) mutations.
-- Captures actor IP + request id so a leaked MASTER_API_KEY incident has
-- a forensic trail. No FK to tenant — rows must survive tenant deletion
-- (you need the row "tenant X was deleted by Y" exactly when X is gone).
CREATE TABLE "admin_audit_log" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "tenant_id" TEXT,
    "actor_ip" TEXT,
    "request_id" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "admin_audit_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "admin_audit_log_action_created_at_idx" ON "admin_audit_log"("action", "created_at");
CREATE INDEX "admin_audit_log_tenant_id_created_at_idx" ON "admin_audit_log"("tenant_id", "created_at");
