-- Rollback for 20260901120000_purge_departed_inventory_toctou_lock.sql
-- SMI-6321
--
-- Restores purge_departed_team_members_inventory() to its pre-SMI-6321 body, verbatim
-- from 20260707000004_team_member_departure_purge.sql:189-255. Safe to apply via
-- `supabase db execute --file`. No schema objects are created or dropped -- this is a
-- single CREATE OR REPLACE plus the grant triple.
--
-- ============================================================================
-- WARNING -- READ BEFORE RUNNING: THIS REOPENS CONFIRMED, LIVE DATA LOSS
-- ============================================================================
--
-- The body restored below reads profiles.tier WITHOUT a row lock and only afterwards
-- deletes the member's user_devices rows. Under READ COMMITTED, a re-authentication
-- that commits between that read and the DELETE is invisible to the decision, so the
-- sweep destroys the entire device inventory of a member who is, by the time the
-- DELETE runs, fully entitled again -- silently, irreversibly, and with the member's
-- own login having just returned status 'ok'.
--
-- This is not theoretical. The SMI-6200 cross-wave UAT (SMI-6312, scenario R4)
-- reproduced it in 15 of 20 iterations under ordinary two-process concurrency, and a
-- forced interleaving reproduces it 100% of the time.
--
-- Rolling this back also discards four other protections the fix added, each of which
-- was reproduced live before being written:
--   * the fail-OPEN branch returns for a schedule row whose profiles row is missing:
--     v_tier stays NULL, `NULL IN ('team','enterprise')` is NULL, the IF does not fire,
--     and the DELETE runs on a read that took no lock at all;
--   * per-row isolation of the mutation half goes away, so ONE failing DELETE /
--     schedule UPDATE / audit INSERT again rolls back EVERY row's work while the
--     function still returns a POSITIVE count and pg_cron records a success -- an
--     invisible success on a compliance-obligated retention job;
--   * the cursor becomes unbounded again (no LIMIT);
--   * the `inventory:team_departure_purge.skipped` audit rows stop being written, so a
--     deferring sweep becomes unobservable outside the Postgres server log.
-- None of those four is the data-loss race itself, but all four were part of making
-- the lock trustworthy, and the restored body has none of them.
--
-- Two things also depend on the fixed behaviour and are NOT restored by this file:
--   * 20260829230000_sso_member_lifecycle.sql Section 8's "DELIBERATELY ACCEPTED GAP"
--     -- a successful SSO login does not cancel a pending purge-schedule row, on the
--     stated grounds that this sweep re-checks tier at execution time. Rolling back
--     makes that recheck unreliable again, so the accepted gap stops being safe.
--   * SMI-6318's pending-row upsert. Nothing breaks by rolling back (the pre-SMI-6321
--     body takes no profiles lock, so it cannot deadlock), but the protection SMI-6321
--     added is gone.
--
-- Roll back ONLY if this migration itself is implicated in an unrelated outage --
-- never to "temporarily" restore prior behaviour. If the concern is instead that the
-- new skip branches are leaving rows pending, diagnose that rather than reinstating
-- the data loss: the skips emit `RAISE WARNING`, which lands in the Postgres server
-- log (Supabase dashboard -> Logs -> Postgres), and the rows themselves are directly
-- queryable:
--
--   SELECT user_id, departed_team_id, scheduled_purge_at, created_at
--     FROM team_member_inventory_purge_schedule
--    WHERE purged_at IS NULL AND cancelled_reason IS NULL
--      AND scheduled_purge_at <= now()
--    ORDER BY scheduled_purge_at;
--
-- A row that stays in that result set across several days is a real signal; a row that
-- clears on the next nightly sweep was ordinary, transient lock contention.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION purge_departed_team_members_inventory()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_purged  INTEGER := 0;
  v_tier    TEXT;
  v_deleted INTEGER;
  r         RECORD;
BEGIN
  FOR r IN
    SELECT id, user_id, departed_team_id
      FROM team_member_inventory_purge_schedule
     WHERE purged_at IS NULL
       AND cancelled_reason IS NULL
       AND scheduled_purge_at <= NOW()
     FOR UPDATE SKIP LOCKED
  LOOP
    SELECT p.tier INTO v_tier FROM profiles p WHERE p.id = r.user_id;

    IF v_tier IN ('team', 'enterprise') THEN
      UPDATE team_member_inventory_purge_schedule
         SET cancelled_reason = 'still_entitled_at_sweep'
       WHERE id = r.id
         AND TRUE;
      CONTINUE;
    END IF;

    DELETE FROM user_devices d WHERE d.user_id = r.user_id;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;

    UPDATE team_member_inventory_purge_schedule
       SET purged_at = NOW()
     WHERE id = r.id
       AND TRUE;

    INSERT INTO audit_logs (event_type, actor, resource, action, result, metadata)
    VALUES (
      'inventory:team_departure_purge.completed',
      'pg_cron',
      'user_devices',
      'delete',
      'success',
      jsonb_build_object(
        'user_id', r.user_id,
        'departed_team_id', r.departed_team_id,
        'deleted_device_count', v_deleted
      )
    );

    v_purged := v_purged + 1;
  END LOOP;

  RETURN v_purged;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '[purge_departed_team_members_inventory] ERROR: % at %', SQLERRM, NOW();
  RETURN v_purged;
END;
$$;

COMMENT ON FUNCTION purge_departed_team_members_inventory() IS
  'SMI-5581/ADR-126: daily sweep for the 30-day departed-team-member inventory retention '
  'window. Re-checks CURRENT profiles.tier at execution time; purges user_devices (device_skills '
  'cascades) only if the member is no longer team/enterprise-entitled via ANY team, else cancels '
  'the schedule row. Scheduled daily 3:40 AM UTC. WARNING: this is the pre-SMI-6321 body -- the '
  'tier re-check is UNLOCKED and races a concurrent recompute_user_tier().';

-- CREATE OR REPLACE re-runs Supabase's ALTER DEFAULT PRIVILEGES, which re-grants
-- anon/authenticated EXECUTE on every new function; Postgres separately grants EXECUTE
-- to PUBLIC. Re-issue the full triple or this destructive, unparameterized sweep
-- becomes callable by any signed-in user over PostgREST (Check 52 / SMI-5526).
REVOKE ALL ON FUNCTION purge_departed_team_members_inventory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_departed_team_members_inventory() TO service_role;
REVOKE EXECUTE ON FUNCTION purge_departed_team_members_inventory() FROM anon, authenticated;

COMMIT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.role_routine_grants
     WHERE routine_name = 'purge_departed_team_members_inventory'
       AND grantee IN ('anon', 'authenticated', 'PUBLIC')
  ) THEN
    RAISE EXCEPTION 'ROLLBACK SMOKE FAIL: purge_departed_team_members_inventory is '
      'EXECUTE-able by anon/authenticated/PUBLIC after the rollback -- the REVOKE triple '
      'above did not take effect.';
  END IF;
  RAISE WARNING 'SMI-6321 ROLLED BACK: purge_departed_team_members_inventory() now reads '
    'profiles.tier WITHOUT a row lock. The departure-purge sweep can once again destroy an '
    'actively-entitled member''s device inventory (15/20 in the SMI-6312 R4 UAT).';
END $$;
