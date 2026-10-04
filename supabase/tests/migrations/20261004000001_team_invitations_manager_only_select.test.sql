-- SMI-6653: tests for migration 20261004000001_team_invitations_manager_only_select.sql
--
-- Tests exercise the design §3.7 fix on `team_invitations`:
--   (1) team_invitations_select_manager -- row policy narrows SELECT to callers holding
--       team:manage_members (I-1, I-3)
--   (2) the column-level lockdown -- GRANT SELECT on ten columns, `token` omitted (I-2, I-5)
--   (3) the SSO freshness gate already in has_team_permission() applied through this policy
--       (I-6 fresh, I-7 stale)
--   (4) the six write-privilege REVOKEs (I-5)
--   (5) every write path (SECURITY DEFINER functions) stays reachable (I-4, I-8)
--
-- Runner:
--   docker exec skillsmith-dev-1 psql "$LOCAL_SUPABASE_URL" \
--     -f supabase/tests/migrations/20261004000001_team_invitations_manager_only_select.test.sql
--
-- Each test is wrapped in an explicit BEGIN; ... ROLLBACK; so the local DB is unchanged after
-- the run. Assertions use RAISE EXCEPTION (not pgTAP — see 080_profile_completion.test.sql for
-- precedent). RLS-dependent tests simulate a specific caller via
-- `set_config('request.jwt.claims', ...)` + `SET LOCAL ROLE authenticated` -- the same idiom
-- 20260729000001_private_registry_hardening_backfill.sql's smoke block (a6) uses -- and guard
-- against an environment where the connecting role cannot SET ROLE authenticated by checking
-- `pg_has_role(current_user, 'authenticated', 'MEMBER')` first.
--
-- THAT GATE FAILS CLOSED, and it did not always. It used to raise a "NOT VERIFIED" NOTICE and
-- carry on -- but the `RAISE NOTICE '<id> PASS'` line sits AFTER the gate's `END IF`, so it fired
-- on both arms: seven of the eight assertions printed `PASS` in an environment where they had
-- asserted nothing, and the documented success signal below was satisfied by a run that verified
-- zero of them. The three-way outcome (failed / passed / never-ran) collapsed into two, and the
-- arm it lost was the silent one. The gate now raises an EXCEPTION, which aborts the DO block
-- before its PASS line is reachable. A run that cannot assume the `authenticated` role is now
-- loud rather than reassuring -- which matters most to exactly the person this file's own
-- SMI-6598 note is addressed to, who needs these lines to mean something.
--
-- Expected output on success: a stream of `NOTICE:  <id> PASS` lines followed by
-- `NOTICE:  All team_invitations manager-only-select tests passed`. Any failure -- including
-- "this environment cannot verify these assertions" -- raises an exception and aborts the run.
-- So the summary line is now reachable only when all eight legs genuinely ran.
--
-- NOT COVERED HERE, deliberately (flagged rather than silently dropped): the SMI-6598
-- revert-and-confirm-fails verification -- reverting team_invitations_select_manager back to
-- team_invitations_select_member and confirming I-1/I-3 go red, and separately reverting the
-- REVOKE SELECT/GRANT SELECT column pair and confirming I-2's "admin reading token is refused"
-- half goes red -- was NOT run while writing this file, because the task that produced it was
-- explicitly forbidden from applying 20261004000001 anywhere (no `supabase db push`, no local
-- apply). Whoever applies that migration must run this verification before trusting these
-- tests, per CLAUDE.md's "a regression test you have not run against the unfixed code is
-- unverified" rule (SMI-6598).

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = 'notice';

-- =============================================================================
-- ### I-1: a plain member selecting team_invitations gets zero rows.
-- =============================================================================
BEGIN;
DO $$
DECLARE
  v_owner    UUID := gen_random_uuid();
  v_member   UUID := gen_random_uuid();
  v_team     TEXT;
  v_role_ok  BOOLEAN;
  v_rowcount INTEGER;
BEGIN
  INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  VALUES
    (v_owner,  'i1-owner@example.com',  '{"provider":"email"}'::jsonb, '{}'::jsonb),
    (v_member, 'i1-member@example.com', '{"provider":"email"}'::jsonb, '{}'::jsonb);

  INSERT INTO teams (name, owner_id) VALUES ('I1 Team', v_owner) RETURNING id INTO v_team;
  INSERT INTO team_members (team_id, user_id, role) VALUES (v_team, v_member, 'member');
  INSERT INTO team_invitations (team_id, invited_email, role, token, invited_by)
  VALUES (v_team, 'i1-invitee@example.com', 'member', repeat('a', 32), v_owner);

  v_role_ok := (to_regrole('authenticated') IS NOT NULL);
  IF v_role_ok THEN
    v_role_ok := pg_has_role(current_user, 'authenticated', 'MEMBER');
  END IF;

  IF NOT v_role_ok THEN
    RAISE EXCEPTION 'I-1 NOT VERIFIED: % cannot SET ROLE authenticated in this environment',
      current_user;
  ELSE
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_member::text, 'role', 'authenticated')::text, true);
    DISCARD PLANS;

    BEGIN
      SET LOCAL ROLE authenticated;
      -- Exactly listPending()'s column list -- `SELECT *` would hit the `token`
      -- column-privilege wall for EVERY authenticated caller, manager or not, which would
      -- prove column lockdown, not row-policy exclusion. This is the row-policy test.
      SELECT count(*) INTO v_rowcount
        FROM (SELECT id, invited_email, role, expires_at, created_at, invited_by
                FROM team_invitations WHERE team_id = v_team) x;
      RESET ROLE;
    EXCEPTION WHEN OTHERS THEN
      RESET ROLE;
      RAISE EXCEPTION 'I-1 FAIL: member SELECT raised % (%) -- expected zero rows, not an error',
        SQLSTATE, SQLERRM;
    END;

    IF v_rowcount <> 0 THEN
      RAISE EXCEPTION 'I-1 FAIL: plain member saw % row(s); expected 0', v_rowcount;
    END IF;
  END IF;

  RAISE NOTICE 'I-1 PASS';
END $$;
ROLLBACK;

-- =============================================================================
-- ### I-2: THE CRITICAL PAIR. An admin selecting `token` is refused; the same admin
-- selecting `invited_email` succeeds. A member-only zero-rows assertion (I-1) would pass
-- against a decorative column grant, because the row policy already hides every row from a
-- plain member -- this pair is what actually exercises the column layer, from an actor the
-- row policy admits (design §3.7 "A test must pin the mechanism, not just the outcome").
-- =============================================================================
BEGIN;
DO $$
DECLARE
  v_owner        UUID := gen_random_uuid();
  v_admin        UUID := gen_random_uuid();
  v_team         TEXT;
  v_invitation   TEXT;
  v_role_ok      BOOLEAN;
  v_token_raised BOOLEAN := FALSE;
  v_email_seen   TEXT;
BEGIN
  INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  VALUES
    (v_owner, 'i2-owner@example.com', '{"provider":"email"}'::jsonb, '{}'::jsonb),
    (v_admin, 'i2-admin@example.com', '{"provider":"email"}'::jsonb, '{}'::jsonb);

  INSERT INTO teams (name, owner_id) VALUES ('I2 Team', v_owner) RETURNING id INTO v_team;
  INSERT INTO team_members (team_id, user_id, role) VALUES (v_team, v_admin, 'admin');
  INSERT INTO team_invitations (team_id, invited_email, role, token, invited_by)
  VALUES (v_team, 'i2-invitee@example.com', 'member', repeat('b', 32), v_owner)
  RETURNING id INTO v_invitation;

  v_role_ok := (to_regrole('authenticated') IS NOT NULL);
  IF v_role_ok THEN
    v_role_ok := pg_has_role(current_user, 'authenticated', 'MEMBER');
  END IF;

  IF NOT v_role_ok THEN
    RAISE EXCEPTION 'I-2 NOT VERIFIED: % cannot SET ROLE authenticated in this environment',
      current_user;
  ELSE
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_admin::text, 'role', 'authenticated')::text, true);
    DISCARD PLANS;

    -- Half A: admin's row IS visible (has_team_permission is true for admin), so this must
    -- fail on the COLUMN grant, not the row policy -- a 42501 naming the privilege, not zero
    -- rows.
    -- No sentinel RAISE after the PERFORM. An earlier version put one here, and it was
    -- self-defeating: it raised P0001 *inside* the block whose own `WHEN OTHERS` arm below
    -- re-raises anything that is not insufficient_privilege as "raised % -- expected
    -- insufficient_privilege (42501)". So the one failure this pair exists to catch got
    -- reported as the wrong failure class, and the correctly-worded assertion after the block
    -- (`IF NOT v_token_raised`) became unreachable dead code. The success path now simply
    -- falls through with v_token_raised still FALSE, and that assertion does the work.
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM token FROM team_invitations WHERE id = v_invitation;
      RESET ROLE;
    EXCEPTION
      WHEN insufficient_privilege THEN
        RESET ROLE;
        v_token_raised := TRUE;
      WHEN OTHERS THEN
        RESET ROLE;
        RAISE EXCEPTION 'I-2 FAIL: admin SELECT of `token` raised % (%) -- expected '
                        'insufficient_privilege (42501)', SQLSTATE, SQLERRM;
    END;

    IF NOT v_token_raised THEN
      RAISE EXCEPTION 'I-2 FAIL: admin SELECT of `token` succeeded -- the column grant did not '
                      'take. This is exactly the REVOKE SELECT (token) no-op the design warns '
                      'about: a table-level SELECT grant permits every column, and a '
                      'column-level REVOKE cannot subtract from it, so the privilege check '
                      'never consults the column ACL. Check that the migration revokes at the '
                      'TABLE level first and re-grants an explicit column allowlist.';
    END IF;

    -- Half B: same admin, `invited_email` succeeds -- proves Half A was the column grant
    -- working as designed, not RLS denying the admin outright.
    DISCARD PLANS;
    BEGIN
      SET LOCAL ROLE authenticated;
      SELECT invited_email INTO v_email_seen
        FROM team_invitations WHERE id = v_invitation;
      RESET ROLE;
    EXCEPTION WHEN OTHERS THEN
      RESET ROLE;
      RAISE EXCEPTION 'I-2 FAIL: admin SELECT of `invited_email` raised % (%) -- expected '
                      'success', SQLSTATE, SQLERRM;
    END;

    IF v_email_seen IS DISTINCT FROM 'i2-invitee@example.com' THEN
      RAISE EXCEPTION 'I-2 FAIL: admin read invited_email as % -- expected i2-invitee@example.com',
        COALESCE(v_email_seen, '<null>');
    END IF;
  END IF;

  RAISE NOTICE 'I-2 PASS';
END $$;
ROLLBACK;

-- =============================================================================
-- ### I-3: an owner AND an admin each still see the team's pending invites, with
-- invited_email (design §3.7 Tests list). Also covers I-5's "listPending's six columns are
-- all inside the allowlist" via the exact column list listPending() selects.
-- =============================================================================
BEGIN;
DO $$
DECLARE
  v_owner      UUID := gen_random_uuid();
  v_admin      UUID := gen_random_uuid();
  v_team       TEXT;
  v_role_ok    BOOLEAN;
  v_rowcount   INTEGER;
  v_email_seen TEXT;
BEGIN
  INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  VALUES
    (v_owner, 'i3-owner@example.com', '{"provider":"email"}'::jsonb, '{}'::jsonb),
    (v_admin, 'i3-admin@example.com', '{"provider":"email"}'::jsonb, '{}'::jsonb);

  INSERT INTO teams (name, owner_id) VALUES ('I3 Team', v_owner) RETURNING id INTO v_team;
  -- has_team_permission() reads team_members, NOT teams.owner_id -- an owner needs their own
  -- team_members row (role='owner') or the owner short-circuit never fires (EXISTS(SELECT 1
  -- FROM me) would be false). Precedent: 20260828000001_team_sso_settings.sql:565.
  INSERT INTO team_members (team_id, user_id, role) VALUES (v_team, v_owner, 'owner');
  INSERT INTO team_members (team_id, user_id, role) VALUES (v_team, v_admin, 'admin');
  INSERT INTO team_invitations (team_id, invited_email, role, token, invited_by)
  VALUES (v_team, 'i3-invitee@example.com', 'member', repeat('c', 32), v_owner);

  v_role_ok := (to_regrole('authenticated') IS NOT NULL);
  IF v_role_ok THEN
    v_role_ok := pg_has_role(current_user, 'authenticated', 'MEMBER');
  END IF;

  IF NOT v_role_ok THEN
    RAISE EXCEPTION 'I-3 NOT VERIFIED: % cannot SET ROLE authenticated in this environment',
      current_user;
  ELSE
    -- Owner, via the owner short-circuit in has_team_permission().
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_owner::text, 'role', 'authenticated')::text, true);
    DISCARD PLANS;
    BEGIN
      SET LOCAL ROLE authenticated;
      -- Exactly listPending()'s column list (team-invitations.ts:207..209), minus the
      -- profiles join (tested by the website's own suite, not this migration).
      SELECT count(*), max(invited_email) INTO v_rowcount, v_email_seen
        FROM (SELECT id, invited_email, role, expires_at, created_at, invited_by
                FROM team_invitations WHERE team_id = v_team AND status = 'pending') x;
      RESET ROLE;
    EXCEPTION WHEN OTHERS THEN
      RESET ROLE;
      RAISE EXCEPTION 'I-3 FAIL: owner SELECT raised % (%)', SQLSTATE, SQLERRM;
    END;
    IF v_rowcount <> 1 OR v_email_seen IS DISTINCT FROM 'i3-invitee@example.com' THEN
      RAISE EXCEPTION 'I-3 FAIL: owner should see 1 row with invited_email i3-invitee@example.com; '
                      'got % row(s), invited_email %', v_rowcount, COALESCE(v_email_seen, '<null>');
    END IF;

    -- Admin, via default_role_permission('admin', 'team:manage_members') = true.
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_admin::text, 'role', 'authenticated')::text, true);
    DISCARD PLANS;
    BEGIN
      SET LOCAL ROLE authenticated;
      SELECT count(*), max(invited_email) INTO v_rowcount, v_email_seen
        FROM (SELECT id, invited_email, role, expires_at, created_at, invited_by
                FROM team_invitations WHERE team_id = v_team AND status = 'pending') x;
      RESET ROLE;
    EXCEPTION WHEN OTHERS THEN
      RESET ROLE;
      RAISE EXCEPTION 'I-3 FAIL: admin SELECT raised % (%)', SQLSTATE, SQLERRM;
    END;
    IF v_rowcount <> 1 OR v_email_seen IS DISTINCT FROM 'i3-invitee@example.com' THEN
      RAISE EXCEPTION 'I-3 FAIL: admin should see 1 row with invited_email i3-invitee@example.com; '
                      'got % row(s), invited_email %', v_rowcount, COALESCE(v_email_seen, '<null>');
    END IF;
  END IF;

  RAISE NOTICE 'I-3 PASS';
END $$;
ROLLBACK;

-- =============================================================================
-- ### I-4: accept_team_invitation still works for the invitee -- "this is the regression
-- that matters" (design §3.7): the invitee is typically not yet a member of the team at all,
-- so a row-policy check (if this RPC were not SECURITY DEFINER) would exclude them outright.
-- Run against the real deployed ownership/RLS configuration rather than trusting the
-- argument: team_invitations and accept_team_invitation are both postgres-owned, and
-- relforcerowsecurity is false, which is what this test actually exercises.
-- =============================================================================
BEGIN;
DO $$
DECLARE
  v_owner      UUID := gen_random_uuid();
  v_invitee    UUID := gen_random_uuid();
  v_team       TEXT;
  v_token      TEXT := repeat('d', 32);
  v_role_ok    BOOLEAN;
  v_result     JSONB;
  v_status     TEXT;
  v_member_cnt INTEGER;
BEGIN
  INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  VALUES
    (v_owner,   'i4-owner@example.com',   '{"provider":"email"}'::jsonb, '{}'::jsonb),
    (v_invitee, 'i4-invitee@example.com', '{"provider":"email"}'::jsonb, '{}'::jsonb);

  INSERT INTO teams (name, owner_id) VALUES ('I4 Team', v_owner) RETURNING id INTO v_team;
  -- Deliberately NO team_members row for v_invitee -- the whole point of this test.
  INSERT INTO team_invitations (team_id, invited_email, role, token, invited_by)
  VALUES (v_team, 'i4-invitee@example.com', 'member', v_token, v_owner);

  v_role_ok := (to_regrole('authenticated') IS NOT NULL);
  IF v_role_ok THEN
    v_role_ok := pg_has_role(current_user, 'authenticated', 'MEMBER');
  END IF;

  IF NOT v_role_ok THEN
    RAISE EXCEPTION 'I-4 NOT VERIFIED: % cannot SET ROLE authenticated in this environment',
      current_user;
  ELSE
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_invitee::text, 'role', 'authenticated')::text, true);
    DISCARD PLANS;
    BEGIN
      SET LOCAL ROLE authenticated;
      SELECT accept_team_invitation(v_token) INTO v_result;
      RESET ROLE;
    EXCEPTION WHEN OTHERS THEN
      RESET ROLE;
      RAISE EXCEPTION 'I-4 FAIL: accept_team_invitation raised % (%) -- the invitee acceptance '
                      'path is broken', SQLSTATE, SQLERRM;
    END;

    IF v_result ->> 'team_id' IS DISTINCT FROM v_team THEN
      RAISE EXCEPTION 'I-4 FAIL: accept_team_invitation returned team_id %, expected %',
        v_result ->> 'team_id', v_team;
    END IF;

    SELECT status INTO v_status FROM team_invitations WHERE token = v_token;
    IF v_status IS DISTINCT FROM 'accepted' THEN
      RAISE EXCEPTION 'I-4 FAIL: invitation status is % after accept, expected accepted', v_status;
    END IF;

    SELECT count(*) INTO v_member_cnt
      FROM team_members WHERE team_id = v_team AND user_id = v_invitee AND role = 'member';
    IF v_member_cnt <> 1 THEN
      RAISE EXCEPTION 'I-4 FAIL: expected exactly 1 team_members row for the invitee; found %',
        v_member_cnt;
    END IF;
  END IF;

  RAISE NOTICE 'I-4 PASS';
END $$;
ROLLBACK;

-- =============================================================================
-- ### I-5: privilege-catalog sweep. has_table_privilege/has_column_privilege for anon and
-- authenticated covering all eight PostgreSQL 17 table-level privilege kinds (SELECT, INSERT,
-- UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN), so the TRUNCATE revoke -- the one
-- RLS cannot reach at all -- cannot silently fail to apply; plus the column-level SELECT shape
-- (ten columns granted, `token` not).
-- =============================================================================
BEGIN;
DO $$
DECLARE
  v_role TEXT;
  v_priv TEXT;
  v_col  TEXT;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
                                  'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
      IF has_table_privilege(v_role, 'public.team_invitations', v_priv) IS NOT FALSE THEN
        RAISE EXCEPTION 'I-5 FAIL: % still holds table-level % on team_invitations', v_role, v_priv;
      END IF;
    END LOOP;
  END LOOP;

  -- authenticated: exactly the ten-column allowlist is SELECT-able; `token` is not.
  FOREACH v_col IN ARRAY ARRAY['id', 'team_id', 'invited_email', 'role', 'invited_by', 'status',
                               'expires_at', 'created_at', 'accepted_at', 'accepted_by'] LOOP
    IF has_column_privilege('authenticated', 'public.team_invitations', v_col, 'SELECT')
       IS NOT TRUE THEN
      RAISE EXCEPTION 'I-5 FAIL: authenticated lost column-SELECT on %', v_col;
    END IF;
  END LOOP;
  IF has_column_privilege('authenticated', 'public.team_invitations', 'token', 'SELECT')
     IS NOT FALSE THEN
    RAISE EXCEPTION 'I-5 FAIL: authenticated can still SELECT token';
  END IF;

  -- anon: no column-level SELECT at all (it never gets the table-wide grant back).
  IF has_column_privilege('anon', 'public.team_invitations', 'invited_email', 'SELECT')
     IS NOT FALSE THEN
    RAISE EXCEPTION 'I-5 FAIL: anon can still SELECT invited_email';
  END IF;

  -- listPending() (team-invitations.ts:207..209) selects exactly these six columns -- every
  -- one must be inside the allowlist above (design §3.7 Tests list, explicit bullet).
  FOREACH v_col IN ARRAY ARRAY['id', 'invited_email', 'role', 'expires_at', 'created_at',
                               'invited_by'] LOOP
    IF has_column_privilege('authenticated', 'public.team_invitations', v_col, 'SELECT')
       IS NOT TRUE THEN
      RAISE EXCEPTION 'I-5 FAIL: listPending() column % is not in the authenticated allowlist',
        v_col;
    END IF;
  END LOOP;

  RAISE NOTICE 'I-5 PASS';
END $$;
ROLLBACK;

-- =============================================================================
-- ### I-6 / I-7: the SSO freshness gate, fresh vs stale, written now while no `sso`-
-- provisioned team_members row exists in prod (measured 2026-10-03: provisioned_via is
-- billing (3), invite (2), manual (2) -- zero sso) so the first real SSO admin is not the
-- test. Uses has_team_permission()'s existing gate (20260828000001); default
-- reverify_days = 7 via COALESCE when no team_sso_settings row exists, which is the case for
-- this fixture team.
-- =============================================================================

-- I-6: a FRESH sso-provisioned admin sees the pending list.
BEGIN;
DO $$
DECLARE
  v_owner    UUID := gen_random_uuid();
  v_admin    UUID := gen_random_uuid();
  v_team     TEXT;
  v_role_ok  BOOLEAN;
  v_rowcount INTEGER;
BEGIN
  INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  VALUES
    (v_owner, 'i6-owner@example.com', '{"provider":"email"}'::jsonb, '{}'::jsonb),
    (v_admin, 'i6-admin@example.com', '{"provider":"email"}'::jsonb, '{}'::jsonb);

  INSERT INTO teams (name, owner_id) VALUES ('I6 Team', v_owner) RETURNING id INTO v_team;
  INSERT INTO team_members (team_id, user_id, role, provisioned_via, sso_verified_at)
  VALUES (v_team, v_admin, 'admin', 'sso', now()); -- fresh: well inside the 7-day default
  INSERT INTO team_invitations (team_id, invited_email, role, token, invited_by)
  VALUES (v_team, 'i6-invitee@example.com', 'member', repeat('e', 32), v_owner);

  v_role_ok := (to_regrole('authenticated') IS NOT NULL);
  IF v_role_ok THEN
    v_role_ok := pg_has_role(current_user, 'authenticated', 'MEMBER');
  END IF;

  IF NOT v_role_ok THEN
    RAISE EXCEPTION 'I-6 NOT VERIFIED: % cannot SET ROLE authenticated in this environment',
      current_user;
  ELSE
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_admin::text, 'role', 'authenticated')::text, true);
    DISCARD PLANS;
    BEGIN
      SET LOCAL ROLE authenticated;
      SELECT count(*) INTO v_rowcount
        FROM (SELECT id FROM team_invitations WHERE team_id = v_team AND status = 'pending') x;
      RESET ROLE;
    EXCEPTION WHEN OTHERS THEN
      RESET ROLE;
      RAISE EXCEPTION 'I-6 FAIL: fresh sso admin SELECT raised % (%)', SQLSTATE, SQLERRM;
    END;
    IF v_rowcount <> 1 THEN
      RAISE EXCEPTION 'I-6 FAIL: fresh sso admin should see 1 pending invite; saw %', v_rowcount;
    END IF;
  END IF;

  RAISE NOTICE 'I-6 PASS';
END $$;
ROLLBACK;

-- I-7: a STALE sso-provisioned admin does NOT see the pending list (loses invite visibility
-- intentionally, per design §3.7's durable decision).
BEGIN;
DO $$
DECLARE
  v_owner    UUID := gen_random_uuid();
  v_admin    UUID := gen_random_uuid();
  v_team     TEXT;
  v_role_ok  BOOLEAN;
  v_rowcount INTEGER;
BEGIN
  INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  VALUES
    (v_owner, 'i7-owner@example.com', '{"provider":"email"}'::jsonb, '{}'::jsonb),
    (v_admin, 'i7-admin@example.com', '{"provider":"email"}'::jsonb, '{}'::jsonb);

  INSERT INTO teams (name, owner_id) VALUES ('I7 Team', v_owner) RETURNING id INTO v_team;
  INSERT INTO team_members (team_id, user_id, role, provisioned_via, sso_verified_at)
  VALUES (v_team, v_admin, 'admin', 'sso', now() - interval '10 days'); -- stale: past the
                                                                         -- 7-day default
  INSERT INTO team_invitations (team_id, invited_email, role, token, invited_by)
  VALUES (v_team, 'i7-invitee@example.com', 'member', repeat('f', 32), v_owner);

  v_role_ok := (to_regrole('authenticated') IS NOT NULL);
  IF v_role_ok THEN
    v_role_ok := pg_has_role(current_user, 'authenticated', 'MEMBER');
  END IF;

  IF NOT v_role_ok THEN
    RAISE EXCEPTION 'I-7 NOT VERIFIED: % cannot SET ROLE authenticated in this environment',
      current_user;
  ELSE
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_admin::text, 'role', 'authenticated')::text, true);
    DISCARD PLANS;
    BEGIN
      SET LOCAL ROLE authenticated;
      SELECT count(*) INTO v_rowcount
        FROM (SELECT id FROM team_invitations WHERE team_id = v_team AND status = 'pending') x;
      RESET ROLE;
    EXCEPTION WHEN OTHERS THEN
      RESET ROLE;
      RAISE EXCEPTION 'I-7 FAIL: stale sso admin SELECT raised % (%)', SQLSTATE, SQLERRM;
    END;
    IF v_rowcount <> 0 THEN
      RAISE EXCEPTION 'I-7 FAIL: stale sso admin should see 0 pending invites; saw %', v_rowcount;
    END IF;
  END IF;

  RAISE NOTICE 'I-7 PASS';
END $$;
ROLLBACK;

-- =============================================================================
-- ### I-8: one post-change smoke call for each of the other four SECURITY DEFINER write
-- paths (accept_team_invitation is I-4's own test, not repeated here) -- confirms none of
-- them was broken by the privilege/policy changes above, since each executes as the table
-- owner (postgres) regardless of what anon/authenticated hold.
-- =============================================================================
BEGIN;
DO $$
DECLARE
  v_owner        UUID := gen_random_uuid();
  v_team         TEXT;
  v_invitation   TEXT;
  v_role_ok      BOOLEAN;
  v_create       JSONB;
  v_resend       JSONB;
  v_status       TEXT;
  v_cleanup_cnt  INTEGER;
  v_sso_result   JSONB;
  v_expired_tok  TEXT := repeat('g', 32);
BEGIN
  INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (v_owner, 'i8-owner@example.com', '{"provider":"email"}'::jsonb, '{}'::jsonb);
  INSERT INTO teams (name, owner_id) VALUES ('I8 Team', v_owner) RETURNING id INTO v_team;
  -- create_team_invitation/revoke_team_invitation/resend_team_invitation_email_check all
  -- check team_members by role literal, NOT teams.owner_id -- see I-3's identical note.
  INSERT INTO team_members (team_id, user_id, role) VALUES (v_team, v_owner, 'owner');

  v_role_ok := (to_regrole('authenticated') IS NOT NULL);
  IF v_role_ok THEN
    v_role_ok := pg_has_role(current_user, 'authenticated', 'MEMBER');
  END IF;

  IF NOT v_role_ok THEN
    RAISE EXCEPTION 'I-8 NOT VERIFIED (create/revoke/resend/record_sso_login legs): % cannot SET '
                 'ROLE authenticated in this environment', current_user;
  ELSE
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_owner::text, 'role', 'authenticated')::text, true);
    DISCARD PLANS;

    -- (a) create_team_invitation -- owner inviting a brand-new email.
    BEGIN
      SET LOCAL ROLE authenticated;
      SELECT create_team_invitation(v_team, 'i8-invitee@example.com', 'member') INTO v_create;
      RESET ROLE;
    EXCEPTION WHEN OTHERS THEN
      RESET ROLE;
      RAISE EXCEPTION 'I-8 FAIL (create_team_invitation): raised % (%)', SQLSTATE, SQLERRM;
    END;
    IF v_create ->> 'invitation_id' IS NULL THEN
      RAISE EXCEPTION 'I-8 FAIL (create_team_invitation): no invitation_id in result %', v_create;
    END IF;
    v_invitation := v_create ->> 'invitation_id';

    -- (b) resend_team_invitation_email_check -- owner, on the invitation just created.
    DISCARD PLANS;
    BEGIN
      SET LOCAL ROLE authenticated;
      SELECT resend_team_invitation_email_check(v_invitation) INTO v_resend;
      RESET ROLE;
    EXCEPTION WHEN OTHERS THEN
      RESET ROLE;
      RAISE EXCEPTION 'I-8 FAIL (resend_team_invitation_email_check): raised % (%)',
        SQLSTATE, SQLERRM;
    END;
    IF (v_resend ->> 'ok') IS DISTINCT FROM 'true'
       OR v_resend ->> 'invited_email' IS DISTINCT FROM 'i8-invitee@example.com' THEN
      RAISE EXCEPTION 'I-8 FAIL (resend_team_invitation_email_check): unexpected result %',
        v_resend;
    END IF;

    -- (c) revoke_team_invitation -- owner, same invitation.
    DISCARD PLANS;
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM revoke_team_invitation(v_invitation);
      RESET ROLE;
    EXCEPTION WHEN OTHERS THEN
      RESET ROLE;
      RAISE EXCEPTION 'I-8 FAIL (revoke_team_invitation): raised % (%)', SQLSTATE, SQLERRM;
    END;
    SELECT status INTO v_status FROM team_invitations WHERE id = v_invitation;
    IF v_status IS DISTINCT FROM 'revoked' THEN
      RAISE EXCEPTION 'I-8 FAIL (revoke_team_invitation): status is % after revoke, expected '
                      'revoked', v_status;
    END IF;

    -- (d) record_sso_login -- owner, no SSO session bound (sso_session_binding() refuses
    -- gracefully for a non-SSO JWT, per design: this is a smoke call that the write path is
    -- still reachable, not a full SSO-session test, which needs team_sso_settings +
    -- GoTrue-shaped SAML claims out of scope here).
    DISCARD PLANS;
    BEGIN
      SET LOCAL ROLE authenticated;
      SELECT record_sso_login() INTO v_sso_result;
      RESET ROLE;
    EXCEPTION WHEN OTHERS THEN
      RESET ROLE;
      RAISE EXCEPTION 'I-8 FAIL (record_sso_login): raised % (%)', SQLSTATE, SQLERRM;
    END;
    IF v_sso_result ->> 'status' IS DISTINCT FROM 'refused' THEN
      RAISE EXCEPTION 'I-8 FAIL (record_sso_login): expected status=refused for a non-SSO '
                      'session; got %', v_sso_result;
    END IF;
  END IF;

  -- (e) cleanup_expired_team_invitations -- the cron sweep (`daily-team-invitations-cleanup`,
  -- 30 3 * * *). GRANTed to service_role only, so this runs as the connecting (superuser)
  -- role rather than via SET ROLE authenticated -- superusers bypass GRANT checks, which is
  -- fine here: the point is confirming this definer function's own table access still works
  -- after steps 1-3 of the migration, not re-testing who may call it.
  INSERT INTO team_invitations (team_id, invited_email, role, token, invited_by, expires_at)
  VALUES (v_team, 'i8-expired@example.com', 'member', v_expired_tok, v_owner,
          now() - interval '1 day');

  SELECT cleanup_expired_team_invitations() INTO v_cleanup_cnt;
  IF v_cleanup_cnt < 1 THEN
    RAISE EXCEPTION 'I-8 FAIL (cleanup_expired_team_invitations): returned %, expected >= 1',
      v_cleanup_cnt;
  END IF;
  IF EXISTS (SELECT 1 FROM team_invitations WHERE token = v_expired_tok) THEN
    RAISE EXCEPTION 'I-8 FAIL (cleanup_expired_team_invitations): expired fixture row survived';
  END IF;

  RAISE NOTICE 'I-8 PASS';
END $$;
ROLLBACK;

-- =============================================================================
-- Summary -- and it ASSERTS before it congratulates.
--
-- This block used to be an unconditional `RAISE NOTICE 'All ... passed'`. That is safe only
-- while `ON_ERROR_STOP` is on, because then the first failure aborts the run before reaching
-- here -- and this file sets it on at line 39, so under the documented invocation the summary
-- was honest. It was one flag away from not being: MEASURED during the SMI-6598 mutation pass
-- below, running this file with `ON_ERROR_STOP` off printed two genuine `I-2`/`I-5 FAIL` lines
-- and then `All team_invitations manager-only-select tests passed` underneath them.
--
-- That is the same defect class as the per-assertion one fixed in this commit (a PASS line
-- reachable on a path that asserted nothing), just one level up -- and it was found inside the
-- fix for that one, which is the pattern CLAUDE.md warns to expect after any silent-success fix.
-- The summary now re-checks the catalog-level invariants itself, so the congratulation is
-- backed by an assertion in the same block that prints it, whatever ON_ERROR_STOP says.
--
-- Deliberately only the catalog-level half: these need no fixtures and no role switching, so
-- this block cannot itself self-skip. The row-policy behaviour is I-1..I-4's job.
-- =============================================================================
DO $$
DECLARE
  v_cols INTEGER;
BEGIN
  IF has_table_privilege('authenticated', 'public.team_invitations', 'SELECT') THEN
    RAISE EXCEPTION 'SUMMARY REFUSED: authenticated holds table-level SELECT, which makes the '
                    'column allowlist a no-op';
  END IF;
  IF has_column_privilege('authenticated', 'public.team_invitations', 'token', 'SELECT') THEN
    RAISE EXCEPTION 'SUMMARY REFUSED: authenticated can SELECT team_invitations.token';
  END IF;
  -- Paired presence check: the two denials above would both be satisfied by a table nobody can
  -- read at all, which would mean the feature is broken in the other direction.
  IF NOT has_column_privilege('authenticated', 'public.team_invitations',
                              'invited_email', 'SELECT') THEN
    RAISE EXCEPTION 'SUMMARY REFUSED: authenticated cannot SELECT invited_email, so the column '
                    'allowlist did not land -- the denials above are not evidence of anything';
  END IF;

  SELECT count(*) INTO v_cols FROM information_schema.column_privileges
   WHERE table_schema = 'public' AND table_name = 'team_invitations'
     AND grantee = 'authenticated' AND privilege_type = 'SELECT';
  IF v_cols <> 10 THEN
    RAISE EXCEPTION 'SUMMARY REFUSED: expected exactly 10 granted columns, found %', v_cols;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                   AND tablename = 'team_invitations'
                   AND policyname = 'team_invitations_select_manager') THEN
    RAISE EXCEPTION 'SUMMARY REFUSED: policy team_invitations_select_manager is absent';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
               AND tablename = 'team_invitations'
               AND policyname = 'team_invitations_select_member') THEN
    RAISE EXCEPTION 'SUMMARY REFUSED: the superseded policy team_invitations_select_member is '
                    'still present';
  END IF;

  RAISE NOTICE 'All team_invitations manager-only-select tests passed';
END $$;
