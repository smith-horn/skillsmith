-- SMI-6636 Wave 1a: tests for migration 20261004000000_organizations_wave1a_schema.sql
--
-- Tests exercise two surfaces introduced by that migration:
--   (1) trigger_org_has_owner / enforce_org_has_owner() on public.organization_members
--       (design §3.2a)
--   (2) teams_ownership_shape_check + the one-character slug rejection (design §3.0, §3.1)
--
-- Runner:
--   docker exec skillsmith-dev-1 psql "$LOCAL_SUPABASE_URL" \
--     -f supabase/tests/migrations/20261004000000_organizations_wave1a_schema.test.sql
--
-- Each test is wrapped in an explicit BEGIN; ... ROLLBACK; so the local DB is unchanged
-- after the run. Assertions use RAISE EXCEPTION (not pgTAP — pg_tap is not installed in
-- prod; see 080_profile_completion.test.sql for precedent).
--
-- Expected output on success: a stream of `NOTICE:  <id> PASS` lines followed by
-- `NOTICE:  All organizations Wave 1a schema tests passed`. Any failure raises an
-- exception and aborts the run.
--
-- NOT covered here, deliberately: the two-concurrent-sessions race test the design names
-- for trigger_org_has_owner's `FOR UPDATE` ("two concurrent deletions of the last two owner
-- rows leave exactly one") — that needs a two-backend concurrency harness, not a single
-- psql script, and was not in this task's required-case list. Flagged in the task report
-- rather than silently dropped.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = 'notice';

-- =============================================================================
-- ### TRIGGER TESTS: public.enforce_org_has_owner() / trigger_org_has_owner
-- =============================================================================

-- O-1: deleting the only org_owner is refused.
BEGIN;
DO $$
DECLARE
  test_org_id  TEXT;
  test_user_id UUID := gen_random_uuid();
  raised       BOOLEAN := FALSE;
BEGIN
  INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (test_user_id, 'org-o1@example.com', '{"provider":"email"}'::jsonb, '{}'::jsonb);

  INSERT INTO public.organizations (name, slug)
  VALUES ('Org O1', 'org-o1-test')
  RETURNING id INTO test_org_id;

  INSERT INTO public.organization_members (org_id, user_id, role)
  VALUES (test_org_id, test_user_id, 'org_owner');

  BEGIN
    DELETE FROM public.organization_members
     WHERE org_id = test_org_id AND user_id = test_user_id;
  EXCEPTION WHEN check_violation THEN
    raised := TRUE;
  END;

  IF NOT raised THEN
    RAISE EXCEPTION 'O-1 FAIL: deleting the only org_owner should be refused';
  END IF;

  RAISE NOTICE 'O-1 PASS';
END $$;
ROLLBACK;

-- O-2: demoting the only org_owner via UPDATE ... SET role is refused.
BEGIN;
DO $$
DECLARE
  test_org_id  TEXT;
  test_user_id UUID := gen_random_uuid();
  raised       BOOLEAN := FALSE;
BEGIN
  INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (test_user_id, 'org-o2@example.com', '{"provider":"email"}'::jsonb, '{}'::jsonb);

  INSERT INTO public.organizations (name, slug)
  VALUES ('Org O2', 'org-o2-test')
  RETURNING id INTO test_org_id;

  INSERT INTO public.organization_members (org_id, user_id, role)
  VALUES (test_org_id, test_user_id, 'org_owner');

  BEGIN
    UPDATE public.organization_members
       SET role = 'org_admin'
     WHERE org_id = test_org_id AND user_id = test_user_id;
  EXCEPTION WHEN check_violation THEN
    raised := TRUE;
  END;

  IF NOT raised THEN
    RAISE EXCEPTION 'O-2 FAIL: demoting the only org_owner should be refused';
  END IF;

  RAISE NOTICE 'O-2 PASS';
END $$;
ROLLBACK;

-- O-3: moving the last owner out via UPDATE ... SET org_id is refused (the path the
-- dropped `OF role` column list used to miss).
BEGIN;
DO $$
DECLARE
  org_a        TEXT;
  org_b        TEXT;
  test_user_id UUID := gen_random_uuid();
  raised       BOOLEAN := FALSE;
BEGIN
  INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (test_user_id, 'org-o3@example.com', '{"provider":"email"}'::jsonb, '{}'::jsonb);

  INSERT INTO public.organizations (name, slug) VALUES ('Org O3A', 'org-o3a-test') RETURNING id INTO org_a;
  INSERT INTO public.organizations (name, slug) VALUES ('Org O3B', 'org-o3b-test') RETURNING id INTO org_b;

  INSERT INTO public.organization_members (org_id, user_id, role)
  VALUES (org_a, test_user_id, 'org_owner');

  BEGIN
    UPDATE public.organization_members
       SET org_id = org_b
     WHERE org_id = org_a AND user_id = test_user_id;
  EXCEPTION WHEN check_violation THEN
    raised := TRUE;
  END;

  IF NOT raised THEN
    RAISE EXCEPTION 'O-3 FAIL: moving the last owner out via org_id update should be refused';
  END IF;

  RAISE NOTICE 'O-3 PASS';
END $$;
ROLLBACK;

-- O-4: both deletion and demotion succeed on an 'ended' organization.
BEGIN;
DO $$
DECLARE
  org_del         TEXT;
  org_demo        TEXT;
  user_del        UUID := gen_random_uuid();
  user_demo       UUID := gen_random_uuid();
  remaining_count INTEGER;
  final_role      TEXT;
BEGIN
  INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  VALUES
    (user_del,  'org-o4a@example.com', '{"provider":"email"}'::jsonb, '{}'::jsonb),
    (user_demo, 'org-o4b@example.com', '{"provider":"email"}'::jsonb, '{}'::jsonb);

  INSERT INTO public.organizations (name, slug, status)
  VALUES ('Org O4 Del', 'org-o4-del-test', 'ended')
  RETURNING id INTO org_del;

  INSERT INTO public.organizations (name, slug, status)
  VALUES ('Org O4 Demo', 'org-o4-demo-test', 'ended')
  RETURNING id INTO org_demo;

  INSERT INTO public.organization_members (org_id, user_id, role) VALUES (org_del, user_del, 'org_owner');
  INSERT INTO public.organization_members (org_id, user_id, role) VALUES (org_demo, user_demo, 'org_owner');

  -- Deletion.
  DELETE FROM public.organization_members WHERE org_id = org_del AND user_id = user_del;
  SELECT count(*) INTO remaining_count FROM public.organization_members WHERE org_id = org_del;
  IF remaining_count <> 0 THEN
    RAISE EXCEPTION 'O-4 FAIL: deletion on ended org should have succeeded; % rows remain', remaining_count;
  END IF;

  -- Demotion.
  UPDATE public.organization_members SET role = 'org_admin' WHERE org_id = org_demo AND user_id = user_demo;
  SELECT role INTO final_role FROM public.organization_members WHERE org_id = org_demo AND user_id = user_demo;
  IF final_role IS DISTINCT FROM 'org_admin' THEN
    RAISE EXCEPTION 'O-4 FAIL: demotion on ended org should have succeeded; role=%', final_role;
  END IF;

  RAISE NOTICE 'O-4 PASS';
END $$;
ROLLBACK;

-- O-5: deleting an organization that still has members succeeds -- guards the
-- `v_status IS NULL` arm, which no test previously covered (design §3.2a).
BEGIN;
DO $$
DECLARE
  test_org_id      TEXT;
  test_user_id     UUID := gen_random_uuid();
  remaining_orgs   INTEGER;
  remaining_members INTEGER;
BEGIN
  INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (test_user_id, 'org-o5@example.com', '{"provider":"email"}'::jsonb, '{}'::jsonb);

  INSERT INTO public.organizations (name, slug)
  VALUES ('Org O5', 'org-o5-test')
  RETURNING id INTO test_org_id;

  INSERT INTO public.organization_members (org_id, user_id, role)
  VALUES (test_org_id, test_user_id, 'org_owner');

  -- This cascades to organization_members (ON DELETE CASCADE, §3.2), which fires
  -- trigger_org_has_owner with no parent organizations row left to read.
  DELETE FROM public.organizations WHERE id = test_org_id;

  SELECT count(*) INTO remaining_orgs FROM public.organizations WHERE id = test_org_id;
  SELECT count(*) INTO remaining_members FROM public.organization_members WHERE org_id = test_org_id;

  IF remaining_orgs <> 0 THEN
    RAISE EXCEPTION 'O-5 FAIL: organization delete should have succeeded; % orgs remain', remaining_orgs;
  END IF;
  IF remaining_members <> 0 THEN
    RAISE EXCEPTION 'O-5 FAIL: membership rows should have cascaded; % remain', remaining_members;
  END IF;

  RAISE NOTICE 'O-5 PASS';
END $$;
ROLLBACK;

-- =============================================================================
-- ### teams_ownership_shape_check TESTS (design §3.0)
-- =============================================================================

-- O-6: every forbidden `teams` shape is rejected by the two-shape CHECK, and both legal
-- shapes still succeed (a CHECK that rejected everything would pass the forbidden-only
-- assertions too).
BEGIN;
DO $$
DECLARE
  v_owner           UUID := gen_random_uuid();
  v_org             TEXT;
  v_subscription_id TEXT;
  v_msg             TEXT;
BEGIN
  INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (v_owner, 'org-o6-owner@example.com', '{"provider":"email"}'::jsonb, '{}'::jsonb);

  INSERT INTO public.organizations (name, slug) VALUES ('Org O6', 'org-o6-test') RETURNING id INTO v_org;

  INSERT INTO subscriptions (user_id, tier, billing_period, current_period_start, current_period_end)
  VALUES (v_owner, 'individual', 'monthly', now(), now() + interval '30 days')
  RETURNING id INTO v_subscription_id;

  -- Every forbidden-combo check below asserts the message names
  -- `teams_ownership_shape_check` specifically, not merely "some check_violation fired" --
  -- `teams` also carries `teams_skill_namespace_shape_check` and a UNIQUE on subscription_id,
  -- and a generic catch could pass on the wrong constraint while this one silently never fires.

  -- Forbidden combo 1: provisioned_by_org_id NULL, owner_id NULL, subscription_id NULL.
  v_msg := NULL;
  BEGIN
    INSERT INTO public.teams (name) VALUES ('O6 Combo1 all null');
  EXCEPTION WHEN check_violation THEN
    v_msg := SQLERRM;
  END;
  IF v_msg IS NULL OR v_msg NOT LIKE '%teams_ownership_shape_check%' THEN
    RAISE EXCEPTION 'O-6 FAIL: combo1 (all null) should be rejected by teams_ownership_shape_check; got %', v_msg;
  END IF;

  -- Forbidden combo 2: provisioned_by_org_id NULL, owner_id NULL, subscription_id NOT NULL.
  v_msg := NULL;
  BEGIN
    INSERT INTO public.teams (name, subscription_id) VALUES ('O6 Combo2 sub only', v_subscription_id);
  EXCEPTION WHEN check_violation THEN
    v_msg := SQLERRM;
  END;
  IF v_msg IS NULL OR v_msg NOT LIKE '%teams_ownership_shape_check%' THEN
    RAISE EXCEPTION 'O-6 FAIL: combo2 (subscription_id only) should be rejected by teams_ownership_shape_check; got %', v_msg;
  END IF;

  -- Forbidden combo 3: provisioned_by_org_id NOT NULL, owner_id NOT NULL, subscription_id NULL.
  v_msg := NULL;
  BEGIN
    INSERT INTO public.teams (name, owner_id, provisioned_by_org_id)
    VALUES ('O6 Combo3 both set', v_owner, v_org);
  EXCEPTION WHEN check_violation THEN
    v_msg := SQLERRM;
  END;
  IF v_msg IS NULL OR v_msg NOT LIKE '%teams_ownership_shape_check%' THEN
    RAISE EXCEPTION 'O-6 FAIL: combo3 (owner_id + provisioned_by_org_id both set) should be rejected by teams_ownership_shape_check; got %', v_msg;
  END IF;

  -- Forbidden combo 4: provisioned_by_org_id NOT NULL, owner_id NOT NULL, subscription_id NOT NULL.
  v_msg := NULL;
  BEGIN
    INSERT INTO public.teams (name, owner_id, provisioned_by_org_id, subscription_id)
    VALUES ('O6 Combo4 all set', v_owner, v_org, v_subscription_id);
  EXCEPTION WHEN check_violation THEN
    v_msg := SQLERRM;
  END;
  IF v_msg IS NULL OR v_msg NOT LIKE '%teams_ownership_shape_check%' THEN
    RAISE EXCEPTION 'O-6 FAIL: combo4 (everything set) should be rejected by teams_ownership_shape_check; got %', v_msg;
  END IF;

  -- Forbidden combo 5: provisioned_by_org_id NOT NULL, owner_id NULL, subscription_id NOT NULL.
  -- This is the specific shape the `AND subscription_id IS NULL` clause guards: an org
  -- company must not carry a subscription.
  v_msg := NULL;
  BEGIN
    INSERT INTO public.teams (name, provisioned_by_org_id, subscription_id)
    VALUES ('O6 Combo5 org plus sub', v_org, v_subscription_id);
  EXCEPTION WHEN check_violation THEN
    v_msg := SQLERRM;
  END;
  IF v_msg IS NULL OR v_msg NOT LIKE '%teams_ownership_shape_check%' THEN
    RAISE EXCEPTION 'O-6 FAIL: combo5 (org company with a subscription) should be rejected by teams_ownership_shape_check; got %', v_msg;
  END IF;

  -- Legal shape A: org company (provisioned_by_org_id set, owner_id/subscription_id NULL).
  BEGIN
    INSERT INTO public.teams (name, provisioned_by_org_id) VALUES ('O6 Legal A org company', v_org);
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'O-6 FAIL: legal shape A (org company) should be accepted; got %', SQLERRM;
  END;

  -- Legal shape B: self-serve team (owner_id set, provisioned_by_org_id NULL).
  BEGIN
    INSERT INTO public.teams (name, owner_id) VALUES ('O6 Legal B self serve', v_owner);
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'O-6 FAIL: legal shape B (self-serve team) should be accepted; got %', SQLERRM;
  END;

  RAISE NOTICE 'O-6 PASS';
END $$;
ROLLBACK;

-- =============================================================================
-- ### organizations.slug TESTS (design §3.1)
-- =============================================================================

-- O-7: a one-character org slug is rejected; a two-character slug is accepted (the
-- design states the effective minimum is two, deliberately).
BEGIN;
DO $$
DECLARE
  raised BOOLEAN := FALSE;
BEGIN
  BEGIN
    INSERT INTO public.organizations (name, slug) VALUES ('Org Short Slug', 'a');
  EXCEPTION WHEN check_violation THEN
    raised := TRUE;
  END;

  IF NOT raised THEN
    RAISE EXCEPTION 'O-7 FAIL: one-character slug should be rejected';
  END IF;

  BEGIN
    INSERT INTO public.organizations (name, slug) VALUES ('Org Two Char Slug', 'ab');
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'O-7 FAIL: two-character slug should be accepted';
  END;

  RAISE NOTICE 'O-7 PASS';
END $$;
ROLLBACK;

-- =============================================================================
-- ### O-8: the six REVOKE ALL + ENABLE ROW LEVEL SECURITY pairs.
--
-- This is the migration's highest-risk surface and it had no coverage at all: O-1..O-7 test the
-- trigger, the `teams` CHECK and the slug regex, and nothing asserted the privilege posture. A
-- grep confirms six REVOKEs and six ENABLEs are PRESENT in the file, but presence in the source
-- is not application to the database -- the thing that matters is that all twelve statements
-- actually took effect on their own table.
--
-- Why it matters more here than for most tables: `pg_default_acl` grants `anon` and
-- `authenticated` TRUNCATE, REFERENCES, TRIGGER and MAINTAIN on every newly created `public`
-- table (measured 2026-10-04 on postgres 17.6 against a fresh postgres-owned table: SELECT,
-- INSERT, UPDATE and DELETE are NOT granted by default, the other four are). TRUNCATE is the
-- one RLS cannot reach at all, because it is a privilege-only check -- so a table that is
-- created but never reaches its REVOKE leaves an unauthenticated role able to empty it,
-- including the audit table.
--
-- The absence assertions below are paired with a known-positive control in the SAME execution.
-- An absence assertion passes when nothing ran, so without the control a typo'd table name, a
-- role that does not exist, or a `has_table_privilege` that always returned false would all
-- read as a clean sweep.
-- =============================================================================
BEGIN;
DO $$
DECLARE
  v_tables   TEXT[] := ARRAY['organizations', 'organization_members', 'organization_companies',
                             'organization_credentials', 'organization_audit_events',
                             'organization_agreements'];
  v_privs    TEXT[] := ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE',
                             'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  v_tbl      TEXT;
  v_priv     TEXT;
  v_role     TEXT;
  v_rls      BOOLEAN;
  v_examined INTEGER := 0;
  v_control  INTEGER := 0;
BEGIN
  -- MAINTAIN is PostgreSQL 17+. Asking for it on 15/16 makes has_table_privilege raise, which
  -- would turn an inapplicable privilege into a spurious failure, so it is added by version
  -- rather than assumed. It is the privilege whose omission from an enumerated revoke list left
  -- the sibling migration's own I-5 failing after a correct apply, so it is not optional here.
  -- array_append, not `|| 'MAINTAIN'`. The `||` form is ambiguous between array-concatenation
  -- and element-append, and PostgreSQL resolves it to the former here, then fails with
  -- `malformed array literal: "MAINTAIN"` trying to parse the string as a TEXT[]. Found by
  -- running this test, not by reading it.
  IF current_setting('server_version_num')::INTEGER >= 170000 THEN
    v_privs := array_append(v_privs, 'MAINTAIN');
  END IF;

  FOREACH v_tbl IN ARRAY v_tables LOOP
    IF to_regclass('public.' || v_tbl) IS NULL THEN
      RAISE EXCEPTION 'O-8 FAIL: public.% does not exist, so every assertion below would have '
                      'passed while examining nothing', v_tbl;
    END IF;
    v_examined := v_examined + 1;

    SELECT relrowsecurity INTO v_rls
      FROM pg_class WHERE oid = ('public.' || v_tbl)::REGCLASS;
    IF v_rls IS NOT TRUE THEN
      RAISE EXCEPTION 'O-8 FAIL: ENABLE ROW LEVEL SECURITY did not take on public.% '
                      '(relrowsecurity = %)', v_tbl, COALESCE(v_rls::TEXT, '<null>');
    END IF;

    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      FOREACH v_priv IN ARRAY v_privs LOOP
        IF has_table_privilege(v_role, 'public.' || v_tbl, v_priv) THEN
          RAISE EXCEPTION 'O-8 FAIL: % still holds table-level % on public.% -- the REVOKE ALL '
                          'did not take', v_role, v_priv, v_tbl;
        END IF;
      END LOOP;
    END LOOP;

    -- Known-positive, same execution, same function, same table: the OWNER must still hold
    -- SELECT. If this fails, has_table_privilege is not discriminating here and the eight
    -- absence checks above are worthless rather than reassuring.
    IF NOT has_table_privilege('postgres', 'public.' || v_tbl, 'SELECT') THEN
      RAISE EXCEPTION 'O-8 FAIL (control): the owner does not hold SELECT on public.% -- the '
                      'instrument returns false for a privilege that IS held, so the absence '
                      'assertions above prove nothing', v_tbl;
    END IF;
    v_control := v_control + 1;
  END LOOP;

  -- Denominator, reported rather than assumed: a sweep over an empty or short list is the
  -- classic way an absence assertion passes vacuously.
  IF v_examined <> 6 THEN
    RAISE EXCEPTION 'O-8 FAIL: swept % tables, expected exactly 6', v_examined;
  END IF;
  IF v_control <> 6 THEN
    RAISE EXCEPTION 'O-8 FAIL: the known-positive control held for only % of 6 tables', v_control;
  END IF;

  RAISE NOTICE 'O-8 PASS (% tables x % privileges x 2 roles, plus RLS, control held %/6)',
    v_examined, cardinality(v_privs), v_control;
END $$;
ROLLBACK;

-- =============================================================================
-- ### O-9: org_secret schema-USAGE denial.
--
-- `org_secret.organization_credential_secrets` deliberately has NO per-table REVOKE and NO RLS
-- (design §3.4a). Schema USAGE is therefore its ONLY privilege layer, which makes it the one
-- statement in the migration with no second line of defence behind it.
-- =============================================================================
BEGIN;
DO $$
DECLARE
  v_role TEXT;
BEGIN
  IF to_regnamespace('org_secret') IS NULL THEN
    RAISE EXCEPTION 'O-9 FAIL: schema org_secret does not exist';
  END IF;

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_schema_privilege(v_role, 'org_secret', 'USAGE') THEN
      RAISE EXCEPTION 'O-9 FAIL: % holds USAGE on org_secret. The secrets table has no REVOKE '
                      'and no RLS, so this is the only layer protecting it', v_role;
    END IF;
    IF has_schema_privilege(v_role, 'org_secret', 'CREATE') THEN
      RAISE EXCEPTION 'O-9 FAIL: % holds CREATE on org_secret', v_role;
    END IF;
  END LOOP;

  -- Known-positive: the owner must still reach the schema, or the SECURITY DEFINER resolver the
  -- design relies on could not either -- and a false from has_schema_privilege would make the
  -- two denials above meaningless.
  IF NOT has_schema_privilege('postgres', 'org_secret', 'USAGE') THEN
    RAISE EXCEPTION 'O-9 FAIL (control): the owner lacks USAGE on org_secret, so the denials '
                    'above are not evidence';
  END IF;

  RAISE NOTICE 'O-9 PASS';
END $$;
ROLLBACK;

-- =============================================================================
-- ### O-10: at most one ACTIVE agreement per organization (ADR-160 §1).
--
-- Asserted behaviourally rather than by looking for the index name, so it stays true if the
-- invariant is later enforced a different way. Both halves matter: the partial index must
-- REFUSE a second active row and must still ADMIT any number of ended ones, since an index
-- without the WHERE clause would pass a refusal-only test.
-- =============================================================================
BEGIN;
DO $$
DECLARE
  v_org    TEXT;
  v_second BOOLEAN := FALSE;
BEGIN
  INSERT INTO public.organizations (name, slug)
  VALUES ('O10 Agreements Org', 'o10-agreements-org') RETURNING id INTO v_org;

  INSERT INTO public.organization_agreements (org_id, tier, status)
  VALUES (v_org, 'enterprise', 'active');

  BEGIN
    INSERT INTO public.organization_agreements (org_id, tier, status)
    VALUES (v_org, 'enterprise', 'active');
    v_second := TRUE;
  EXCEPTION WHEN unique_violation THEN
    NULL;   -- expected: idx_org_agreements_one_active
  END;

  IF v_second THEN
    RAISE EXCEPTION 'O-10 FAIL: a second ACTIVE agreement was accepted for the same org; '
                    'ADR-160 §1 allows at most one';
  END IF;

  -- The other half: history is unrestricted, so the index must be PARTIAL. A plain unique index
  -- on (org_id) satisfies the refusal above and fails here -- which is exactly why this half
  -- exists, and it is MEASURED rather than argued: replacing the partial index with a plain
  -- `UNIQUE (org_id)` makes this block raise while the refusal above still passes.
  --
  -- The handler is the point. Without it the failure arrives as a raw
  -- `duplicate key value violates unique constraint "idx_org_agreements_one_active"`, which is a
  -- correct failure but an anonymous one: it carries no test id, so a filter scanning for
  -- PASS/FAIL misses it entirely and the run looks like O-10 simply did not happen. That is how
  -- this very defect was nearly misread as "the test does not detect the mutation".
  BEGIN
    INSERT INTO public.organization_agreements (org_id, tier, status)
    VALUES (v_org, 'enterprise', 'ended');
    INSERT INTO public.organization_agreements (org_id, tier, status)
    VALUES (v_org, 'enterprise', 'ended');
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'O-10 FAIL: an ended agreement was refused, so the uniqueness constraint is '
                    'not PARTIAL. ADR-160 §1 allows at most one ACTIVE agreement per org and any '
                    'number of ended/suspended rows as history; a plain UNIQUE (org_id) index '
                    'passes the at-most-one-active half of this test and breaks history';
  END;

  RAISE NOTICE 'O-10 PASS';
END $$;
ROLLBACK;

-- =============================================================================
-- Summary -- and it ASSERTS before it congratulates.
--
-- Previously an unconditional `RAISE NOTICE 'All ... passed'`, which is honest only while
-- `ON_ERROR_STOP` is on. The sibling test file was measured printing its own summary beneath
-- two genuine FAIL lines with that flag off, so this one gets the same treatment rather than
-- waiting to be caught: the congratulation is now backed by an assertion in the block that
-- prints it. Catalog-level only, so it needs no fixtures and cannot self-skip.
-- =============================================================================
DO $$
DECLARE
  v_tbl   TEXT;
  v_bad   INTEGER := 0;
  v_seen  INTEGER := 0;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY['organizations', 'organization_members',
                               'organization_companies', 'organization_credentials',
                               'organization_audit_events', 'organization_agreements'] LOOP
    IF to_regclass('public.' || v_tbl) IS NULL THEN
      RAISE EXCEPTION 'SUMMARY REFUSED: public.% does not exist', v_tbl;
    END IF;
    v_seen := v_seen + 1;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || v_tbl)::REGCLASS) THEN
      RAISE EXCEPTION 'SUMMARY REFUSED: RLS is not enabled on public.%', v_tbl;
    END IF;
    IF has_table_privilege('anon', 'public.' || v_tbl, 'TRUNCATE')
       OR has_table_privilege('authenticated', 'public.' || v_tbl, 'TRUNCATE') THEN
      v_bad := v_bad + 1;
    END IF;
  END LOOP;

  IF v_seen <> 6 THEN
    RAISE EXCEPTION 'SUMMARY REFUSED: checked % tables, expected 6', v_seen;
  END IF;
  -- TRUNCATE specifically, because it is the privilege `pg_default_acl` grants by default AND
  -- the one RLS cannot reach -- so it is the single best one-privilege proxy for "the REVOKE ALL
  -- landed". O-8 is the exhaustive sweep; this is the backstop.
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'SUMMARY REFUSED: anon or authenticated still holds TRUNCATE on % of the 6 '
                    'new tables', v_bad;
  END IF;
  IF has_schema_privilege('anon', 'org_secret', 'USAGE')
     OR has_schema_privilege('authenticated', 'org_secret', 'USAGE') THEN
    RAISE EXCEPTION 'SUMMARY REFUSED: anon or authenticated holds USAGE on org_secret';
  END IF;

  RAISE NOTICE 'All organizations Wave 1a schema tests passed';
END $$;
