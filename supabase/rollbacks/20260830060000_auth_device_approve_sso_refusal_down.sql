-- Rollback for 20260830060000_auth_device_approve_sso_refusal.sql
-- SMI-6206 (Wave 5 of SMI-6200)
--
-- Restores approve_device_code() and claim_device_token() to their pre-refusal bodies
-- (083's fixed claim_device_token, 081's approve_device_code), drops the new
-- mark_device_code_sso_refused() function, and drops the two new device_codes
-- columns. Safe to apply via `supabase db execute --file`.
--
-- ============================================================================
-- WARNING -- READ BEFORE RUNNING
-- ============================================================================
--
-- THIS REOPENS THE CONFIRMED, LIVE IDP-BYPASS THIS MIGRATION EXISTS TO CLOSE. Once
-- rolled back, an SSO-provisioned user's device-code login again reaches
-- auth-device-token's mintSession(), which (absent a corresponding revert of that edge
-- function's own guard) creates a second, non-SSO auth.users row sharing the SSO
-- user's email (permitted because users_email_partial_key is UNIQUE (email) WHERE
-- (is_sso_user = false)) -- a real credential that bypasses the customer's IdP
-- entirely and survives IdP deprovisioning. Do not roll this back without also
-- reverting supabase/functions/auth-device-token/index.ts's mintSession() guard
-- (checks identities[].provider for an sso:* entry -- NOT an is_sso_user field,
-- which does not exist on GoTrue's admin API response) AND
-- supabase/functions/auth-device-approve/index.ts's second
-- mark_device_code_sso_refused RPC call, in the SAME deploy, and only as a last
-- resort (e.g. this migration itself is the cause of an unrelated outage) -- not
-- as a way to "temporarily" restore device login for SSO users, which is exactly
-- the exposure being closed.

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';

CREATE OR REPLACE FUNCTION public.approve_device_code(
  user_code_input TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_caller_id       UUID;
  v_profile_done    BOOLEAN;
  v_recent_fails    BIGINT;
  v_code_row        RECORD;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'authentication_required';
  END IF;

  -- Gate: caller must have completed their own profile
  SELECT (profile_completed_at IS NOT NULL)
    INTO v_profile_done
    FROM public.profiles
   WHERE id = v_caller_id;

  IF NOT FOUND OR NOT v_profile_done THEN
    RAISE EXCEPTION 'profile_incomplete';
  END IF;

  -- Rate-limit: count recent failed approve attempts by THIS caller in audit_logs.
  SELECT COUNT(*) INTO v_recent_fails
    FROM public.audit_logs
   WHERE event_type = 'auth:device_code:approve_failed'
     AND created_at > NOW() - INTERVAL '10 minutes'
     AND (metadata->>'user_id')::uuid = v_caller_id;

  IF v_recent_fails >= 5 THEN
    INSERT INTO public.audit_logs (event_type, metadata)
    VALUES (
      'auth:device_code:approve_failed',
      jsonb_build_object('reason', 'too_many_attempts', 'user_id', v_caller_id)
    );
    RAISE EXCEPTION 'too_many_attempts';
  END IF;

  -- Find the code row
  SELECT * INTO v_code_row
    FROM public.device_codes
   WHERE user_code = user_code_input
     AND expires_at > NOW()
     AND consumed_at IS NULL
     AND approved_at IS NULL;

  IF NOT FOUND THEN
    INSERT INTO public.audit_logs (event_type, metadata)
    VALUES (
      'auth:device_code:approve_failed',
      jsonb_build_object(
        'reason', 'invalid_user_code',
        'user_code_prefix', left(user_code_input, 4),
        'user_id', v_caller_id
      )
    );
    RAISE EXCEPTION 'invalid_user_code';
  END IF;

  -- Approve (atomic: AND approved_at IS NULL prevents concurrent double-approval)
  UPDATE public.device_codes
     SET user_id     = v_caller_id,
         approved_at = NOW()
   WHERE user_code   = user_code_input
     AND approved_at IS NULL;

  IF NOT FOUND THEN
    INSERT INTO public.audit_logs (event_type, metadata)
    VALUES (
      'auth:device_code:approve_failed',
      jsonb_build_object('reason', 'already_approved', 'user_id', v_caller_id)
    );
    RAISE EXCEPTION 'already_approved';
  END IF;

  INSERT INTO public.audit_logs (event_type, metadata)
  VALUES (
    'auth:device_code:approved',
    jsonb_build_object(
      'user_code_prefix', left(user_code_input, 4),
      'client_type', v_code_row.client_type,
      'user_id', v_caller_id
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_device_token(
  device_code_input TEXT
)
RETURNS TABLE (
  status   TEXT,
  user_id  UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_row     RECORD;
  v_elapsed INTERVAL;
  v_claimed UUID;
BEGIN
  SELECT * INTO v_row
    FROM public.device_codes
   WHERE device_code = device_code_input;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'expired'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF v_row.expires_at <= NOW() THEN
    RETURN QUERY SELECT 'expired'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF v_row.last_attempt_at IS NOT NULL THEN
    v_elapsed := NOW() - v_row.last_attempt_at;
    IF v_elapsed < INTERVAL '5 seconds' THEN
      UPDATE public.device_codes
         SET attempt_count   = attempt_count + 1,
             last_attempt_at = NOW()
       WHERE device_code = device_code_input;
      RETURN QUERY SELECT 'slow_down'::TEXT, NULL::UUID;
      RETURN;
    END IF;
  END IF;

  UPDATE public.device_codes
     SET attempt_count   = attempt_count + 1,
         last_attempt_at = NOW()
   WHERE device_code = device_code_input;

  IF v_row.approved_at IS NULL THEN
    RETURN QUERY SELECT 'pending'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF v_row.consumed_at IS NOT NULL THEN
    RETURN QUERY SELECT 'declined'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  UPDATE public.device_codes dc
     SET consumed_at = NOW()
   WHERE dc.device_code = device_code_input
     AND dc.approved_at IS NOT NULL
     AND dc.consumed_at IS NULL
     AND dc.expires_at > NOW()
  RETURNING dc.user_id INTO v_claimed;

  IF v_claimed IS NULL THEN
    RETURN QUERY SELECT 'declined'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  INSERT INTO public.audit_logs (event_type, metadata)
  VALUES (
    'auth:device_code:consumed',
    jsonb_build_object(
      'client_type', v_row.client_type,
      'user_id', v_claimed
    )
  );

  RETURN QUERY SELECT 'approved'::TEXT, v_claimed;
END;
$$;

-- Safe to drop outright (not CREATE OR REPLACE to some prior body) -- this
-- function didn't exist before this migration, and nothing else calls it once
-- auth-device-approve/index.ts's own revert (see WARNING above) removes its call
-- site.
DROP FUNCTION IF EXISTS public.mark_device_code_sso_refused(TEXT);

ALTER TABLE public.device_codes
  DROP COLUMN IF EXISTS refused_at,
  DROP COLUMN IF EXISTS refusal_reason;

-- schema_version back to 108. Covers BOTH 109 (this migration) and 110 (its
-- companion smoke migration, 20260830060001_auth_device_approve_sso_refusal_smoke
-- .sql, which has no rollback file of its own — adversarial review round 2, RB-a:
-- rolling back only 109 would leave 110 orphaned, pointing schema_version's own
-- max() at a smoke migration whose subject this file just reverted).
DELETE FROM schema_version WHERE version IN (109, 110);

-- ============================================================================
-- Post-rollback assertions -- confirm the restore actually landed rather than
-- leaving a half-reverted schema behind under incident pressure.
-- ============================================================================
DO $verify$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'mark_device_code_sso_refused') THEN
    RAISE EXCEPTION 'ROLLBACK FAIL: mark_device_code_sso_refused() still exists after the DROP above';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'device_codes'
                AND column_name IN ('refused_at', 'refusal_reason')) THEN
    RAISE EXCEPTION 'ROLLBACK FAIL: device_codes still has refused_at/refusal_reason';
  END IF;

  IF EXISTS (SELECT 1 FROM schema_version WHERE version IN (109, 110)) THEN
    RAISE EXCEPTION 'ROLLBACK FAIL: schema_version 109/110 row(s) still present';
  END IF;

  -- Existence-first, NOT the position()-only check that follows (adversarial
  -- review round 2, RB-b): if approve_device_code() were DROPped rather than
  -- restored, the subquery below returns NULL, pg_get_functiondef(NULL) is NULL,
  -- position(... IN NULL) is NULL, and "NULL > 0" is NULL — which an IF treats as
  -- false, so a half-reverted rollback that dropped the function would silently
  -- report success. Assert the function exists FIRST so that failure mode raises
  -- instead of passing.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'approve_device_code') THEN
    RAISE EXCEPTION 'ROLLBACK FAIL: approve_device_code() does not exist -- it was dropped, not restored';
  END IF;

  IF position('sso_unsupported' IN
       pg_get_functiondef((SELECT p.oid FROM pg_proc p
                             JOIN pg_namespace n ON n.oid = p.pronamespace
                            WHERE n.nspname = 'public'
                              AND p.proname = 'approve_device_code'))) > 0 THEN
    RAISE EXCEPTION 'ROLLBACK FAIL: approve_device_code() still refuses SSO callers -- '
      'body was not actually restored to the pre-refusal version';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'claim_device_token') THEN
    RAISE EXCEPTION 'ROLLBACK FAIL: claim_device_token() does not exist -- it was dropped, not restored';
  END IF;

  IF position('refused_at' IN
       pg_get_functiondef((SELECT p.oid FROM pg_proc p
                             JOIN pg_namespace n ON n.oid = p.pronamespace
                            WHERE n.nspname = 'public'
                              AND p.proname = 'claim_device_token'))) > 0 THEN
    RAISE EXCEPTION 'ROLLBACK FAIL: claim_device_token() still references refused_at -- '
      'body was not actually restored to the pre-refusal version';
  END IF;
END;
$verify$;

COMMIT;
