-- ============================================================================
-- SMI-5281: Backfill ~1,775 stale-quarantine false-positives
-- ============================================================================
-- DESIGN-ONLY ARTIFACT — DO NOT AUTO-APPLY. This is NOT a migration.
-- A human runs this DELIBERATELY via the session pooler after explicit sign-off.
--
-- Linear: SMI-5281 (child of SMI-5279 — skills-refresh-metadata 100% failure)
--
-- ----------------------------------------------------------------------------
-- WHY THIS EXISTS
-- ----------------------------------------------------------------------------
-- While `skills-refresh-metadata` was failing 100% (SMI-5279), it stopped
-- touching `last_seen_at` (the per-skill liveness heartbeat that SMI-3540 /
-- SMI-4201 wired into the refresh path). With `last_seen_at` frozen, the
-- indexer's stale-reconciliation pass (supabase/functions/indexer/
-- stale-reconciliation.ts) saw ~1,775 LIVE skills cross the staleness
-- threshold and batch-quarantined them with `quarantined = TRUE` + a STALE
-- finding (supabase/functions/_shared/quarantine.ts → FINDING_STALE).
--
-- The SMI-5279 fix alone does NOT recover these rows:
--   * The refresh job SELECTs `quarantined = FALSE` (it skips quarantined
--     rows), so it will never re-touch `last_seen_at` for them.
--   * The indexer only RE-quarantines (`quarantined = FALSE` → TRUE); it has
--     no auto-unquarantine path. Only the changed-repo subset would ever clear
--     organically, and that never covers the full ~1,775 backlog.
-- This is the SAME cascade pattern fixed twice before — migration 064
-- (SMI-3540) and migration 067 (SMI-4202). This script is the manual,
-- run-on-demand equivalent of those, scoped to the SMI-5279 incident.
--
-- ----------------------------------------------------------------------------
-- PRECONDITIONS — verify ALL before the APPLY section
-- ----------------------------------------------------------------------------
--  1. SMI-5279 IS DEPLOYED to prod. `skills-refresh-metadata` is green again.
--     Confirm via recent `refresh:run` events in audit_logs (result='success').
--  2. At least ONE full refresh + indexer cycle has run AFTER the SMI-5279
--     deploy, so `last_seen_at` is advancing again for live skills. If you
--     unquarantine BEFORE last_seen_at recovers, the very next indexer pass
--     will re-quarantine the same rows (this is exactly how 064 → 067 recurred
--     — see migration 067 header: the first fix regressed because the refresh
--     path "never touched last_seen_at").
--  3. SMI-3540's last_seen_at-touch is LIVE in the refresh path (it is, post
--     SMI-4201 e8a657fc — re-confirm it wasn't reverted by the SMI-5279 fix).
--  4. The stale threshold (`stale_days` passed to reconcileStaleSkills, clamped
--     1..90, default 30) is adequate — i.e. larger than the refresh+indexer
--     cadence so a single missed cycle can't re-trigger the cascade. Confirm
--     the current value before running; widen it first if it is too tight.
--  5. STRONGLY RECOMMENDED: disable the indexer cron for the duration
--     (`gh workflow disable indexer.yml`) so the 4×-daily stale pass cannot
--     re-quarantine restored rows mid-backfill — exactly as migration 067's
--     header prescribes. Re-enable after verifying recovery holds.
--
-- ----------------------------------------------------------------------------
-- HOW TO RUN
-- ----------------------------------------------------------------------------
-- Session pooler (port 5432) — the APPLY block is a batched DO-loop with
-- intra-transaction work, so use the SESSION pooler, not the transaction
-- pooler (which 8s-timeouts / ECHECKOUTTIMEOUTs on long loops). Per CLAUDE.md:
--
--     varlock run -- ./scripts/pooler-psql-session.sh \
--       -f scripts/backfill-stale-quarantine-smi-5281.sql
--
-- WORKFLOW:
--   Step 1. Run AS-IS (DRY_RUN section only is live; APPLY is commented out).
--           Read the counts + preview. Confirm the affected count is in the
--           expected ~1,775 ballpark and the preview rows look like live skills.
--   Step 2. Get explicit human go-ahead.
--   Step 3. Un-comment the APPLY section (remove the /* ... */ wrapper) and
--           re-run. The APPLY block is idempotent — re-running after a partial
--           run, or after the set is already clean, is a safe no-op.
--
-- Schema grounding (supabase/migrations):
--   * skills.quarantined        BOOLEAN NOT NULL DEFAULT FALSE   (039)
--   * skills.security_findings   JSONB    DEFAULT '[]'::JSONB     (039) — array of objects
--   * skills.quarantine_reason   TEXT                             (047) — NULL for indexer-stale rows
--   * skills.last_seen_at        TIMESTAMPTZ DEFAULT NOW()        (042)
--   * skills.repo_url            TEXT UNIQUE                      (001)
--
-- Grounded stale-finding shape (supabase/functions/_shared/quarantine.ts,
-- FINDING_STALE — appended verbatim by quarantineSkillsBatch):
--     {
--       "type": "stale",
--       "severity": "info",
--       "description": "Skill repository not found during recent indexer runs",
--       "lineNumber": 0
--     }
-- The load-bearing discriminator is `type === 'stale'` → SQL: f->>'type' = 'stale'.
-- security_findings is a JSON ARRAY of such objects; a stale-ONLY row is one
-- whose array contains NO element with a non-'stale' type.
-- ============================================================================


-- ============================================================================
-- DRY-RUN (DEFAULT — always runs)
-- ============================================================================
-- Stale-ONLY predicate, identical in spirit to migrations 064 / 067:
--   quarantined = TRUE
--   AND (quarantine_reason IS NULL OR quarantine_reason = 'stale')
--       -- indexer batch-quarantine (quarantine.ts) does NOT set
--       -- quarantine_reason, so stale rows from the indexer have it NULL;
--       -- the 'stale' literal covers any path that did set it.
--   AND no security_findings element has a non-'stale' type
--       -- i.e. do NOT touch rows carrying a real security/abuse/repo_deleted/
--       -- repo_archived finding. We strip ONLY the stale finding; everything
--       -- else is preserved.

-- 1a. Headline count of rows that WOULD be un-quarantined.
SELECT
  COUNT(*) AS stale_only_quarantined_count
FROM skills
WHERE quarantined = TRUE
  AND (quarantine_reason IS NULL OR quarantine_reason = 'stale')
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(security_findings) = 'array' THEN security_findings ELSE '[]'::jsonb END
    ) AS f
    WHERE f->>'type' <> 'stale'
  );

-- 1b. Safety counter-count: quarantined rows we are deliberately LEAVING ALONE
--     because they carry at least one non-stale finding. If this is unexpectedly
--     large, investigate before applying.
SELECT
  COUNT(*) AS quarantined_with_other_findings_left_intact
FROM skills
WHERE quarantined = TRUE
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(security_findings) = 'array' THEN security_findings ELSE '[]'::jsonb END
    ) AS f
    WHERE f->>'type' <> 'stale'
  );

-- 1c. Preview the first 50 affected rows for eyeball verification.
--     `last_seen_at` here is the FROZEN-at-quarantine value; after preconditions
--     1-4 hold, the indexer/refresh will re-advance it on the next cycle. We do
--     NOT gate on repo-liveness in SQL (see "Repo-liveness" note below) —
--     un-quarantining returns the skill to the indexer's normal liveness loop,
--     which is the authoritative re-quarantine arbiter if a repo is truly dead.
SELECT
  id,
  name,
  repo_url,
  quarantine_reason,
  last_seen_at,
  security_findings
FROM skills
WHERE quarantined = TRUE
  AND (quarantine_reason IS NULL OR quarantine_reason = 'stale')
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(security_findings) = 'array' THEN security_findings ELSE '[]'::jsonb END
    ) AS f
    WHERE f->>'type' <> 'stale'
  )
ORDER BY last_seen_at ASC
LIMIT 50;


-- ============================================================================
-- APPLY  (COMMENTED OUT BY DEFAULT — remove the /* ... */ wrapper to run)
-- ============================================================================
-- Mirrors migration 064/067: audit-log-before → batched unquarantine →
-- audit-log-after. Idempotent: the WHERE predicate self-empties as rows are
-- fixed, so re-runs and runs against an already-clean set are no-ops.
--
-- Batching: ~1,775 rows is modest, but we batch in groups of 1,000 anyway to
-- bound the UPDATE's lock footprint and avoid a single long ACCESS EXCLUSIVE
-- row-lock span on the heavily-read `skills` table. The session pooler keeps
-- the connection alive across the DO-loop (the transaction pooler would not).

/*
-- Step A: Audit log BEFORE — records intent + pre-state count.
INSERT INTO audit_logs (event_type, actor, action, result, metadata)
SELECT
  'quarantine:backfill',
  'system',
  'bulk_unquarantine',
  'started',
  jsonb_build_object(
    'description', 'SMI-5281: backfill stale-quarantine false-positives from the SMI-5279 refresh outage',
    'note', 'SMI-5281 — stale-ONLY rows; non-stale findings preserved',
    'smi', 'SMI-5281',
    'affected_count', COUNT(*),
    'executed_at', NOW()
  )
FROM skills
WHERE quarantined = TRUE
  AND (quarantine_reason IS NULL OR quarantine_reason = 'stale')
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(security_findings) = 'array' THEN security_findings ELSE '[]'::jsonb END
    ) AS f
    WHERE f->>'type' <> 'stale'
  );

-- Step B: Batched unquarantine. Strips ONLY the stale finding (preserving any
-- other finding), clears quarantine_reason, and refreshes last_seen_at = NOW()
-- so the row re-enters the live set rather than immediately re-tripping the
-- staleness threshold.
DO $$
DECLARE
  batch_size INT := 1000;
  rows_affected INT := 1;
  total INT := 0;
BEGIN
  WHILE rows_affected > 0 LOOP
    WITH batch AS (
      SELECT id
      FROM skills
      WHERE quarantined = TRUE
        AND (quarantine_reason IS NULL OR quarantine_reason = 'stale')
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(security_findings) = 'array' THEN security_findings ELSE '[]'::jsonb END
          ) AS f
          WHERE f->>'type' <> 'stale'
        )
      LIMIT batch_size
    )
    UPDATE skills s
    SET
      quarantined = FALSE,
      quarantine_reason = NULL,
      -- Remove ONLY stale findings; preserve everything else (mirrors 064/067).
      security_findings = COALESCE(
        (
          SELECT jsonb_agg(f)
          FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(s.security_findings) = 'array' THEN s.security_findings ELSE '[]'::jsonb END
          ) AS f
          WHERE f->>'type' <> 'stale'
        ),
        '[]'::jsonb
      ),
      last_seen_at = NOW()
    FROM batch
    WHERE s.id = batch.id;

    GET DIAGNOSTICS rows_affected = ROW_COUNT;
    total := total + rows_affected;
    RAISE NOTICE 'SMI-5281 unquarantine batch: % rows (running total %)', rows_affected, total;
  END LOOP;
  RAISE NOTICE 'SMI-5281 backfill complete: % rows unquarantined', total;
END $$;

-- Step C: Audit log AFTER — records post-state for the run record.
INSERT INTO audit_logs (event_type, actor, action, result, metadata)
VALUES (
  'quarantine:backfill',
  'system',
  'bulk_unquarantine',
  'completed',
  jsonb_build_object(
    'description', 'SMI-5281: stale-quarantine backfill complete',
    'note', 'SMI-5281 — stale-ONLY rows un-quarantined; non-stale findings preserved',
    'smi', 'SMI-5281',
    'remaining_quarantined', (SELECT COUNT(*) FROM skills WHERE quarantined = TRUE),
    'total_searchable', (SELECT COUNT(*) FROM skills WHERE quarantined = FALSE),
    'completed_at', NOW()
  )
);
*/

-- ============================================================================
-- POST-RUN VERIFICATION (run AFTER the APPLY block)
-- ============================================================================
-- Expect 0 (the stale-only set is now empty / idempotent).
--   SELECT COUNT(*) AS remaining_stale_only
--   FROM skills
--   WHERE quarantined = TRUE
--     AND (quarantine_reason IS NULL OR quarantine_reason = 'stale')
--     AND NOT EXISTS (
--       SELECT 1 FROM jsonb_array_elements(
--         CASE WHEN jsonb_typeof(security_findings) = 'array' THEN security_findings ELSE '[]'::jsonb END
--       ) AS f WHERE f->>'type' <> 'stale'
--     );
--
-- Then watch the next indexer + refresh cycle: confirm last_seen_at advances
-- for the restored rows and that the stale-reconciliation pass does NOT
-- re-quarantine them. If it does, precondition 2/4 was not actually met —
-- last_seen_at had not recovered, or the threshold is too tight. Re-enable
-- indexer.yml only once recovery holds.
-- ============================================================================
