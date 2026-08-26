-- Whether a member can read messages sent before they joined.
--
-- Two products want opposite answers and both are right for their case. A
-- private group chat should fence history; a business's shared client
-- conversation should not, because the conversation belongs to the company and
-- a new account manager inherits the relationship rather than a blank thread.
--
-- Defaults to false — the fence stays on — because that is the choice that
-- cannot leak anything by accident. Existing tenants keep today's behaviour.
ALTER TABLE "tenant"
  ADD COLUMN "full_history_for_new_members" BOOLEAN NOT NULL DEFAULT false;
