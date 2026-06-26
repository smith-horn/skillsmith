-- SMI-5357 rollback for 20260625000001_backfill_quarantine_reason.sql
--
-- Drops ONLY the write-path CHECK guard. The data backfill (quarantine_reason
-- 'stale' on the 86 NULL-reason rows; security_score=0 on the 44 orphaned-score
-- rows) is FORWARD-ONLY by design: reverting 'stale' -> NULL would re-break
-- ADR-112 Contract 4, and the original scores are stale artifacts not worth
-- restoring. If a manual data reversal is ever required, the exact pre-state
-- (row IDs + old reason/score) is preserved in audit_logs:
--   event_type = 'quarantine:integrity_backfill', action = 'capture_prestate'.

BEGIN;
-- DROP CONSTRAINT also takes ACCESS EXCLUSIVE on the hot `skills` table — fail fast.
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.skills DROP CONSTRAINT IF EXISTS skills_quarantine_has_reason;
COMMIT;
