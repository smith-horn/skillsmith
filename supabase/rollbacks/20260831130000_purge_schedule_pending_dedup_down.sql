-- Rollback for 20260831130000_purge_schedule_pending_dedup.sql
-- SMI-6318
--
-- ============================================================================
-- READ FIRST -- WHAT REVERTING COSTS
-- ============================================================================
-- The forward migration fixes a confirmed, live data-integrity bug: both departure write
-- paths inserted an unconditional purge-schedule row, so a departed -> re-authenticated ->
-- departed-again user accumulated MULTIPLE pending rows, and the OLDEST one's timer fired
-- first -- destroying that user's device inventory before the 30-day ADR-126 grace window
-- from their most recent departure had elapsed. That is irreversible data loss for the
-- affected user, not a degraded feature.
--
-- Reverting re-opens it in full. Prefer fixing forward. This script exists because ADR-108
-- requires an unencrypted, runnable rollback reachable during an incident without git-crypt
-- (the forward migration lives under supabase/migrations/**, which IS encrypted).
--
-- ============================================================================
-- ORDER IS LOAD-BEARING
-- ============================================================================
-- Step 1 MUST run before step 2. The shipped function bodies use
-- `ON CONFLICT (user_id) WHERE ...`, whose arbiter is the index step 2 drops -- dropping the
-- index while those bodies are live makes EVERY departure raise 42P10. Both steps are in one
-- transaction here so that ordering cannot be got wrong by hand.
--
-- ============================================================================
-- STEP 1 -- restore the pre-SMI-6318 function bodies (plain INSERT, no upsert)
-- ============================================================================
-- These are NOT reproduced inline. Copying 200 lines of authorization-checked RPC into a
-- rollback script is how a partial revert ships -- a subtly different body that passes review
-- because it looks close enough. Re-apply the two ORIGINAL definitions verbatim from their own
-- migrations instead:
--
--   remove_team_member(TEXT)
--     supabase/migrations/20260707000004_team_member_departure_purge.sql, lines 85-172
--     (CREATE OR REPLACE FUNCTION ... $$; plus its GRANT EXECUTE ... TO authenticated)
--
--   expire_stale_sso_members()
--     supabase/migrations/20260829230000_sso_member_lifecycle.sql, lines 1250-1361
--     (CREATE OR REPLACE FUNCTION ... plus its COMMENT, REVOKEs and GRANT)
--
-- Both files are git-crypt encrypted. If you are responding to an incident WITHOUT git-crypt
-- access, do not hand-write replacements -- get an unlocked checkout, or leave the current
-- (fixed) bodies in place and drop nothing. The fixed bodies are strictly safer than the
-- originals; there is no incident in which reverting them alone is the urgent action.
--
-- The differences you are undoing, for review purposes, are exactly:
--   * the scheduling INSERT is an upsert on the pending-row arbiter (both functions)
--   * a v_purge_at guard -- fail-closed in the RPC, a per-row WARNING in the sweep
--   * an 'inventory_purge_scheduled_at' key added to each function's audit_logs metadata
--   * `v_purge_at := NULL` reset per sweep iteration
--   * `SET lock_timeout TO '2s'` on remove_team_member()
--
-- ============================================================================
-- STEP 2 -- drop the structural invariant
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';

-- Guard: refuse to drop the arbiter while a body that needs it is still installed. Without
-- this, running step 2 without step 1 silently converts every future departure into a 42P10
-- failure -- for remove_team_member() a broken admin action, for expire_stale_sso_members() a
-- swallowed per-row WARNING and a lost retention window.
DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('remove_team_member', 'expire_stale_sso_members')
       AND position('ON CONFLICT (user_id)' IN pg_get_functiondef(p.oid)) > 0
  ) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED: a departure function still uses the '
      'ON CONFLICT (user_id) arbiter this index provides. Run STEP 1 first (restore the '
      'original bodies from 20260707000004 and 20260829230000), then re-run this script. '
      'Dropping the index now would make every departure raise 42P10.';
  END IF;
END $guard$;

DROP INDEX IF EXISTS uq_team_member_purge_schedule_pending_user;

-- Restore 20260707000004's original table/column comments, so the schema stops documenting an
-- invariant it no longer enforces.
COMMENT ON TABLE team_member_inventory_purge_schedule IS
  'SMI-5581: scheduled inventory-retention purges for departed team members (30-day grace, '
  'ADR-126). One row per departure event; the daily sweep re-checks CURRENT entitlement '
  '(profiles.tier) before purging -- see the top-of-file design note on why this is a '
  're-check, not a per-team column filter (device_skills/user_devices have no team_id).';

COMMENT ON COLUMN team_member_inventory_purge_schedule.departed_team_id IS
  'The team the member left that triggered this schedule row. Audit context only -- the '
  'sweep''s purge/cancel decision is based on the member''s CURRENT overall tier, not this '
  'specific team (they may belong to a different team that also mandates sync).';

COMMENT ON COLUMN team_member_inventory_purge_schedule.cancelled_reason IS
  'Set by the sweep when the member is still team/enterprise-entitled at sweep time '
  '(e.g. ''still_entitled_at_sweep''). NULL + purged_at NULL = pending.';

COMMIT;

-- ============================================================================
-- STEP 3 -- OPTIONAL, and usually WRONG: re-open the backfilled rows
-- ============================================================================
-- The forward migration cancelled pre-existing duplicate pending rows with a distinct reason
-- so they stay distinguishable from genuine sweep cancellations. Re-opening them recreates
-- the multiple-pending-rows state that IS the bug -- only do this if you have also completed
-- step 1, and only if you specifically need the pre-migration row set back.
--
-- Confirmed live on prod 2026-08-30: this table had 0 rows, so on prod this step is a no-op.
--
-- BEGIN;
-- UPDATE team_member_inventory_purge_schedule
--    SET cancelled_reason = NULL
--  WHERE cancelled_reason = 'superseded_by_later_departure'
--    AND TRUE;
-- COMMIT;

-- ============================================================================
-- STEP 4 -- schema_version
-- ============================================================================
-- Deliberately NOT reverted. schema_version is an append-only applied-version log in this
-- repo (every migration inserts ON CONFLICT DO NOTHING and nothing ever deletes); removing
-- row 111 would make the log disagree with a version that genuinely was applied.
