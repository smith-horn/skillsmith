-- SMI-4400 Wave 1: Profile-completion tests (migration 080)
--
-- Tests exercise three surfaces introduced by migration
-- `080_profile_completion.sql`:
--   (1) Rewritten `handle_new_user` trigger
--   (2) New `validate_license_key_v2(key_hash_input TEXT)` RPC
--   (3) New `issue_license_key_if_profile_complete(user_id_input UUID)` RPC
--
-- Runner:
--   docker exec skillsmith-dev-1 psql "$LOCAL_SUPABASE_URL" \
--     -f supabase/tests/migrations/080_profile_completion.test.sql
--
-- Each test is wrapped in an explicit BEGIN; ... ROLLBACK; so the local DB
-- is unchanged after the run. Assertions use RAISE EXCEPTION (not pgTAP —
-- pg_tap is not installed in prod; follow-up SMI-4406 tracks retrofit).
--
-- Expected output on success: a stream of `NOTICE:  <id> PASS` lines
-- followed by `NOTICE:  All 24 Wave 1 tests passed`.
-- Any failure raises an exception and aborts the run.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = 'notice';

-- =============================================================================
-- ### TRIGGER TESTS: public.handle_new_user()
-- =============================================================================

-- T-1: email provider + valid first_name/last_name in metadata
--      → profile_completed_at IS NOT NULL (fast-path).
BEGIN;
DO $$
DECLARE
  test_user_id UUID := gen_random_uuid();
  completed TIMESTAMPTZ;
  fn TEXT;
  ln TEXT;
BEGIN
  INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (
    test_user_id,
    'test-t1@example.com',
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"first_name":"Ryan","last_name":"Smith"}'::jsonb
  );

  SELECT profile_completed_at, first_name, last_name
    INTO completed, fn, ln
    FROM profiles WHERE id = test_user_id;

  IF completed IS NULL THEN
    RAISE EXCEPTION
      'T-1 FAIL: email+valid-name fast-path did not set profile_completed_at';
  END IF;
  IF fn <> 'Ryan' OR ln <> 'Smith' THEN
    RAISE EXCEPTION
      'T-1 FAIL: expected first_name=Ryan, last_name=Smith; got %, %', fn, ln;
  END IF;

  RAISE NOTICE 'T-1 PASS';
END $$;
ROLLBACK;

-- T-2: email provider + MISSING first_name in metadata
--      → profile_completed_at IS NULL.
BEGIN;
DO $$
DECLARE
  test_user_id UUID := gen_random_uuid();
  completed TIMESTAMPTZ;
BEGIN
  INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (
    test_user_id,
    'test-t2@example.com',
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"last_name":"Smith"}'::jsonb
  );

  SELECT profile_completed_at INTO completed
    FROM profiles WHERE id = test_user_id;

  IF completed IS NOT NULL THEN
    RAISE EXCEPTION
      'T-2 FAIL: missing first_name should leave profile_completed_at NULL';
  END IF;

  RAISE NOTICE 'T-2 PASS';
END $$;
ROLLBACK;

-- T-3: email provider + first_name='a' (length < 2 — fails valid_name gate)
--      → profile_completed_at IS NULL.
BEGIN;
DO $$
DECLARE
  test_user_id UUID := gen_random_uuid();
  completed TIMESTAMPTZ;
BEGIN
  INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (
    test_user_id,
    'test-t3@example.com',
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"first_name":"a","last_name":"Smith"}'::jsonb
  );

  SELECT profile_completed_at INTO completed
    FROM profiles WHERE id = test_user_id;

  IF completed IS NOT NULL THEN
    RAISE EXCEPTION
      'T-3 FAIL: first_name length<2 should fail valid_name gate';
  END IF;

  RAISE NOTICE 'T-3 PASS';
END $$;
ROLLBACK;

-- T-4: github provider + full_name='Ryan Smith'
--      → first_name='Ryan', last_name='Smith', profile_completed_at IS NULL.
BEGIN;
DO $$
DECLARE
  test_user_id UUID := gen_random_uuid();
  fn TEXT;
  ln TEXT;
  completed TIMESTAMPTZ;
BEGIN
  INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (
    test_user_id,
    'test-t4@example.com',
    '{"provider":"github","providers":["github"]}'::jsonb,
    '{"full_name":"Ryan Smith","user_name":"rsmith"}'::jsonb
  );

  SELECT first_name, last_name, profile_completed_at
    INTO fn, ln, completed
    FROM profiles WHERE id = test_user_id;

  IF fn <> 'Ryan' OR ln <> 'Smith' THEN
    RAISE EXCEPTION
      'T-4 FAIL: github split expected (Ryan, Smith); got (%, %)', fn, ln;
  END IF;
  IF completed IS NOT NULL THEN
    RAISE EXCEPTION
      'T-4 FAIL: github never fast-paths — profile_completed_at must be NULL';
  END IF;

  RAISE NOTICE 'T-4 PASS';
END $$;
ROLLBACK;

-- T-5: github provider + full_name='Cher' (single word)
--      → first_name='Cher', last_name IS NULL, profile_completed_at IS NULL.
BEGIN;
DO $$
DECLARE
  test_user_id UUID := gen_random_uuid();
  fn TEXT;
  ln TEXT;
  completed TIMESTAMPTZ;
BEGIN
  INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (
    test_user_id,
    'test-t5@example.com',
    '{"provider":"github","providers":["github"]}'::jsonb,
    '{"full_name":"Cher","user_name":"cher"}'::jsonb
  );

  SELECT first_name, last_name, profile_completed_at
    INTO fn, ln, completed
    FROM profiles WHERE id = test_user_id;

  IF fn <> 'Cher' THEN
    RAISE EXCEPTION 'T-5 FAIL: expected first_name=Cher; got %', fn;
  END IF;
  IF ln IS NOT NULL THEN
    RAISE EXCEPTION
      'T-5 FAIL: single-word full_name should leave last_name NULL; got %', ln;
  END IF;
  IF completed IS NOT NULL THEN
    RAISE EXCEPTION
      'T-5 FAIL: profile_completed_at must be NULL for github single-word';
  END IF;

  RAISE NOTICE 'T-5 PASS';
END $$;
ROLLBACK;

-- T-6: no license_keys row is issued at trigger time (any provider).
BEGIN;
DO $$
DECLARE
  test_user_id UUID := gen_random_uuid();
  key_count INTEGER;
BEGIN
  INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (
    test_user_id,
    'test-t6@example.com',
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"first_name":"Ryan","last_name":"Smith"}'::jsonb
  );

  SELECT COUNT(*) INTO key_count
    FROM license_keys WHERE user_id = test_user_id;

  IF key_count <> 0 THEN
    RAISE EXCEPTION
      'T-6 FAIL: trigger must not issue license_keys; found % rows', key_count;
  END IF;

  RAISE NOTICE 'T-6 PASS';
END $$;
ROLLBACK;

-- T-7a: github signup → email_verified=TRUE AND email_verified_at IS NOT NULL.
BEGIN;
DO $$
DECLARE
  test_user_id UUID := gen_random_uuid();
  ev BOOLEAN;
  eva TIMESTAMPTZ;
BEGIN
  INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (
    test_user_id,
    'test-t7a@example.com',
    '{"provider":"github","providers":["github"]}'::jsonb,
    '{"full_name":"Ryan Smith"}'::jsonb
  );

  SELECT email_verified, email_verified_at
    INTO ev, eva
    FROM profiles WHERE id = test_user_id;

  IF ev IS NOT TRUE OR eva IS NULL THEN
    RAISE EXCEPTION
      'T-7a FAIL: github signup must set email_verified=TRUE + timestamp; got (%, %)',
      ev, eva;
  END IF;

  RAISE NOTICE 'T-7a PASS';
END $$;
ROLLBACK;

-- T-7b: email signup → email_verified=FALSE AND email_verified_at IS NULL.
BEGIN;
DO $$
DECLARE
  test_user_id UUID := gen_random_uuid();
  ev BOOLEAN;
  eva TIMESTAMPTZ;
BEGIN
  INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (
    test_user_id,
    'test-t7b@example.com',
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"first_name":"Ryan","last_name":"Smith"}'::jsonb
  );

  SELECT email_verified, email_verified_at
    INTO ev, eva
    FROM profiles WHERE id = test_user_id;

  IF ev IS NOT FALSE OR eva IS NOT NULL THEN
    RAISE EXCEPTION
      'T-7b FAIL: email signup must leave email_verified=FALSE + NULL timestamp; got (%, %)',
      ev, eva;
  END IF;

  RAISE NOTICE 'T-7b PASS';
END $$;
ROLLBACK;

-- =============================================================================
-- ### VALIDATE_LICENSE_KEY_V2 TESTS
-- Canonical error_code enum (spec §4 Tx 4):
--   NULL | 'invalid_key' | 'suspended' | 'inactive'
--   | 'profile_incomplete' | 'profile_grace'
-- =============================================================================

-- R-1: unknown key_hash → (FALSE, NULL, NULL, NULL, FALSE, 'invalid_key').
BEGIN;
DO $$
DECLARE
  r RECORD;
BEGIN
  SELECT * INTO r FROM validate_license_key_v2('no_such_hash_xyz');

  IF r.is_valid IS NOT FALSE
     OR r.user_id IS NOT NULL
     OR r.tier IS NOT NULL
     OR r.rate_limit IS NOT NULL
     OR r.profile_complete IS NOT FALSE
     OR r.error_code IS DISTINCT FROM 'invalid_key' THEN
    RAISE EXCEPTION
      'R-1 FAIL: unknown key tuple wrong: (%, %, %, %, %, %)',
      r.is_valid, r.user_id, r.tier, r.rate_limit, r.profile_complete, r.error_code;
  END IF;

  RAISE NOTICE 'R-1 PASS';
END $$;
ROLLBACK;

-- R-2: key with status='revoked' → error_code='suspended'.
BEGIN;
DO $$
DECLARE
  test_user_id UUID := gen_random_uuid();
  r RECORD;
BEGIN
  INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (
    test_user_id, 'test-r2@example.com',
    '{"provider":"email"}'::jsonb,
    '{"first_name":"Ryan","last_name":"Smith"}'::jsonb
  );
  UPDATE profiles SET email_verified = TRUE WHERE id = test_user_id;

  INSERT INTO license_keys (
    user_id, key_hash, key_prefix, tier, status,
    rate_limit_per_minute, revoked_at
  )
  VALUES (
    test_user_id, 'hash_r2_revoked', 'sk_live_', 'community', 'revoked',
    30, NOW()
  );

  SELECT * INTO r FROM validate_license_key_v2('hash_r2_revoked');

  IF r.is_valid IS NOT FALSE
     OR r.error_code IS DISTINCT FROM 'suspended' THEN
    RAISE EXCEPTION
      'R-2 FAIL: revoked key expected error_code=suspended, is_valid=FALSE; got (%, %)',
      r.is_valid, r.error_code;
  END IF;

  RAISE NOTICE 'R-2 PASS';
END $$;
ROLLBACK;

-- R-3: key self-expired (status='expired' OR expires_at < NOW())
--      → error_code='inactive'.
BEGIN;
DO $$
DECLARE
  test_user_id UUID := gen_random_uuid();
  r RECORD;
BEGIN
  INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (
    test_user_id, 'test-r3@example.com',
    '{"provider":"email"}'::jsonb,
    '{"first_name":"Ryan","last_name":"Smith"}'::jsonb
  );
  UPDATE profiles SET email_verified = TRUE WHERE id = test_user_id;

  INSERT INTO license_keys (
    user_id, key_hash, key_prefix, tier, status,
    rate_limit_per_minute, expires_at
  )
  VALUES (
    test_user_id, 'hash_r3_expired', 'sk_live_', 'community', 'active',
    30, NOW() - INTERVAL '1 day'
  );

  SELECT * INTO r FROM validate_license_key_v2('hash_r3_expired');

  IF r.is_valid IS NOT FALSE
     OR r.error_code IS DISTINCT FROM 'inactive' THEN
    RAISE EXCEPTION
      'R-3 FAIL: self-expired key expected error_code=inactive; got (%, %)',
      r.is_valid, r.error_code;
  END IF;

  RAISE NOTICE 'R-3 PASS';
END $$;
ROLLBACK;

-- R-4: active key + profile_completed_at IS NULL
--      → (TRUE, user_id, 'community', 30, FALSE, 'profile_incomplete').
BEGIN;
DO $$
DECLARE
  test_user_id UUID := gen_random_uuid();
  r RECORD;
BEGIN
  INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (
    test_user_id, 'test-r4@example.com',
    '{"provider":"email"}'::jsonb, '{}'::jsonb
  );
  -- Leave profile_completed_at NULL intentionally.

  INSERT INTO license_keys (
    user_id, key_hash, key_prefix, tier, status, rate_limit_per_minute
  )
  VALUES (
    test_user_id, 'hash_r4_incomplete', 'sk_live_', 'community', 'active', 30
  );

  SELECT * INTO r FROM validate_license_key_v2('hash_r4_incomplete');

  IF r.is_valid IS NOT TRUE
     OR r.user_id IS DISTINCT FROM test_user_id
     OR r.tier IS DISTINCT FROM 'community'
     OR r.rate_limit IS DISTINCT FROM 30
     OR r.profile_complete IS NOT FALSE
     OR r.error_code IS DISTINCT FROM 'profile_incomplete' THEN
    RAISE EXCEPTION
      'R-4 FAIL: tuple wrong (expected TRUE/<uid>/community/30/FALSE/profile_incomplete); got (%, %, %, %, %, %)',
      r.is_valid, r.user_id, r.tier, r.rate_limit, r.profile_complete, r.error_code;
  END IF;

  RAISE NOTICE 'R-4 PASS';
END $$;
ROLLBACK;

-- R-5: active key + profile_completed_at NOT NULL + email_verified=FALSE
--      → (TRUE, ..., FALSE, 'profile_incomplete').
BEGIN;
DO $$
DECLARE
  test_user_id UUID := gen_random_uuid();
  r RECORD;
BEGIN
  INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (
    test_user_id, 'test-r5@example.com',
    '{"provider":"email"}'::jsonb, '{}'::jsonb
  );
  UPDATE profiles
    SET first_name = 'Ryan',
        last_name = 'Smith',
        profile_completed_at = NOW(),
        email_verified = FALSE
    WHERE id = test_user_id;

  INSERT INTO license_keys (
    user_id, key_hash, key_prefix, tier, status, rate_limit_per_minute
  )
  VALUES (
    test_user_id, 'hash_r5_unverified', 'sk_live_', 'community', 'active', 30
  );

  SELECT * INTO r FROM validate_license_key_v2('hash_r5_unverified');

  IF r.is_valid IS NOT TRUE
     OR r.profile_complete IS NOT FALSE
     OR r.error_code IS DISTINCT FROM 'profile_incomplete' THEN
    RAISE EXCEPTION
      'R-5 FAIL: email_verified=FALSE path should return profile_incomplete; got (%, %, %)',
      r.is_valid, r.profile_complete, r.error_code;
  END IF;

  RAISE NOTICE 'R-5 PASS';
END $$;
ROLLBACK;

-- R-6: all gates pass → (TRUE, ..., TRUE, NULL) AND last_used_at,
-- usage_count updated.
BEGIN;
DO $$
DECLARE
  test_user_id UUID := gen_random_uuid();
  r RECORD;
  last_used_before TIMESTAMPTZ;
  last_used_after TIMESTAMPTZ;
  usage_before INTEGER;
  usage_after INTEGER;
BEGIN
  INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (
    test_user_id, 'test-r6@example.com',
    '{"provider":"email"}'::jsonb, '{}'::jsonb
  );
  UPDATE profiles
    SET first_name = 'Ryan',
        last_name = 'Smith',
        profile_completed_at = NOW(),
        email_verified = TRUE,
        email_verified_at = NOW()
    WHERE id = test_user_id;

  INSERT INTO license_keys (
    user_id, key_hash, key_prefix, tier, status,
    rate_limit_per_minute, usage_count
  )
  VALUES (
    test_user_id, 'hash_r6_ok', 'sk_live_', 'community', 'active', 30, 0
  );

  SELECT last_used_at, usage_count INTO last_used_before, usage_before
    FROM license_keys WHERE key_hash = 'hash_r6_ok';

  SELECT * INTO r FROM validate_license_key_v2('hash_r6_ok');

  SELECT last_used_at, usage_count INTO last_used_after, usage_after
    FROM license_keys WHERE key_hash = 'hash_r6_ok';

  IF r.is_valid IS NOT TRUE
     OR r.profile_complete IS NOT TRUE
     OR r.error_code IS NOT NULL THEN
    RAISE EXCEPTION
      'R-6 FAIL: happy-path tuple wrong; got (%, %, %)',
      r.is_valid, r.profile_complete, r.error_code;
  END IF;
  IF usage_after <= usage_before THEN
    RAISE EXCEPTION
      'R-6 FAIL: usage_count should increment (before=%, after=%)',
      usage_before, usage_after;
  END IF;
  IF last_used_after IS NULL THEN
    RAISE EXCEPTION 'R-6 FAIL: last_used_at should be set on success';
  END IF;

  RAISE NOTICE 'R-6 PASS';
END $$;
ROLLBACK;

-- R-7: active key + profile_grace_until > NOW() + profile_completed_at NULL
--      → (TRUE, ..., TRUE, 'profile_grace').
BEGIN;
DO $$
DECLARE
  test_user_id UUID := gen_random_uuid();
  r RECORD;
BEGIN
  INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (
    test_user_id, 'test-r7@example.com',
    '{"provider":"email"}'::jsonb, '{}'::jsonb
  );
  UPDATE profiles
    SET profile_grace_until = NOW() + INTERVAL '7 days',
        email_verified = TRUE
    WHERE id = test_user_id;

  INSERT INTO license_keys (
    user_id, key_hash, key_prefix, tier, status, rate_limit_per_minute
  )
  VALUES (
    test_user_id, 'hash_r7_grace', 'sk_live_', 'community', 'active', 30
  );

  SELECT * INTO r FROM validate_license_key_v2('hash_r7_grace');

  IF r.is_valid IS NOT TRUE
     OR r.profile_complete IS NOT TRUE
     OR r.error_code IS DISTINCT FROM 'profile_grace' THEN
    RAISE EXCEPTION
      'R-7 FAIL: grace-window tuple wrong; got (%, %, %)',
      r.is_valid, r.profile_complete, r.error_code;
  END IF;

  RAISE NOTICE 'R-7 PASS';
END $$;
ROLLBACK;

-- =============================================================================
-- ### ISSUE_LICENSE_KEY_IF_PROFILE_COMPLETE TESTS
-- Return shape: TABLE(issued_now BOOLEAN, reason TEXT)
-- Reasons: NULL (success), 'already_issued', 'concurrent_call',
--          'profile_incomplete'
-- =============================================================================

-- I-1: call with auth.uid() IS NULL → SQLSTATE 42501.
BEGIN;
DO $$
DECLARE
  raised BOOLEAN := FALSE;
  sqlstate_caught TEXT;
BEGIN
  PERFORM set_config('request.jwt.claims', '', TRUE);

  BEGIN
    PERFORM * FROM issue_license_key_if_profile_complete(gen_random_uuid());
  EXCEPTION
    WHEN insufficient_privilege THEN
      raised := TRUE;
      sqlstate_caught := '42501';
  END;

  IF NOT raised THEN
    RAISE EXCEPTION
      'I-1 FAIL: unauthenticated call should RAISE 42501; did not';
  END IF;

  RAISE NOTICE 'I-1 PASS';
END $$;
ROLLBACK;

-- I-2: call with auth.uid() <> user_id_input → 42501.
BEGIN;
DO $$
DECLARE
  caller_id UUID := gen_random_uuid();
  other_id UUID := gen_random_uuid();
  raised BOOLEAN := FALSE;
BEGIN
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', caller_id::TEXT)::TEXT,
    TRUE
  );

  BEGIN
    PERFORM * FROM issue_license_key_if_profile_complete(other_id);
  EXCEPTION
    WHEN insufficient_privilege THEN
      raised := TRUE;
  END;

  IF NOT raised THEN
    RAISE EXCEPTION
      'I-2 FAIL: mismatched auth.uid must RAISE 42501; did not';
  END IF;

  RAISE NOTICE 'I-2 PASS';
END $$;
ROLLBACK;

-- I-3: call when profile is incomplete → (FALSE, 'profile_incomplete'),
-- no license_keys row, no audit_logs row.
BEGIN;
DO $$
DECLARE
  test_user_id UUID := gen_random_uuid();
  r RECORD;
  key_count INTEGER;
  audit_count INTEGER;
BEGIN
  INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (
    test_user_id, 'test-i3@example.com',
    '{"provider":"email"}'::jsonb, '{}'::jsonb
  );
  -- Profile stays incomplete (no first_name/last_name, no completed_at).

  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', test_user_id::TEXT)::TEXT,
    TRUE
  );

  SELECT * INTO r FROM issue_license_key_if_profile_complete(test_user_id);

  IF r.issued_now IS NOT FALSE
     OR r.reason IS DISTINCT FROM 'profile_incomplete' THEN
    RAISE EXCEPTION
      'I-3 FAIL: expected (FALSE, profile_incomplete); got (%, %)',
      r.issued_now, r.reason;
  END IF;

  SELECT COUNT(*) INTO key_count
    FROM license_keys WHERE user_id = test_user_id;
  IF key_count <> 0 THEN
    RAISE EXCEPTION 'I-3 FAIL: no key should be issued; found %', key_count;
  END IF;

  SELECT COUNT(*) INTO audit_count
    FROM audit_logs
    WHERE event_type = 'auth:profile:completed'
      AND actor = test_user_id::TEXT;
  IF audit_count <> 0 THEN
    RAISE EXCEPTION
      'I-3 FAIL: incomplete-profile path must not emit audit; found %',
      audit_count;
  END IF;

  RAISE NOTICE 'I-3 PASS';
END $$;
ROLLBACK;

-- I-4: profile complete + email_verified → (TRUE, NULL) + one license_keys row
-- with status='active', tier matching profiles.tier.
BEGIN;
DO $$
DECLARE
  test_user_id UUID := gen_random_uuid();
  r RECORD;
  key_count INTEGER;
  key_status TEXT;
  key_tier TEXT;
  profile_tier TEXT;
BEGIN
  INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (
    test_user_id, 'test-i4@example.com',
    '{"provider":"email"}'::jsonb, '{}'::jsonb
  );
  UPDATE profiles
    SET first_name = 'Ryan',
        last_name = 'Smith',
        profile_completed_at = NOW(),
        email_verified = TRUE,
        email_verified_at = NOW()
    WHERE id = test_user_id;

  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', test_user_id::TEXT)::TEXT,
    TRUE
  );

  SELECT * INTO r FROM issue_license_key_if_profile_complete(test_user_id);

  IF r.issued_now IS NOT TRUE OR r.reason IS NOT NULL THEN
    RAISE EXCEPTION
      'I-4 FAIL: expected (TRUE, NULL); got (%, %)', r.issued_now, r.reason;
  END IF;

  SELECT COUNT(*), MAX(status), MAX(tier)
    INTO key_count, key_status, key_tier
    FROM license_keys WHERE user_id = test_user_id;

  SELECT tier INTO profile_tier FROM profiles WHERE id = test_user_id;

  IF key_count <> 1 THEN
    RAISE EXCEPTION 'I-4 FAIL: expected 1 license key; found %', key_count;
  END IF;
  IF key_status <> 'active' THEN
    RAISE EXCEPTION 'I-4 FAIL: key status expected active; got %', key_status;
  END IF;
  IF key_tier <> profile_tier THEN
    RAISE EXCEPTION
      'I-4 FAIL: key tier (%) should match profile tier (%)',
      key_tier, profile_tier;
  END IF;

  RAISE NOTICE 'I-4 PASS';
END $$;
ROLLBACK;

-- I-5: call twice back-to-back in the same session → still exactly one
-- license_keys row (advisory lock / partial-index idempotency).
BEGIN;
DO $$
DECLARE
  test_user_id UUID := gen_random_uuid();
  r1 RECORD;
  r2 RECORD;
  key_count INTEGER;
BEGIN
  INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (
    test_user_id, 'test-i5@example.com',
    '{"provider":"email"}'::jsonb, '{}'::jsonb
  );
  UPDATE profiles
    SET first_name = 'Ryan',
        last_name = 'Smith',
        profile_completed_at = NOW(),
        email_verified = TRUE
    WHERE id = test_user_id;

  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', test_user_id::TEXT)::TEXT,
    TRUE
  );

  SELECT * INTO r1 FROM issue_license_key_if_profile_complete(test_user_id);
  SELECT * INTO r2 FROM issue_license_key_if_profile_complete(test_user_id);

  IF r1.issued_now IS NOT TRUE OR r1.reason IS NOT NULL THEN
    RAISE EXCEPTION
      'I-5 FAIL: first call should be (TRUE, NULL); got (%, %)',
      r1.issued_now, r1.reason;
  END IF;
  IF r2.issued_now IS NOT FALSE
     OR r2.reason IS DISTINCT FROM 'already_issued' THEN
    RAISE EXCEPTION
      'I-5 FAIL: second call should be (FALSE, already_issued); got (%, %)',
      r2.issued_now, r2.reason;
  END IF;

  SELECT COUNT(*) INTO key_count
    FROM license_keys WHERE user_id = test_user_id;
  IF key_count <> 1 THEN
    RAISE EXCEPTION
      'I-5 FAIL: repeated issuance should remain idempotent; found % keys',
      key_count;
  END IF;

  RAISE NOTICE 'I-5 PASS';
END $$;
ROLLBACK;

-- I-6: pre-existing active community key → no new key issued
-- (inherits migration 030 idempotency).
BEGIN;
DO $$
DECLARE
  test_user_id UUID := gen_random_uuid();
  r RECORD;
  key_count INTEGER;
BEGIN
  INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (
    test_user_id, 'test-i6@example.com',
    '{"provider":"email"}'::jsonb, '{}'::jsonb
  );
  UPDATE profiles
    SET first_name = 'Ryan',
        last_name = 'Smith',
        profile_completed_at = NOW(),
        email_verified = TRUE
    WHERE id = test_user_id;

  INSERT INTO license_keys (
    user_id, key_hash, key_prefix, tier, status, rate_limit_per_minute
  )
  VALUES (
    test_user_id, 'hash_i6_preexisting', 'sk_live_', 'community', 'active', 30
  );

  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', test_user_id::TEXT)::TEXT,
    TRUE
  );

  SELECT * INTO r FROM issue_license_key_if_profile_complete(test_user_id);

  IF r.issued_now IS NOT FALSE
     OR r.reason IS DISTINCT FROM 'already_issued' THEN
    RAISE EXCEPTION
      'I-6 FAIL: expected (FALSE, already_issued); got (%, %)',
      r.issued_now, r.reason;
  END IF;

  SELECT COUNT(*) INTO key_count
    FROM license_keys
    WHERE user_id = test_user_id AND status = 'active';
  IF key_count <> 1 THEN
    RAISE EXCEPTION
      'I-6 FAIL: pre-existing active key should remain unique; found %',
      key_count;
  END IF;

  RAISE NOTICE 'I-6 PASS';
END $$;
ROLLBACK;

-- I-7: audit_logs emits exactly one auth:profile:completed row on success
-- with metadata->>'tier' = 'community'.
BEGIN;
DO $$
DECLARE
  test_user_id UUID := gen_random_uuid();
  audit_count INTEGER;
  audit_tier TEXT;
BEGIN
  INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (
    test_user_id, 'test-i7@example.com',
    '{"provider":"email"}'::jsonb, '{}'::jsonb
  );
  UPDATE profiles
    SET first_name = 'Ryan',
        last_name = 'Smith',
        profile_completed_at = NOW(),
        email_verified = TRUE
    WHERE id = test_user_id;

  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', test_user_id::TEXT)::TEXT,
    TRUE
  );

  PERFORM * FROM issue_license_key_if_profile_complete(test_user_id);

  SELECT COUNT(*), MAX(metadata->>'tier')
    INTO audit_count, audit_tier
    FROM audit_logs
    WHERE event_type = 'auth:profile:completed'
      AND actor = test_user_id::TEXT;

  IF audit_count <> 1 THEN
    RAISE EXCEPTION
      'I-7 FAIL: expected 1 audit row; found %', audit_count;
  END IF;
  IF audit_tier <> 'community' THEN
    RAISE EXCEPTION
      'I-7 FAIL: audit metadata tier expected community; got %', audit_tier;
  END IF;

  RAISE NOTICE 'I-7 PASS';
END $$;
ROLLBACK;

-- I-8: function is SECURITY DEFINER (prosecdef = TRUE).
BEGIN;
DO $$
DECLARE
  secdef BOOLEAN;
BEGIN
  SELECT p.prosecdef INTO secdef
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'issue_license_key_if_profile_complete';

  IF secdef IS NOT TRUE THEN
    RAISE EXCEPTION
      'I-8 FAIL: function must be SECURITY DEFINER; prosecdef=%', secdef;
  END IF;

  RAISE NOTICE 'I-8 PASS';
END $$;
ROLLBACK;

-- I-9: EXECUTE grant is on `authenticated` role only (not anon).
BEGIN;
DO $$
DECLARE
  has_authenticated BOOLEAN;
  has_anon BOOLEAN;
BEGIN
  SELECT
    bool_or(grantee = 'authenticated'),
    bool_or(grantee = 'anon')
    INTO has_authenticated, has_anon
    FROM information_schema.routine_privileges
   WHERE specific_schema = 'public'
     AND routine_name = 'issue_license_key_if_profile_complete'
     AND privilege_type = 'EXECUTE';

  IF has_authenticated IS NOT TRUE THEN
    RAISE EXCEPTION
      'I-9 FAIL: EXECUTE must be granted to authenticated role';
  END IF;
  IF has_anon IS TRUE THEN
    RAISE EXCEPTION
      'I-9 FAIL: EXECUTE must NOT be granted to anon role';
  END IF;

  RAISE NOTICE 'I-9 PASS';
END $$;
ROLLBACK;

-- =============================================================================
-- Summary
-- =============================================================================
DO $$ BEGIN RAISE NOTICE 'All 24 Wave 1 tests passed'; END $$;
