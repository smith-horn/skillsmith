-- Rollback for 20260901140000_device_skills_identity_columns.sql
-- SMI-6345 (Wave 1 Step 3)
--
-- Drops the four device_skills identity columns and the device_skills_identity_audit
-- table. Safe to apply via `supabase db execute --file`.
--
-- ============================================================================
-- WARNING -- READ BEFORE RUNNING
-- ============================================================================
--
-- 1. THIS IS DESTRUCTIVE ONCE ANYTHING HAS WRITTEN. While Wave 1 is the only thing
--    applied, every row is at the default 'unresolved' with a NULL canonical identity
--    and an empty audit table, so this rollback loses nothing. AFTER Wave 2 (ingestion
--    resolution) or Wave 3 (historical classification) has run, DROP COLUMN destroys
--    every resolved identity AND the audit trail that is the only way to reconstruct
--    them -- there is no second copy. Re-applying the forward migration afterwards
--    gives you the columns back at their defaults, not the data. Confirm with:
--
--      SELECT count(*) FILTER (WHERE canonical_skill_id IS NOT NULL) AS resolved,
--             count(*) FILTER (WHERE identity_evidence <> 'unresolved') AS classified
--        FROM device_skills;
--      SELECT count(*) FROM device_skills_identity_audit;
--
--    Anything non-zero means this rollback is a data-loss operation, not a schema undo.
--
-- 2. DROP COLUMN takes an ACCESS EXCLUSIVE lock on device_skills (metadata-only, no
--    rewrite), and DROP TABLE takes one on the audit table. Both are bounded below.
--
-- 3. Nothing else depends on these objects while only Wave 1 is applied -- no view, no
--    function body, no index outside the ones dropped with their table. If Wave 2/3/4/5
--    have shipped, DROP the dependent functions/procedures FIRST (Postgres will
--    otherwise refuse, or CASCADE will silently take them with it -- do not use CASCADE
--    here for exactly that reason).

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

DROP TABLE IF EXISTS device_skills_identity_audit;

-- SMI-6345 Wave 1 Codex adversarial review, finding 1: the forward migration added a
-- table-level CHECK spanning canonical_skill_id and identity_evidence. Drop it
-- explicitly, by name, before dropping either column -- do not rely on DROP COLUMN's
-- implicit constraint-drop behavior for a multi-column CHECK, which this rollback does
-- not need to gamble on when the constraint has a name.
ALTER TABLE device_skills
  DROP CONSTRAINT IF EXISTS device_skills_canonical_id_evidence_tier_check;

ALTER TABLE device_skills
  DROP COLUMN IF EXISTS evidence_protocol,
  DROP COLUMN IF EXISTS identity_resolved_at,
  DROP COLUMN IF EXISTS identity_evidence,
  DROP COLUMN IF EXISTS canonical_skill_id;

COMMIT;
