-- Rollback for 20260808000000_smi5879_snapshot_generations.sql
-- SMI-5879
--
-- Drops the view, all claim/GC/digest/trigger functions and triggers, and the
-- three new tables (smi5879_repo_branch, smi5879_snapshot_pre, smi5879_run -- in
-- FK dependency order). Safe to apply via `supabase db execute --file`.
--
-- WARNING: reverting removes every snapshot generation ever recorded, including
-- sealed decision/window generations and their digests -- the permanent audit
-- record 8.3.5.2.1 describes is lost. Only run this if no census/simulation
-- artifact still references a run_id from this table. smi5879_snapshot_pre and
-- smi5879_repo_branch are dropped explicitly, in FK dependency order, BEFORE
-- smi5879_run below -- so by the time smi5879_run is dropped, no ON DELETE
-- RESTRICT referencing row remains to block it. CASCADE on that final DROP TABLE
-- is defense-in-depth only (drops any dependent objects, e.g. a view or FK
-- constraint, that the explicit drops above missed) -- not the mechanism that
-- clears the child tables' rows.

BEGIN;

DROP VIEW IF EXISTS v_smi5879_census_cohort;

DROP FUNCTION IF EXISTS smi5879_gc_delete_population(text);
DROP FUNCTION IF EXISTS smi5879_abandon_unclaimed_run(text, text);
DROP FUNCTION IF EXISTS smi5879_gc_force_abandon(text, uuid, text, interval);
DROP FUNCTION IF EXISTS smi5879_release_run(text, uuid);
DROP FUNCTION IF EXISTS smi5879_heartbeat(text, uuid);
DROP FUNCTION IF EXISTS smi5879_claim_run(text, uuid, text, interval);

DROP FUNCTION IF EXISTS smi5879_branch_digest(text);
DROP FUNCTION IF EXISTS smi5879_population_digest(text);
DROP FUNCTION IF EXISTS smi5879_canon_ts(timestamptz);
DROP FUNCTION IF EXISTS smi5879_canon(text);

DROP TRIGGER IF EXISTS smi5879_repo_branch_no_truncate ON smi5879_repo_branch;
DROP TRIGGER IF EXISTS smi5879_repo_branch_guard ON smi5879_repo_branch;
DROP TRIGGER IF EXISTS smi5879_snapshot_pre_no_truncate ON smi5879_snapshot_pre;
DROP TRIGGER IF EXISTS smi5879_snapshot_pre_guard ON smi5879_snapshot_pre;

DROP FUNCTION IF EXISTS smi5879_no_truncate();
DROP FUNCTION IF EXISTS smi5879_snapshot_guard();

DROP TABLE IF EXISTS smi5879_repo_branch;
DROP TABLE IF EXISTS smi5879_snapshot_pre;
DROP TABLE IF EXISTS smi5879_run CASCADE;

COMMIT;
