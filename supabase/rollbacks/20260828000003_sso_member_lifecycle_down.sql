-- Rollback for 20260828000003_sso_member_lifecycle.sql
-- SMI-6205 (Wave 4 of SMI-6200)
--
-- Unschedules the daily SSO expiry sweep, drops the twelve functions, the
-- sso_account_links table and the profiles(lower(email)) index this wave added,
-- and restores the four functions it replaced (accept_team_invitation,
-- ensure_team_for_subscription, create_team_invitation,
-- list_team_members_with_profile) to their pre-Wave-4 definitions verbatim.
-- Safe to apply via `supabase db execute --file`.
--
-- ============================================================================
-- WARNINGS -- READ BEFORE RUNNING
-- ============================================================================
--
-- 1. THIS STOPS AUTOMATIC REVOCATION ENTIRELY. expire_stale_sso_members() is the
--    load-bearing mechanism of the whole SSO deprovisioning story: Supabase sends
--    no deprovisioning signal, so absence of continued proof-of-employment is the
--    ONLY thing that expires access. With this rolled back, an employee removed at
--    the IdP keeps their team_members row forever. Wave 3's freshness gate on
--    has_team_permission()/team_ids_with_permission() still denies them at query
--    time IF their row is provisioned_via='sso' and their stamp goes stale -- so
--    permissions do still lapse -- but nothing ever removes the row, nothing
--    revokes their license keys, and nothing schedules the ADR-126 inventory purge.
--
-- 2. ORDER MATTERS AGAINST WAVE 3. Do NOT roll Wave 3
--    (20260828000001_team_sso_settings.sql) back first: its freshness gate is what
--    still denies a stale SSO member after this file removes the sweep. Rolling
--    Wave 3 back while provisioned_via='sso' rows exist silently restores
--    non-freshness-gated SSO permission behavior for every one of them.
--
-- 3. THE provisioned_via BACKFILL IS NOT REVERSED, AND CANNOT BE. Section 9d of
--    the forward migration rewrote existing rows from 'manual' to 'invite'/'billing'
--    based on evidence (invitation history, billing linkage) that does not record
--    what the row's value was beforehand. Reverting those rows to 'manual' would be
--    a guess, and the wrong guess re-opens the exact hole Wave 4 closed: with the
--    forward functions dropped and rows back at 'manual', a future re-apply of Wave
--    4 would treat admin-managed members as SSO-managed. The tags are left in place
--    deliberately -- they are accurate provenance regardless of whether the SSO
--    write path exists, and both restored functions below simply stop SETTING the
--    column (new rows fall back to its DEFAULT 'manual'), exactly as before Wave 4.
--    If you genuinely need the pre-backfill values, restore from a backup taken
--    before the forward migration applied.
--
-- 4. LINKED ACCOUNTS ARE NOT UNLINKED. Dropping sso_account_links discards the
--    consent/audit trail for links already executed by link_sso_account(); the
--    entitlement moves and license-key revocations those links performed are NOT
--    undone (audit_logs 'sso:account_linked' rows survive and are the remaining
--    record). Export sso_account_links before running this if that trail matters.
--
-- 5. list_team_members_with_profile() goes back to 8 columns. Any frontend already
--    reading provisioned_via / sso_verified_at from it will break. Roll the
--    website deploy back first.
--
-- 6. create_team_invitation() LOSES THE SHARED SEAT LOCK. Section 9c of the forward
--    migration re-issued it taking pg_advisory_xact_lock('team_seat:<team_id>'),
--    the same key record_sso_login()'s seat guard takes, so the two paths that
--    spend from one seat budget could not both claim the last seat. Section 4 below
--    restores the pre-Wave-4 body verbatim, which drops that line. That is correct
--    rather than merely tolerable: this file also DROPs record_sso_login(), so
--    after a rollback the invitation path is the only seat consumer left and has
--    nothing to be serialized against. If you ever roll this back while leaving an
--    SSO write path in place, re-apply the lock line by hand.
--
-- 7. THE dismissed_at / notified_at COLUMNS GO WITH THE TABLE. Dropping
--    sso_account_links discards which candidates a user had explicitly DECLINED. A
--    re-apply of Wave 4 therefore starts offering those links again. That is the
--    same data-loss class as WARNING 4 and has the same mitigation: export
--    sso_account_links before running this.
--
-- 8. 20260828000004 MUST BE ROLLED BACK FIRST. Its own pre-flight refuses to apply
--    without record_sso_link_consent() and undismiss_sso_link_candidate(), and its
--    two readers select from sso_account_links, which section 3 below drops. Run
--    supabase/rollbacks/20260828000004_sso_link_request_read_down.sql before this
--    file, exactly as the forward migrations apply 3-before-4.

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

-- ============================================================================
-- 1. Unschedule the daily expiry sweep.
-- ============================================================================
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('daily-expire-stale-sso-members')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'daily-expire-stale-sso-members');
  END IF;
END $cron$;

-- ============================================================================
-- 2. Drop the Wave 4 function family.
-- Order: dependents before dependencies (link_sso_account and
-- sso_login_refusal_reason call sso_session_binding(), which calls
-- sso_session_identity(); expire_stale_sso_members() calls sso_reverify_days()
-- and sso_expiry_eligible(); link_sso_account() and record_sso_login() call
-- sso_email_confirmed()).
-- ============================================================================
DROP FUNCTION IF EXISTS link_sso_account(UUID);
DROP FUNCTION IF EXISTS undismiss_sso_link_candidate(UUID);
DROP FUNCTION IF EXISTS dismiss_sso_link_candidate(UUID);
DROP FUNCTION IF EXISTS record_sso_link_consent(UUID);
DROP FUNCTION IF EXISTS record_sso_login();
DROP FUNCTION IF EXISTS sso_login_refusal_reason();
DROP FUNCTION IF EXISTS expire_stale_sso_members();
DROP FUNCTION IF EXISTS sso_map_role(JSONB, JSONB);
DROP FUNCTION IF EXISTS sso_session_binding();
DROP FUNCTION IF EXISTS sso_session_identity();
DROP FUNCTION IF EXISTS sso_reverify_days(TEXT);
DROP FUNCTION IF EXISTS sso_expiry_eligible(TEXT);
DROP FUNCTION IF EXISTS sso_email_confirmed(UUID);

-- ============================================================================
-- 3. Drop the consent table (and the login-path index that only served it).
-- See WARNINGS 4 and 7.
--
-- idx_profiles_email_lower existed solely for record_sso_login()'s candidate
-- lookup, which is dropped above; nothing else in the schema queries
-- lower(profiles.email) through an index. Dropped so a rollback does not leave a
-- write-amplifying index on a high-traffic table behind with no reader.
-- ============================================================================
DROP TABLE IF EXISTS sso_account_links;
DROP INDEX IF EXISTS idx_profiles_email_lower;

-- ============================================================================
-- 4. Restore accept_team_invitation() to its pre-Wave-4 body
-- (20260524000002_team_member_tier_sync.sql:205-322 verbatim -- the ONLY difference
-- from the Wave 4 version is that the team_members INSERT no longer names
-- provisioned_via, so new rows fall back to the column DEFAULT 'manual').
-- ============================================================================
CREATE OR REPLACE FUNCTION accept_team_invitation(p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $accept_team_invitation$
DECLARE
  v_invitation  RECORD;
  v_user_email  TEXT;
  v_team_name   TEXT;
BEGIN
  IF p_token IS NULL OR p_token = '' THEN
    RAISE EXCEPTION 'invalid invitation' USING ERRCODE = '22023';
  END IF;

  SELECT id, team_id, invited_email, role, status, expires_at, created_at, invited_by
    INTO v_invitation
    FROM team_invitations
   WHERE token = p_token
     AND status = 'pending'
   LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid invitation' USING ERRCODE = 'P0002';
  END IF;

  IF v_invitation.expires_at < now() THEN
    UPDATE team_invitations
       SET status = 'expired'
     WHERE id = v_invitation.id
       AND status = 'pending'
       AND TRUE;
    RAISE EXCEPTION 'invitation expired' USING ERRCODE = '22023';
  END IF;

  SELECT lower(email) INTO v_user_email
    FROM profiles
   WHERE id = auth.uid()
   LIMIT 1;

  IF v_user_email IS NULL OR v_user_email = '' THEN
    RAISE EXCEPTION 'invitation is for a different email' USING ERRCODE = '42501';
  END IF;

  IF v_user_email != v_invitation.invited_email THEN
    RAISE EXCEPTION 'invitation is for a different email' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM team_members
     WHERE team_members.team_id = v_invitation.team_id
       AND team_members.user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'already a member' USING ERRCODE = '23505';
  END IF;

  INSERT INTO team_members (team_id, user_id, role, invited_by, invited_at, joined_at)
  VALUES (
    v_invitation.team_id,
    auth.uid(),
    v_invitation.role,
    v_invitation.invited_by,
    v_invitation.created_at,
    now()
  );

  PERFORM recompute_user_tier(auth.uid());

  UPDATE team_invitations
     SET status      = 'accepted',
         accepted_at = now(),
         accepted_by = auth.uid()
   WHERE id = v_invitation.id
     AND status = 'pending'
     AND TRUE;

  SELECT name INTO v_team_name FROM teams WHERE id = v_invitation.team_id LIMIT 1;

  BEGIN
    INSERT INTO audit_logs (event_type, actor, resource, action, result, metadata)
    VALUES (
      'team_invitation:accepted',
      auth.uid()::text,
      'team_invitations/' || v_invitation.id,
      'update',
      'success',
      jsonb_build_object(
        'team_id', v_invitation.team_id,
        'role',    v_invitation.role
      )
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'accept_team_invitation: audit_logs insert failed for invitation %: %',
      v_invitation.id, SQLERRM;
  END;

  RETURN jsonb_build_object(
    'team_id',   v_invitation.team_id,
    'role',      v_invitation.role,
    'team_name', v_team_name
  );
END;
$accept_team_invitation$;

REVOKE ALL ON FUNCTION accept_team_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION accept_team_invitation(TEXT) TO authenticated;

-- ============================================================================
-- 4b. Restore create_team_invitation() to its pre-Wave-4 body
-- (20260520000001_team_invitations.sql:72-207 verbatim -- the ONLY difference from
-- the Wave 4 version is the removed pg_advisory_xact_lock('team_seat:...') line
-- before the seat-count guard). See WARNING 6: correct here because this file also
-- DROPs record_sso_login(), leaving the invitation path as the only seat consumer.
-- Note the search_path is `public, extensions`, NOT `public, pg_temp` -- that is
-- what resolves gen_random_bytes below, and changing it would break token issuance.
-- ============================================================================
CREATE OR REPLACE FUNCTION create_team_invitation(
  p_team_id TEXT,
  p_email   TEXT,
  p_role    TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_email          TEXT;
  v_token          TEXT;
  v_invitation_id  TEXT;
  v_expires_at     TIMESTAMPTZ;
  v_existing       RECORD;
  v_member_count   INT;
  v_pending_count  INT;
  v_max_members    INT;
BEGIN
  IF p_team_id IS NULL OR p_team_id = '' THEN
    RAISE EXCEPTION 'team_id required' USING ERRCODE = '22023';
  END IF;
  IF p_email IS NULL OR trim(p_email) = '' THEN
    RAISE EXCEPTION 'email required' USING ERRCODE = '22023';
  END IF;
  IF p_role NOT IN ('admin', 'member') THEN
    RAISE EXCEPTION 'role must be admin or member' USING ERRCODE = '22023';
  END IF;

  v_email := lower(trim(p_email));

  IF v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RAISE EXCEPTION 'invalid email' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM team_members
     WHERE team_members.team_id = p_team_id
       AND team_members.user_id = auth.uid()
       AND team_members.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'forbidden: only team owners or admins can invite' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM team_members tm
      JOIN profiles p ON p.id = tm.user_id
     WHERE tm.team_id = p_team_id
       AND lower(p.email) = v_email
  ) THEN
    RAISE EXCEPTION 'already a member' USING ERRCODE = '23505';
  END IF;

  SELECT max_members INTO v_max_members FROM teams WHERE id = p_team_id;
  IF v_max_members IS NULL THEN
    RAISE EXCEPTION 'team not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT count(*) INTO v_member_count
    FROM team_members WHERE team_members.team_id = p_team_id;

  SELECT count(*) INTO v_pending_count
    FROM team_invitations
   WHERE team_invitations.team_id = p_team_id
     AND team_invitations.status = 'pending'
     AND team_invitations.expires_at > now();

  IF (v_member_count + v_pending_count) >= v_max_members THEN
    RAISE EXCEPTION 'seat limit reached: % of % seats in use', (v_member_count + v_pending_count), v_max_members
      USING ERRCODE = '53400';
  END IF;

  SELECT id, token, expires_at
    INTO v_existing
    FROM team_invitations
   WHERE team_id = p_team_id
     AND invited_email = v_email
     AND status = 'pending'
     AND expires_at > now()
   LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'invitation_id', v_existing.id,
      'token',         v_existing.token,
      'expires_at',    v_existing.expires_at,
      'resent',        false,
      'status',        'already_pending'
    );
  END IF;

  v_token := translate(encode(gen_random_bytes(24), 'base64'), '+/=', '-_');

  INSERT INTO team_invitations (team_id, invited_email, role, token, invited_by)
  VALUES (p_team_id, v_email, p_role, v_token, auth.uid())
  RETURNING id, expires_at INTO v_invitation_id, v_expires_at;

  BEGIN
    INSERT INTO audit_logs (event_type, actor, resource, action, result, metadata)
    VALUES (
      'team_invitation:created',
      auth.uid()::text,
      'team_invitations/' || v_invitation_id,
      'create',
      'success',
      jsonb_build_object(
        'team_id',    p_team_id,
        'role',       p_role,
        'expires_at', v_expires_at
      )
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'create_team_invitation: audit_logs insert failed for invitation %: %',
      v_invitation_id, SQLERRM;
  END;

  RETURN jsonb_build_object(
    'invitation_id', v_invitation_id,
    'token',         v_token,
    'expires_at',    v_expires_at,
    'resent',        false,
    'status',        'created'
  );
END;
$$;

REVOKE ALL ON FUNCTION create_team_invitation(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_team_invitation(TEXT, TEXT, TEXT) TO authenticated;

-- ============================================================================
-- 5. Restore ensure_team_for_subscription() to its pre-Wave-4 body
-- (073_ensure_team_for_subscription.sql:41-166 verbatim -- the ONLY differences
-- are the two team_members INSERTs no longer naming provisioned_via).
-- ============================================================================
CREATE OR REPLACE FUNCTION ensure_team_for_subscription(p_subscription_id TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $ensure_team_for_subscription$
DECLARE
  v_sub        RECORD;
  v_profile    RECORD;
  v_team_id    TEXT;
  v_team_name  TEXT;
  v_slug_base  TEXT;
  v_slug       TEXT;
  v_attempt    INT := 0;
BEGIN
  IF p_subscription_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT id, user_id, tier, status
    INTO v_sub
    FROM subscriptions
   WHERE id = p_subscription_id
   LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_not_found: %', p_subscription_id USING ERRCODE = 'P0002';
  END IF;

  IF v_sub.tier NOT IN ('team', 'enterprise') THEN
    RETURN NULL;
  END IF;

  SELECT id INTO v_team_id FROM teams WHERE subscription_id = v_sub.id LIMIT 1;

  IF v_team_id IS NOT NULL THEN
    INSERT INTO team_members (team_id, user_id, role, joined_at)
    VALUES (v_team_id, v_sub.user_id, 'owner', NOW())
    ON CONFLICT (team_id, user_id) DO NOTHING;
    RETURN v_team_id;
  END IF;

  SELECT id, email, full_name
    INTO v_profile
    FROM profiles
   WHERE id = v_sub.user_id
   LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile_not_found: %', v_sub.user_id USING ERRCODE = 'P0002';
  END IF;

  v_team_name := COALESCE(
    NULLIF(trim(v_profile.full_name), '') || '''s Team',
    NULLIF(split_part(v_profile.email, '@', 1), '') || '''s Team',
    'Team ' || substr(v_sub.id, 1, 8)
  );
  v_team_name := left(v_team_name, 100);

  v_slug_base := lower(regexp_replace(v_team_name, '[^a-z0-9]+', '-', 'gi'));
  v_slug_base := left(trim(both '-' from v_slug_base), 40);

  IF v_slug_base = '' THEN
    v_slug_base := 'team-' || substr(v_sub.id, 1, 8);
  END IF;

  v_slug := v_slug_base;

  LOOP
    BEGIN
      INSERT INTO teams (name, slug, owner_id, subscription_id)
      VALUES (v_team_name, v_slug, v_sub.user_id, v_sub.id)
      RETURNING id INTO v_team_id;
      EXIT;  -- success
    EXCEPTION WHEN unique_violation THEN
      v_attempt := v_attempt + 1;
      IF v_attempt > 10 THEN
        RAISE EXCEPTION 'slug_collision_exhausted: %', v_slug_base USING ERRCODE = '23505';
      END IF;
      v_slug := v_slug_base || '-' || substr(md5(random()::text), 1, 6);
    END;
  END LOOP;

  INSERT INTO team_members (team_id, user_id, role, joined_at)
  VALUES (v_team_id, v_sub.user_id, 'owner', NOW())
  ON CONFLICT (team_id, user_id) DO NOTHING;

  BEGIN
    INSERT INTO audit_logs (event_type, actor, resource, action, result, metadata)
    VALUES (
      'subscription:team_provisioned',
      'system',
      'teams/' || v_team_id,
      'create',
      'success',
      jsonb_build_object(
        'subscription_id', v_sub.id,
        'user_id', v_sub.user_id,
        'tier', v_sub.tier,
        'team_name', v_team_name,
        'team_slug', v_slug
      )
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'ensure_team_for_subscription: audit_logs insert failed for subscription %, team %: %',
      v_sub.id, v_team_id, SQLERRM;
  END;

  RETURN v_team_id;
END;
$ensure_team_for_subscription$;

REVOKE ALL ON FUNCTION ensure_team_for_subscription(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ensure_team_for_subscription(TEXT) TO service_role;

-- ============================================================================
-- 6. Restore list_team_members_with_profile() to its 8-column shape
-- (20260708205437_team_members_set_github_username_rpc.sql:226-279 verbatim).
--
-- DROP + CREATE again, for the same 42P13 reason the forward migration needed it:
-- shrinking the RETURNS TABLE is an OUT-parameter-list change. The two grant
-- statements after the CREATE are NOT optional -- DROP FUNCTION discards the old
-- object's privileges entirely and Supabase's ALTER DEFAULT PRIVILEGES silently
-- re-grants anon/authenticated EXECUTE on the new one. The assertion at the bottom
-- of this file re-checks it, because silently re-granting anon EXECUTE on a team
-- roster is a cross-tenant disclosure.
-- ============================================================================
DROP FUNCTION IF EXISTS list_team_members_with_profile(TEXT);

CREATE FUNCTION list_team_members_with_profile(p_team_id TEXT)
RETURNS TABLE (
  member_id       TEXT,
  user_id         UUID,
  role            TEXT,
  joined_at       TIMESTAMPTZ,
  invited_at      TIMESTAMPTZ,
  full_name       TEXT,
  email           TEXT,
  github_username TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $list_team_members_with_profile$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM team_members
     WHERE team_members.team_id = p_team_id
       AND team_members.user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'forbidden: not a member of this team' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT
      tm.id             AS member_id,
      tm.user_id        AS user_id,
      tm.role           AS role,
      tm.joined_at      AS joined_at,
      tm.invited_at     AS invited_at,
      p.full_name       AS full_name,
      p.email           AS email,
      tm.github_username AS github_username
    FROM team_members tm
    JOIN profiles p ON p.id = tm.user_id
   WHERE tm.team_id = p_team_id
   ORDER BY
     CASE tm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
     tm.joined_at ASC NULLS LAST;
END;
$list_team_members_with_profile$;

GRANT EXECUTE ON FUNCTION list_team_members_with_profile(TEXT) TO authenticated;
REVOKE EXECUTE ON FUNCTION list_team_members_with_profile(TEXT) FROM anon, PUBLIC;

-- ============================================================================
-- 7. schema_version back to 106.
-- ============================================================================
DELETE FROM schema_version WHERE version = 107;

-- ============================================================================
-- 8. Post-rollback assertions -- confirm the restore actually landed rather than
-- leaving a half-reverted schema behind under incident pressure.
-- ============================================================================
DO $verify$
DECLARE
  v_fn TEXT;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'sso_session_identity', 'sso_session_binding', 'sso_map_role', 'record_sso_login',
    'sso_login_refusal_reason', 'expire_stale_sso_members', 'sso_reverify_days',
    'sso_expiry_eligible', 'sso_email_confirmed',
    'link_sso_account', 'record_sso_link_consent', 'dismiss_sso_link_candidate',
    'undismiss_sso_link_candidate'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = v_fn) THEN
      RAISE EXCEPTION 'ROLLBACK FAIL: %() still exists after the DROPs above', v_fn;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_tables
              WHERE schemaname = 'public' AND tablename = 'sso_account_links') THEN
    RAISE EXCEPTION 'ROLLBACK FAIL: sso_account_links still exists';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.role_routine_grants
              WHERE routine_schema = 'public'
                AND routine_name = 'list_team_members_with_profile'
                AND grantee IN ('anon', 'PUBLIC')) THEN
    RAISE EXCEPTION 'ROLLBACK FAIL: list_team_members_with_profile is anon/PUBLIC-EXECUTE-able '
      'after this file''s DROP+CREATE -- re-run the REVOKE in section 6';
  END IF;

  IF position('provisioned_via' IN
       pg_get_functiondef((SELECT p.oid FROM pg_proc p
                             JOIN pg_namespace n ON n.oid = p.pronamespace
                            WHERE n.nspname = 'public'
                              AND p.proname = 'accept_team_invitation'))) > 0 THEN
    RAISE EXCEPTION 'ROLLBACK FAIL: accept_team_invitation() still sets provisioned_via';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_profiles_email_lower') THEN
    RAISE EXCEPTION 'ROLLBACK FAIL: idx_profiles_email_lower still exists';
  END IF;

  IF position('team_seat:' IN
       pg_get_functiondef((SELECT p.oid FROM pg_proc p
                             JOIN pg_namespace n ON n.oid = p.pronamespace
                            WHERE n.nspname = 'public'
                              AND p.proname = 'create_team_invitation'))) > 0 THEN
    RAISE EXCEPTION 'ROLLBACK FAIL: create_team_invitation() still takes the Wave 4 shared '
      'seat advisory lock -- re-run section 4b';
  END IF;

  RAISE NOTICE 'SMI-6205 rollback verified: 13 functions dropped, sso_account_links + '
    'idx_profiles_email_lower dropped, 4 functions restored, grants re-closed. NOTE: the '
    'provisioned_via backfill was NOT reversed (see WARNING 3 at the top of this file).';
END $verify$;

COMMIT;
