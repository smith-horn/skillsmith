-- ============================================================================
-- Invocation: run via scripts/staging/smi-5882-private-registry-rls-role-boundary.sh (from
-- any cwd -- that wrapper resolves this file's path relative to its own location, not the
-- caller's cwd, and refuses to run if this file is missing). Never invoke this file directly
-- through `./scripts/pooler-psql.sh -f <path>` -- that resolves the path INSIDE the container,
-- and from a worktree resolves against the MAIN checkout's container (SMI-5559), where this
-- file does not exist. See the wrapper script's own header for the exact piped-stdin form it
-- uses; do not hand-reproduce it here where it could drift out of sync.
-- ============================================================================

-- SMI-5882 ad-hoc staging verification: private_registry_skills RLS + privilege boundary.
-- Adapted from scripts/staging/smi-5817-rls-role-boundary.sql, the working precedent for
-- role-switching verification against this database (SET LOCAL ROLE + request.jwt.claims,
-- BEGIN/ROLLBACK fixtures, self-verifying DO blocks, two-gate prod-safety refusal).
--
-- WHY THIS IS A STAGING SCRIPT AND NOT A VITEST SUITE. SMI-5882 Wave 0's feasibility spike
-- concluded that a CI-wired live-Postgres harness is not buildable today: the full
-- supabase/migrations/ set has been un-replayable onto an empty database since 2026-06-01
-- (20260526000001 hardcodes search_metrics_202604/05/06 while 20260519000003 creates partitions
-- relative to NOW()), filed separately as SMI-5885. Wave 1 therefore proceeds on the plan's
-- documented escape hatch: adapt the staging-ad-hoc pattern. This is weaker than CI regression
-- coverage and should be described as such -- it runs when a human runs it.
--
-- STAGING ONLY (ovhcifugwqnzoebwfuku). All fixtures rolled back.
--
-- HARD GUARD. This script INSERTs rows into auth.users, profiles, teams, team_members and
-- private_registry_skills, and (deliberately, as its final assertion) attempts a TRUNCATE.
-- Running it against prod would create real orphaned auth users and take a momentary ACCESS
-- EXCLUSIVE lock on a live multi-tenant table. `pooler-psql.sh` connects with
-- SUPABASE_PROJECT_REF, which in .env is the PROD ref -- so "I ran the documented command" is
-- NOT evidence that this hit staging. Two independent gates:
--   (1) the shell wrapper refuses unless STAGING_SUPABASE_PROJECT_REF is set, and passes it in
--       as :confirm_ref;
--   (2) this block refuses unless :confirm_ref is BOTH set AND equal to the staging ref.
-- A bare `cat file | ./scripts/pooler-psql.sh` leaves :confirm_ref unset and stops at (2).
--
-- READING THE OUTPUT. Every check is self-verifying: it emits `NOTICE: ... PASS ...` or it
-- raises. A clean run exits 0 and asserts nothing is broken; ANY non-zero exit is a real finding.
--
-- WAVE 3 STATUS (2026-07-29). This file was written in Wave 1 to PROVE four gaps, and its
-- gap-demonstration blocks have now been INVERTED against the fix migration
-- `20260729000000_private_registry_privilege_hardening.sql` (which ships paired with
-- `20260729000001_private_registry_hardening_backfill.sql` -- the DDL was split from the backfill
-- + smoke suite so the ACCESS EXCLUSIVE-class locks are not held for the verification run; every
-- assertion below targets a control installed by the first file). Each inverted block still names
-- the Wave 1 result it replaces, so the evidence trail survives the inversion:
--   * Blocks C0-C7 asserted every non-key column was rewritable post-publish; they now assert
--     `deprecated` is the ONLY column an admin can write, and that every other write is refused
--     at the PRIVILEGE layer (42501), not merely filtered by RLS.
--   * Block T1 aborted the whole script because `authenticated` could TRUNCATE; it now asserts
--     TRUNCATE is refused for both client roles.
--   * Blocks H1-H4 are new: server-derived content_hash, content-shape rejection, forged
--     `published_by` on INSERT, and the anon EXECUTE revoke on the three team helpers.
--   * Block E2 is the one thing NOT inverted, deliberately -- see its own header. At the
--     database layer `service_role` still bypasses RLS by design; the SMI-5822 fix is that the
--     MCP path no longer reaches it, which is asserted in
--     packages/mcp-server/src/tools/registry-tools.live.admin-auth.test.ts, not here.
--
-- **RUN ORDER MATTERS.** Against a database where the fix migration has NOT been applied, this
-- file is expected to fail -- that is the point. It is the post-apply verification, and Wave 1's
-- pre-apply results are recorded in the plan doc rather than re-derivable from this file.
\set ON_ERROR_STOP on

-- `\quit` deliberately NOT used here: it exits psql with status 0 (it is not an error to psql,
-- just an early stop), which would make a bare `cat file | ./scripts/pooler-psql.sh` --
-- skipping the wrapper entirely -- silently "succeed" having asserted nothing. A RAISE
-- EXCEPTION inside ON_ERROR_STOP is what actually makes this refusal a non-zero exit.
\if :{?confirm_ref}
\else
  \echo '*** REFUSING: :confirm_ref is not set. Run this through'
  \echo '*** scripts/staging/smi-5882-private-registry-rls-role-boundary.sh'
  DO $guard0$ BEGIN
    RAISE EXCEPTION 'REFUSING: :confirm_ref is not set -- this script must be invoked via '
                    'scripts/staging/smi-5882-private-registry-rls-role-boundary.sh, never '
                    'piped directly.';
  END $guard0$;
\endif

SELECT :'confirm_ref' = 'ovhcifugwqnzoebwfuku' AS is_staging \gset
\if :is_staging
\else
  \echo '*** REFUSING: connected project ref is not staging.'
  DO $guard$ BEGIN
    RAISE EXCEPTION 'REFUSING: this script INSERTs fixture rows into auth.users and attempts a '
                    'TRUNCATE; it may only run against staging (ovhcifugwqnzoebwfuku).';
  END $guard$;
\endif

BEGIN;

-- ============================================================================
-- FIXTURES. Two tenants, four users, distinct team_members.role values.
--
-- teams.skill_namespace is NOT set explicitly anywhere below: it must be produced by
-- derive_team_skill_namespace() (BEFORE INSERT ON teams, 20260727000000:270-276). Setting it
-- directly would make every namespace assertion here prove nothing about the real team-creation
-- path -- SMI-5882 Wave 1 Step 2 calls this out explicitly. Block F1 asserts the trigger fired.
-- ============================================================================

INSERT INTO auth.users (id, email) VALUES
  ('5882aaaa-0000-0000-0000-0000000000a1', 'smi5882-a-admin@example.test'),
  ('5882aaaa-0000-0000-0000-0000000000a2', 'smi5882-a-member@example.test'),
  ('5882bbbb-0000-0000-0000-0000000000b1', 'smi5882-b-admin@example.test'),
  ('5882bbbb-0000-0000-0000-0000000000b2', 'smi5882-b-member@example.test')
ON CONFLICT (id) DO NOTHING;

INSERT INTO profiles (id, email, tier, role) VALUES
  ('5882aaaa-0000-0000-0000-0000000000a1', 'smi5882-a-admin@example.test',  'enterprise', 'user'),
  ('5882aaaa-0000-0000-0000-0000000000a2', 'smi5882-a-member@example.test', 'enterprise', 'user'),
  ('5882bbbb-0000-0000-0000-0000000000b1', 'smi5882-b-admin@example.test',  'enterprise', 'user'),
  ('5882bbbb-0000-0000-0000-0000000000b2', 'smi5882-b-member@example.test', 'enterprise', 'user')
ON CONFLICT (id) DO UPDATE SET tier = EXCLUDED.tier;

INSERT INTO teams (id, name, owner_id) VALUES
  ('5882aaaa-0000-0000-0000-00000000a001', 'SMI5882 Fixture Team Alpha',
   '5882aaaa-0000-0000-0000-0000000000a1'),
  ('5882bbbb-0000-0000-0000-00000000b001', 'SMI5882 Fixture Team Bravo',
   '5882bbbb-0000-0000-0000-0000000000b1')
ON CONFLICT (id) DO NOTHING;

INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES
  ('5882aaaa-0000-0000-0000-00000000a001', '5882aaaa-0000-0000-0000-0000000000a1', 'admin',  NOW()),
  ('5882aaaa-0000-0000-0000-00000000a001', '5882aaaa-0000-0000-0000-0000000000a2', 'member', NOW()),
  ('5882bbbb-0000-0000-0000-00000000b001', '5882bbbb-0000-0000-0000-0000000000b1', 'admin',  NOW()),
  ('5882bbbb-0000-0000-0000-00000000b001', '5882bbbb-0000-0000-0000-0000000000b2', 'member', NOW())
ON CONFLICT (team_id, user_id) DO NOTHING;

-- One published row per tenant, skill_id built from each team's DERIVED namespace so
-- trg_prs_namespace accepts it. content_hash is supplied DELIBERATELY WRONG (64 'a's): this runs
-- privileged, so the column grant does not apply, and block F2 then proves trg_prs_content_hash
-- discarded the supplied value rather than storing it.
INSERT INTO private_registry_skills (team_id, skill_id, version, description, content, content_hash)
SELECT t.id, t.skill_namespace || '/fixture-skill', '1.0.0', 'fixture',
       '{"SKILL.md":"original"}'::jsonb, repeat('a', 64)
FROM teams t
WHERE t.id IN ('5882aaaa-0000-0000-0000-00000000a001', '5882bbbb-0000-0000-0000-00000000b001');

-- Stash both namespaces in transaction-local custom GUCs, set here while still privileged.
-- WHY: the impersonated roles below must build a namespace-correct skill_id, but `teams` is
-- itself RLS-protected, so a team-A member may or may not be able to read team B's row. If a
-- negative INSERT test resolved the namespace by reading `teams` and came back empty, the
-- namespace TRIGGER (23514) would reject the insert before the RLS WITH CHECK was ever
-- evaluated -- and the test would report "denied" while never touching the policy it claims to
-- cover. Custom GUCs are readable by every role, so the trigger always passes and the only
-- thing left to deny is the policy under test. (psql's :vars cannot be used for this: psql does
-- not interpolate variables inside dollar-quoted DO bodies.)
SELECT set_config('smi5882.ns_a',
  (SELECT skill_namespace FROM teams WHERE id = '5882aaaa-0000-0000-0000-00000000a001'), true);
SELECT set_config('smi5882.ns_b',
  (SELECT skill_namespace FROM teams WHERE id = '5882bbbb-0000-0000-0000-00000000b001'), true);

-- ---------------------------------------------------------------------------
-- F1. Setup sanity. Without this, a policy that filtered EVERYTHING for EVERYONE would make
-- every "sees zero rows" assertion below pass vacuously.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  c_a CONSTANT TEXT := '5882aaaa-0000-0000-0000-00000000a001';
  c_b CONSTANT TEXT := '5882bbbb-0000-0000-0000-00000000b001';
  v_ns_a TEXT; v_ns_b TEXT; v_rows INT;
BEGIN
  SELECT skill_namespace INTO v_ns_a FROM teams WHERE id = c_a;
  SELECT skill_namespace INTO v_ns_b FROM teams WHERE id = c_b;
  IF v_ns_a IS NULL OR v_ns_b IS NULL THEN
    RAISE EXCEPTION 'FAIL (F1): derive_team_skill_namespace() did not populate skill_namespace '
                    '(A=%, B=%)', COALESCE(v_ns_a, '<null>'), COALESCE(v_ns_b, '<null>');
  END IF;
  IF v_ns_a = v_ns_b THEN
    RAISE EXCEPTION 'FAIL (F1): both fixture teams derived the SAME namespace (%)', v_ns_a;
  END IF;
  IF current_setting('smi5882.ns_a', true) IS DISTINCT FROM v_ns_a
     OR current_setting('smi5882.ns_b', true) IS DISTINCT FROM v_ns_b THEN
    RAISE EXCEPTION 'FAIL (F1): namespace GUCs did not take (a=%, b=%)',
      current_setting('smi5882.ns_a', true), current_setting('smi5882.ns_b', true);
  END IF;
  SELECT count(*) INTO v_rows FROM private_registry_skills WHERE team_id IN (c_a, c_b);
  IF v_rows <> 2 THEN
    RAISE EXCEPTION 'FAIL (F1): expected 2 fixture rows visible to the privileged setup role, got %',
      v_rows;
  END IF;
  RAISE NOTICE 'PASS (F1): trigger-derived namespaces A=% B=%, 2 fixture rows visible privileged',
    v_ns_a, v_ns_b;
END $$;

-- ---------------------------------------------------------------------------
-- F2 (Wave 3, new). The fixture INSERT above supplied content_hash = repeat('a',64) for a
-- SKILL.md of "original". If that value is what is stored, trg_prs_content_hash is not armed and
-- every content-integrity claim below is vacuous. This is the same role C0 plays for the
-- namespace trigger: prove the mechanism fires before relying on its silence.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_expected TEXT; v_bad INT;
BEGIN
  v_expected := encode(sha256(convert_to('original', 'UTF8')), 'hex');
  SELECT count(*) INTO v_bad FROM private_registry_skills
   WHERE team_id IN ('5882aaaa-0000-0000-0000-00000000a001', '5882bbbb-0000-0000-0000-00000000b001')
     AND content_hash IS DISTINCT FROM v_expected;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'FAIL (F2): % fixture row(s) kept a client-supplied content_hash instead of the '
                    'derived %. trg_prs_content_hash is not armed -- migration 20260729000000 has '
                    'not been applied, or its trigger was dropped.', v_bad, v_expected;
  END IF;
  RAISE NOTICE 'PASS (F2): trg_prs_content_hash armed -- the deliberately wrong client-supplied '
               'hash was discarded and re-derived as %', v_expected;
END $$;

-- ============================================================================
-- POLICY 1/4 -- private_registry_skills_member_read
--               (SELECT TO authenticated USING team_id IN (SELECT user_team_ids()))
-- ============================================================================

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"5882aaaa-0000-0000-0000-0000000000a2","role":"authenticated"}', true);

-- R1 (positive) + R2 (negative, cross-tenant).
DO $$
DECLARE v_own INT; v_other INT;
BEGIN
  SELECT count(*) INTO v_own   FROM private_registry_skills
   WHERE team_id = '5882aaaa-0000-0000-0000-00000000a001';
  SELECT count(*) INTO v_other FROM private_registry_skills
   WHERE team_id = '5882bbbb-0000-0000-0000-00000000b001';
  IF v_own <> 1 THEN
    RAISE EXCEPTION 'FAIL (R1): team-A member sees % of team A''s rows, expected 1', v_own;
  END IF;
  IF v_other <> 0 THEN
    RAISE EXCEPTION 'FAIL (R2): CROSS-TENANT LEAK -- team-A member sees % team-B rows', v_other;
  END IF;
  RAISE NOTICE 'PASS (R1/R2): _member_read -- team-A member sees 1 own row, 0 team-B rows';
END $$;

-- R3 (negative, anon): there is intentionally NO anon policy, so RLS must default-deny anon
-- every row on the WHOLE table -- not merely the fixture rows.
RESET ROLE;
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
DO $$
DECLARE v_all INT;
BEGIN
  SELECT count(*) INTO v_all FROM private_registry_skills;
  IF v_all <> 0 THEN
    RAISE EXCEPTION 'FAIL (R3): anon sees % rows on private_registry_skills -- RLS is not '
                    'default-denying anon', v_all;
  END IF;
  RAISE NOTICE 'PASS (R3): _member_read -- anon sees 0 rows on the whole table';
END $$;

-- ============================================================================
-- POLICY 2/4 -- private_registry_skills_member_insert
--               (INSERT TO authenticated WITH CHECK team_id IN (SELECT user_member_team_ids()))
-- ============================================================================

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"5882aaaa-0000-0000-0000-0000000000a2","role":"authenticated"}', true);

-- NOTE ON THE COLUMN LISTS BELOW (changed in Wave 3, and it is load-bearing). None of I1-I3
-- supplies `content_hash` any more. Migration 20260729000000 revoked table-level INSERT from
-- anon+authenticated and re-granted only (team_id, skill_id, version, description, content), so an
-- INSERT naming `content_hash` is now refused at the PRIVILEGE layer with 42501 -- the same
-- SQLSTATE the RLS WITH CHECK denial raises. Leaving it in would make I1 fail outright and, far
-- worse, make I2/I3 pass for the WRONG REASON: they would be asserting a column grant while
-- claiming to cover `_member_insert`. This is the same false-green hazard the I2 fixture's
-- namespace-GUC note already guards against, one layer down.

-- I1 (positive): team-A member publishes under team A, supplying only client-owned columns.
DO $$
DECLARE v_rows INT;
BEGIN
  INSERT INTO private_registry_skills (team_id, skill_id, version, content)
  VALUES ('5882aaaa-0000-0000-0000-00000000a001',
          current_setting('smi5882.ns_a') || '/member-insert-probe', '1.0.0',
          '{"SKILL.md":"x"}'::jsonb);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'FAIL (I1): team-A member insert under team A affected % rows', v_rows;
  END IF;
  RAISE NOTICE 'PASS (I1): _member_insert -- team-A member published under team A';
END $$;

-- I2 (negative, cross-tenant): team-A member inserts with team_id = <team B>, using team B's
-- OWN namespace so trg_prs_namespace (a BEFORE ROW trigger, which fires before the RLS WITH
-- CHECK is evaluated) passes and the remaining denial is attributable to _member_insert.
DO $$
BEGIN
  INSERT INTO private_registry_skills (team_id, skill_id, version, content)
  VALUES ('5882bbbb-0000-0000-0000-00000000b001',
          current_setting('smi5882.ns_b') || '/stolen-skill', '1.0.0',
          '{"SKILL.md":"x"}'::jsonb);
  RAISE EXCEPTION 'FAIL (I2): CROSS-TENANT WRITE -- team-A member inserted a row under team B';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS (I2): _member_insert WITH CHECK denied team-A member''s insert under team B';
  WHEN check_violation THEN
    RAISE EXCEPTION 'FAIL (I2): denied by trg_prs_namespace (23514), not by RLS -- the namespace '
                    'GUC was supposed to make the trigger pass so the WITH CHECK is what denies. '
                    'This result does NOT cover _member_insert; fix the fixture before citing it.';
END $$;

-- I3 (negative, anon): anon has no INSERT policy AND, since 20260729000000, no INSERT grant
-- either. Both layers now deny; either one alone is sufficient, so this stays a single assertion.
RESET ROLE;
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
DO $$
BEGIN
  INSERT INTO private_registry_skills (team_id, skill_id, version, content)
  VALUES ('5882aaaa-0000-0000-0000-00000000a001',
          current_setting('smi5882.ns_a') || '/anon-probe', '1.0.0',
          '{"SKILL.md":"x"}'::jsonb);
  RAISE EXCEPTION 'FAIL (I3): anon could INSERT into private_registry_skills';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS (I3): anon denied INSERT (no anon policy AND no anon INSERT grant)';
  WHEN check_violation THEN
    RAISE EXCEPTION 'FAIL (I3): denied by trg_prs_namespace, not by RLS/grant -- see I2''s note';
END $$;

-- ============================================================================
-- POLICY 3/4 -- private_registry_skills_admin_update
--   (UPDATE TO authenticated USING/WITH CHECK team_id IN (SELECT user_admin_team_ids()))
--
-- HOW AN RLS UPDATE DENIAL PRESENTS -- this determines how every negative test below is
-- written. A row that fails the USING clause is simply not visible to the UPDATE: Postgres does
-- NOT raise, the statement affects ZERO rows. So each negative UPDATE assertion checks ROW_COUNT
-- and the post-state, never a caught exception. An assertion written as
-- `EXCEPTION WHEN insufficient_privilege` would pass silently forever, including after a
-- regression that opened the policy up.
-- ============================================================================

-- Normalise state before the UPDATE matrix.
RESET ROLE;
UPDATE private_registry_skills SET deprecated = FALSE
 WHERE team_id IN ('5882aaaa-0000-0000-0000-00000000a001', '5882bbbb-0000-0000-0000-00000000b001');

-- U1 (positive): team-A ADMIN flips `deprecated` on a team-A row.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"5882aaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
DO $$
DECLARE v_rows INT;
BEGIN
  UPDATE private_registry_skills SET deprecated = TRUE
   WHERE team_id = '5882aaaa-0000-0000-0000-00000000a001' AND skill_id LIKE '%/fixture-skill';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'FAIL (U1): team-A admin flipped deprecated on % rows, expected 1', v_rows;
  END IF;
  RAISE NOTICE 'PASS (U1): _admin_update -- team-A admin flipped deprecated on a team-A row';
END $$;

RESET ROLE;
UPDATE private_registry_skills SET deprecated = FALSE
 WHERE team_id IN ('5882aaaa-0000-0000-0000-00000000a001', '5882bbbb-0000-0000-0000-00000000b001');

-- U2 (negative): team-A MEMBER (non-admin) cannot flip `deprecated` on its own team's row.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"5882aaaa-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
DO $$
DECLARE v_rows INT; v_dep BOOLEAN;
BEGIN
  UPDATE private_registry_skills SET deprecated = TRUE
   WHERE team_id = '5882aaaa-0000-0000-0000-00000000a001' AND skill_id LIKE '%/fixture-skill';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'FAIL (U2): PRIVILEGE ESCALATION -- team-A non-admin member updated % rows',
      v_rows;
  END IF;
  SELECT deprecated INTO v_dep FROM private_registry_skills
   WHERE team_id = '5882aaaa-0000-0000-0000-00000000a001' AND skill_id LIKE '%/fixture-skill';
  IF v_dep IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION 'FAIL (U2): deprecated is % after a member''s update attempt, expected FALSE',
      v_dep;
  END IF;
  RAISE NOTICE 'PASS (U2): _admin_update -- team-A member denied (0 rows, value unchanged)';
END $$;

-- U3 (negative, cross-tenant): team-A ADMIN cannot touch a team-B row.
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"5882aaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
DO $$
DECLARE v_rows INT;
BEGIN
  UPDATE private_registry_skills SET deprecated = TRUE
   WHERE team_id = '5882bbbb-0000-0000-0000-00000000b001';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'FAIL (U3): CROSS-TENANT WRITE -- team-A admin updated % team-B rows', v_rows;
  END IF;
  RAISE NOTICE 'PASS (U3): _admin_update -- team-A admin denied on team-B rows (0 rows)';
END $$;

-- ============================================================================
-- POLICY 4/4 -- private_registry_skills_service_all, per SMI-5882 Wave 1 Step 3's revision.
--
-- The naive version of this check ("assert service_role is reachable only via the service key")
-- is methodologically wrong and is NOT performed here:
--   * a privileged SQL connection can `SET LOCAL ROLE service_role` without possessing the HTTP
--     service key at all, so a role-switched test says nothing about key custody; and
--   * Supabase's service_role normally carries the BYPASSRLS role attribute, evaluated BEFORE
--     any policy is consulted -- so a "service_role can read" assertion can report coverage of a
--     policy that never executed.
-- Split into (S1) a catalog assertion on rolbypassrls and (S2) a policy-set sweep. The third
-- sub-check the plan describes -- real anon/authenticated/service keys over HTTP, the only thing
-- that tests key custody -- is not reproducible from psql and is explicitly out of scope here.
-- ============================================================================

RESET ROLE;

-- S1: rolbypassrls shape. If `authenticated` or `anon` ever gains BYPASSRLS, every policy
-- assertion in this file becomes vacuous -- so that is a hard failure, not a notice.
DO $$
DECLARE v_svc BOOLEAN; v_auth BOOLEAN; v_anon BOOLEAN; v_cur BOOLEAN;
BEGIN
  SELECT rolbypassrls INTO v_svc  FROM pg_roles WHERE rolname = 'service_role';
  SELECT rolbypassrls INTO v_auth FROM pg_roles WHERE rolname = 'authenticated';
  SELECT rolbypassrls INTO v_anon FROM pg_roles WHERE rolname = 'anon';
  SELECT rolbypassrls INTO v_cur  FROM pg_roles WHERE rolname = current_user;
  IF v_auth IS NOT DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'FAIL (S1): `authenticated` has BYPASSRLS -- every policy assertion in this '
                    'file is vacuous';
  END IF;
  IF v_anon IS NOT DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'FAIL (S1): `anon` has BYPASSRLS -- every policy assertion in this file is '
                    'vacuous';
  END IF;
  RAISE NOTICE 'PASS (S1): rolbypassrls -- service_role=%, authenticated=%, anon=%, current_user(%)=%',
    v_svc, v_auth, v_anon, current_user, v_cur;
  IF v_svc IS NOT DISTINCT FROM TRUE THEN
    RAISE NOTICE 'NOTE (S1): service_role carries BYPASSRLS, so _service_all is INERT in practice '
                 '-- tenant isolation on the MCP path rests entirely on registry-tools.live.ts''s '
                 'explicit team_id filters (ADR-116), verified by test in Wave 2 Step 1.';
  END IF;
END $$;

-- S2: the policy set must be exactly the four intended policies. Permissive policies OR
-- together, so a fifth policy added later widens access without modifying any of the four.
DO $$
DECLARE v_missing TEXT; v_extra TEXT;
BEGIN
  SELECT string_agg(x, ', ') INTO v_missing
  FROM unnest(ARRAY['private_registry_skills_member_read',
                    'private_registry_skills_member_insert',
                    'private_registry_skills_admin_update',
                    'private_registry_skills_service_all']) AS x
  WHERE NOT EXISTS (SELECT 1 FROM pg_policies p
                     WHERE p.schemaname = 'public' AND p.tablename = 'private_registry_skills'
                       AND p.policyname = x);
  SELECT string_agg(p.policyname, ', ') INTO v_extra
  FROM pg_policies p
  WHERE p.schemaname = 'public' AND p.tablename = 'private_registry_skills'
    AND p.policyname NOT IN ('private_registry_skills_member_read',
                             'private_registry_skills_member_insert',
                             'private_registry_skills_admin_update',
                             'private_registry_skills_service_all');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL (S2): expected policies missing: %', v_missing;
  END IF;
  IF v_extra IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL (S2): UNEXPECTED policy on private_registry_skills: % -- permissive '
                    'policies OR together, so this can widen access silently', v_extra;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class
                  WHERE relname = 'private_registry_skills'
                    AND relnamespace = 'public'::regnamespace AND relrowsecurity) THEN
    RAISE EXCEPTION 'FAIL (S2): ROW LEVEL SECURITY is not enabled on private_registry_skills';
  END IF;
  RAISE NOTICE 'PASS (S2): exactly the 4 intended policies present, RLS enabled';
END $$;

-- ============================================================================
-- GAP-DEMO 1 -- the SMI-5822 privilege escalation, proven as an asymmetry.
--
-- This SQL-only script cannot drive the actual MCP path (createLiveRegistryService() speaks
-- PostgREST with the service key). What it CAN do is prove both halves of the asymmetry at the
-- database level, which is where the escalation actually lives:
--   E1: over the authenticated/RLS path, a team-A MEMBER cannot deprecate a team-A skill.
--   E2: over the service-role path, the identical UPDATE succeeds, unconditionally.
--
-- E2 IS WHAT MAKES THE ESCALATION REAL, and this comment is the argument.
-- registry-tools.live.ts uses the service-role client for ALL CRUD (its own header, :18-24), and
-- deprecate()/undeprecate() filter on team_id + skill_id only. `teamId` comes from
-- resolve_team_from_license(), whose signature is `(p_license_key TEXT) RETURNS TEXT` -- it
-- resolves a TEAM, never a PERSON, and never reads team_members. A shared team license therefore
-- carries no caller role for anything downstream to check, and nothing in the database re-checks
-- one either: E2 shows the service-role path is unrestricted by construction. So any holder of
-- the team's shared license key -- a plain member, indistinguishable at the database from an
-- admin -- reaches exactly the unrestricted path E2 exercises, and performs the operation E1
-- proves they cannot perform through the dashboard. Same logical actor, two paths, two outcomes.
-- ============================================================================

RESET ROLE;
UPDATE private_registry_skills SET deprecated = FALSE
 WHERE team_id = '5882aaaa-0000-0000-0000-00000000a001';

-- E1: authenticated path, team-A member -> must be denied (0 rows).
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"5882aaaa-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
DO $$
DECLARE v_rows INT;
BEGIN
  UPDATE private_registry_skills SET deprecated = TRUE
   WHERE team_id = '5882aaaa-0000-0000-0000-00000000a001';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'FAIL (E1): team-A member deprecated % rows over the authenticated path -- '
                    '_admin_update is not restrictive', v_rows;
  END IF;
  RAISE NOTICE 'PASS (E1): authenticated path -- team-A member CANNOT deprecate (0 rows). RLS is '
               'correctly restrictive on this path.';
END $$;

-- E2: service-role path, the identical UPDATE -> must succeed.
--
-- WAVE 3: THIS BLOCK IS DELIBERATELY *NOT* INVERTED, and that is the honest outcome rather than an
-- omission. `service_role` bypasses RLS at the role-attribute level (block S1 confirms
-- rolbypassrls = t) and that is not changing -- edge functions and the indexer depend on it. So
-- there is no SQL-level assertion that could show "the escalation is fixed": the capability E2
-- exercises still exists at the database, by design.
--
-- What changed is that the MCP path no longer REACHES it. registry-tools.live.ts's deprecate() and
-- undeprecate() now run through the signed-in user's own JWT, so PostgREST evaluates
-- `private_registry_skills_admin_update` with a real auth.uid() -- i.e. exactly the check E1 proves
-- is correctly restrictive. That change is asserted where it lives, in
-- packages/mcp-server/src/tools/registry-tools.live.admin-auth.test.ts, which proves the UPDATE is
-- issued on the user client, that the service-role client never updates this table, and that a
-- missing user credential raises instead of falling back.
--
-- E2 therefore stays as a BY-DESIGN BASELINE: if it ever stops passing, service_role's bypass has
-- changed and several unrelated systems are broken.
RESET ROLE;
DO $$
DECLARE v_rows INT; v_role TEXT; v_dep BOOLEAN;
BEGIN
  BEGIN
    -- pooler-psql.sh logs in as postgres.<ref>, which resolves to the `postgres` role; on
    -- Supabase that role is a member of service_role. If a deployment ever refuses the SET ROLE,
    -- fall back to the session role, which is this table's OWNER and therefore also bypasses RLS
    -- -- the demonstration is equivalent either way, and the NOTICE records which was used.
    EXECUTE 'SET LOCAL ROLE service_role';
    v_role := 'service_role';
  EXCEPTION WHEN OTHERS THEN
    v_role := current_user || ' (table owner; could not SET ROLE service_role: ' || SQLERRM || ')';
  END;

  UPDATE private_registry_skills SET deprecated = TRUE
   WHERE team_id = '5882aaaa-0000-0000-0000-00000000a001';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows < 1 THEN
    RAISE EXCEPTION 'FAIL (E2): the service-role path updated % rows, expected >=1. If this ever '
                    'fails, the escalation described in SMI-5822 no longer holds and the plan '
                    'doc must be re-derived.', v_rows;
  END IF;
  SELECT bool_and(deprecated) INTO v_dep FROM private_registry_skills
   WHERE team_id = '5882aaaa-0000-0000-0000-00000000a001';
  IF v_dep IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'FAIL (E2): rows not actually deprecated after the service-role update';
  END IF;
  RAISE NOTICE 'PASS (E2, by-design baseline): as % the identical UPDATE deprecated % row(s). '
               'service_role is unrestricted at the database by design; SMI-5822 was fixed by '
               'removing the MCP path''s use of it for deprecate/undeprecate, asserted in '
               'registry-tools.live.admin-auth.test.ts.', v_role, v_rows;
END $$;

RESET ROLE;
UPDATE private_registry_skills SET deprecated = FALSE
 WHERE team_id IN ('5882aaaa-0000-0000-0000-00000000a001', '5882bbbb-0000-0000-0000-00000000b001');

-- ============================================================================
-- COLUMN SCOPING (Wave 3 -- INVERTED). `deprecated` must be the ONLY column an admin can write.
--
-- The stated guarantee is "published (team_id, skill_id, version) triples are immutable"
-- (registry-tools.live.ts, 20260724000000:23-25). UNIQUE (team_id, skill_id, version) enforces
-- that against a SECOND ROW -- not against a REWRITE of the existing one. `_admin_update` is
-- `FOR UPDATE TO authenticated` with NO column scoping, and this table originally relied on
-- Supabase's default table-wide GRANT ALL (20260724000000:20-21), which covers every column.
--
-- WAVE 1 PROVED THE GAP FOR ALL SIX COLUMNS: content, content_hash, version, description,
-- published_by (rewritten onto a DIFFERENT real auth.users row) and published_at (backdated to
-- 2020) each rewrote successfully as team-A admin, individually and in one multi-column PATCH.
-- Migration 20260729000000 closed it with `REVOKE UPDATE ON TABLE ... FROM anon, authenticated`
-- followed by `GRANT UPDATE (deprecated) ... TO authenticated`. Each block below now asserts the
-- write is REFUSED.
--
-- WHY THESE ASSERT A RAISED 42501 AND THE U-BLOCKS ASSERT ROW_COUNT = 0. The two denials are
-- different mechanisms and present differently, and conflating them would hide a regression:
--   * an RLS denial does not raise -- the row is invisible to the statement, which affects zero
--     rows (see the POLICY 3/4 header). That is what U2/U3 check.
--   * a missing COLUMN privilege is refused before any row is considered, raising
--     insufficient_privilege (42501). That is what C1-C7 check.
-- A C-block written as "expect 0 rows" would pass even if the grant came back, because RLS would
-- still filter team-B rows. Asserting the RAISE is what actually pins the grant.
--
-- Enumerating EVERY column is deliberate (What Changes §3, as broadened by cross-provider
-- review): a column-scoped grant that accidentally leaves one column in the allow-list is exactly
-- the regression this file exists to catch, and a content-only check would miss it.
-- ============================================================================

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"5882aaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

-- C0 (CONTROL): trg_prs_namespace IS armed.
--
-- WAVE 3 REWRITE, and the reason matters. In Wave 1 this control rewrote `skill_id` on an existing
-- row and expected 23514 from the namespace trigger. That probe is no longer meaningful: since
-- 20260729000000, `authenticated` holds no UPDATE privilege on `skill_id` at all, so the statement
-- is refused with 42501 BEFORE any trigger runs -- the control would be measuring the new grant,
-- not the trigger it claims to cover, and would abort the script on an uncaught 42501.
--
-- The namespace boundary is still fully armed on the path that remains reachable: INSERT. This
-- version exercises exactly that. Its role is unchanged -- prove the mechanism FIRES, so that
-- C1-C7's refusals are attributable to the column grant rather than to a coincidence.
DO $$
BEGIN
  INSERT INTO private_registry_skills (team_id, skill_id, version, content)
  VALUES ('5882aaaa-0000-0000-0000-00000000a001', 'anthropic/commit', '1.0.0',
          '{"SKILL.md":"x"}'::jsonb);
  RAISE EXCEPTION 'FAIL (C0): trg_prs_namespace did NOT reject a publish into a foreign namespace '
                  '-- the namespace boundary is not armed';
EXCEPTION
  WHEN check_violation THEN
    RAISE NOTICE 'PASS (C0 control): trg_prs_namespace armed -- publish into a foreign namespace '
                 'rejected (23514)';
  WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'FAIL (C0): the probe was refused at the privilege layer (42501) instead of by '
                    'the namespace trigger. The INSERT column list must stay within the grant '
                    '(team_id, skill_id, version, description, content) or this control measures '
                    'the wrong thing.';
END $$;

-- C1..C6: each content / server-owned column, individually, as team-A ADMIN. Every one must now
-- raise 42501. Driven from a list so a column can never be silently dropped from the sweep.
DO $$
DECLARE
  r        RECORD;
  v_sql    TEXT;
  v_leaked TEXT := '';
  v_ok     TEXT := '';
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- C1: content -- content substitution under a pinned version.
      ('C1', 'content',      'content = ''{"SKILL.md":"SUBSTITUTED"}''::jsonb'),
      -- C2: content_hash -- the drift signal read by get_skill_update_candidates()'s private arm
      -- (20260727000000:492-573). Rewriting it decouples "what devices are told changed" from
      -- "what actually changed".
      ('C2', 'content_hash', 'content_hash = repeat(''9'', 64)'),
      -- C3: version -- retarget a published row onto a different version string.
      ('C3', 'version',      'version = ''2.0.0-colscope'''),
      -- C4: description -- rewrite what the skill claims to be after members installed it.
      ('C4', 'description',  'description = ''rewritten after publish'''),
      -- C5: published_by -- provenance rewritten onto ANOTHER real auth.users row. The FK to
      -- auth.users(id) constrains the value to a REAL user, which made the forgery more
      -- credible, not less.
      ('C5', 'published_by', 'published_by = ''5882bbbb-0000-0000-0000-0000000000b2''::uuid'),
      -- C6: published_at -- backdate the publication.
      ('C6', 'published_at', 'published_at = TIMESTAMPTZ ''2020-01-01 00:00:00+00''')
    ) AS t(id, col, assignment)
  LOOP
    v_sql := 'UPDATE private_registry_skills SET ' || r.assignment ||
             ' WHERE team_id = ''5882aaaa-0000-0000-0000-00000000a001''' ||
             '   AND skill_id LIKE ''%/fixture-skill''';
    BEGIN
      EXECUTE v_sql;
      -- Reached only if the statement was ALLOWED. Whether it matched rows is irrelevant: the
      -- absence of a privilege error is itself the regression.
      v_leaked := v_leaked || r.id || '/' || r.col || ' ';
    EXCEPTION
      WHEN insufficient_privilege THEN
        v_ok := v_ok || r.col || ' ';
    END;
  END LOOP;

  IF v_leaked <> '' THEN
    RAISE EXCEPTION 'FAIL (C1-C6): team-A admin can still UPDATE these columns on an '
                    'already-published row: %. The column-scoped grant from migration '
                    '20260729000000 is missing or was widened -- "published versions are '
                    'immutable" is false for the bytes again.', v_leaked;
  END IF;
  RAISE NOTICE 'PASS (C1-C6): every server-owned/content column refused with 42501 for a team-A '
               'ADMIN -- %', v_ok;
END $$;

-- C7: one multi-column PATCH -- the shape a real PostgREST request takes. A per-column sweep can
-- pass while a combined statement slips through if a grant were ever expressed per-statement
-- rather than per-column, so this is checked separately rather than assumed from C1-C6.
DO $$
BEGIN
  UPDATE private_registry_skills
     SET content      = '{"SKILL.md":"MULTI"}'::jsonb,
         content_hash = repeat('7', 64),
         version      = '3.0.0-colscope',
         description  = 'multi-column patch',
         published_by = '5882bbbb-0000-0000-0000-0000000000b1',
         published_at = TIMESTAMPTZ '2019-06-06 06:06:06+00'
   WHERE team_id = '5882aaaa-0000-0000-0000-00000000a001' AND skill_id LIKE '%/fixture-skill';
  RAISE EXCEPTION 'FAIL (C7): a six-column PATCH was permitted for a team-A admin';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS (C7): multi-column PATCH refused (42501)';
END $$;

-- C8 (Wave 3, new): the POSITIVE half. Scoping the grant must not have broken the one write the
-- product intends. Without this, C1-C7 would also pass if UPDATE had been revoked wholesale --
-- which would break every legitimate dashboard deprecation.
DO $$
DECLARE v_rows INT; v_dep BOOLEAN;
BEGIN
  UPDATE private_registry_skills SET deprecated = TRUE
   WHERE team_id = '5882aaaa-0000-0000-0000-00000000a001' AND skill_id LIKE '%/fixture-skill';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'FAIL (C8): team-A admin could not flip `deprecated` (% rows) -- the grant was '
                    'narrowed too far and the legitimate admin path is broken', v_rows;
  END IF;
  SELECT deprecated INTO v_dep FROM private_registry_skills
   WHERE team_id = '5882aaaa-0000-0000-0000-00000000a001' AND skill_id LIKE '%/fixture-skill';
  IF v_dep IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL (C8): `deprecated` did not persist as TRUE';
  END IF;
  RAISE NOTICE 'PASS (C8): `deprecated` remains writable by a team admin -- the legitimate path '
               'survives the column scoping';
END $$;

RESET ROLE;
UPDATE private_registry_skills SET deprecated = FALSE
 WHERE team_id IN ('5882aaaa-0000-0000-0000-00000000a001', '5882bbbb-0000-0000-0000-00000000b001');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"5882aaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

-- ============================================================================
-- H1-H3 (Wave 3, new) -- server-owned provenance and integrity on the INSERT path.
--
-- What Changes §4b: `_member_insert`'s WITH CHECK constrains team_id and NOTHING else, so with a
-- table-wide grant a member could supply published_by (pointing at a colleague), published_at
-- (backdated) and a content_hash matching nothing. Migration 20260729000000 removed those three
-- from the client INSERT grant and derives them instead.
-- ============================================================================

-- H1: forging server-owned columns on INSERT is refused, per column, as a team-A MEMBER
-- (the role `_member_insert` exists to serve -- i.e. the least-privileged caller who can publish).
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"5882aaaa-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
DO $$
DECLARE
  r        RECORD;
  v_leaked TEXT := '';
  v_ok     TEXT := '';
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('published_by', 'published_by',  '''5882bbbb-0000-0000-0000-0000000000b2''::uuid'),
      ('published_at', 'published_at',  'TIMESTAMPTZ ''2020-01-01 00:00:00+00'''),
      ('content_hash', 'content_hash',  'repeat(''e'', 64)'),
      ('deprecated',   'deprecated',    'TRUE'),
      ('id',           'id',            'gen_random_uuid()')
    ) AS t(label, col, val)
  LOOP
    BEGIN
      EXECUTE format(
        'INSERT INTO private_registry_skills (team_id, skill_id, version, content, %I) '
        'VALUES (%L, current_setting(''smi5882.ns_a'') || ''/forge-probe-%s'', ''1.0.0'', '
        '''{"SKILL.md":"x"}''::jsonb, %s)',
        r.col, '5882aaaa-0000-0000-0000-00000000a001', r.label, r.val);
      v_leaked := v_leaked || r.label || ' ';
    EXCEPTION
      WHEN insufficient_privilege THEN
        v_ok := v_ok || r.label || ' ';
    END;
  END LOOP;

  IF v_leaked <> '' THEN
    RAISE EXCEPTION 'FAIL (H1): a team member can still supply these server-owned columns on '
                    'INSERT: %. Provenance is forgeable again (What Changes 4b).', v_leaked;
  END IF;
  RAISE NOTICE 'PASS (H1): every server-owned column refused on INSERT for a team member -- %', v_ok;
END $$;

-- H2: the derived values are actually correct, not merely un-forgeable. A member's legitimate
-- insert must land with a server-computed content_hash and published_by = its own auth.uid().
DO $$
DECLARE v_hash TEXT; v_by UUID; v_expected TEXT;
BEGIN
  INSERT INTO private_registry_skills (team_id, skill_id, version, content)
  VALUES ('5882aaaa-0000-0000-0000-00000000a001',
          current_setting('smi5882.ns_a') || '/derived-probe', '1.0.0',
          '{"SKILL.md":"derive me"}'::jsonb);
  SELECT content_hash, published_by INTO v_hash, v_by FROM private_registry_skills
   WHERE team_id = '5882aaaa-0000-0000-0000-00000000a001'
     AND skill_id = current_setting('smi5882.ns_a') || '/derived-probe';
  v_expected := encode(sha256(convert_to('derive me', 'UTF8')), 'hex');
  IF v_hash IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'FAIL (H2): derived content_hash is %, expected %', v_hash, v_expected;
  END IF;
  IF v_by IS DISTINCT FROM '5882aaaa-0000-0000-0000-0000000000a2'::uuid THEN
    RAISE EXCEPTION 'FAIL (H2): published_by is %, expected the inserting member''s auth.uid()',
      COALESCE(v_by::text, '<null>');
  END IF;
  RAISE NOTICE 'PASS (H2): content_hash derived server-side and published_by = auth.uid() -- '
               'attribution is now recorded, not supplied';
END $$;

-- H3: content shapes that previously reached the table are refused. These are What Changes §11's
-- first three cases, closed as a consequence of deriving the hash (the derivation needs a
-- non-empty string SKILL.md to exist, so it cannot accept a payload without one).
DO $$
DECLARE r RECORD; v_leaked TEXT := '';
BEGIN
  FOR r IN
    -- `n` keeps each probe's skill_id distinct: if one payload were ever ACCEPTED, a shared
    -- skill_id would make the next probe fail with 23505 instead of reporting the leak.
    SELECT * FROM (VALUES
      (1, 'array',            '[1,2,3]'),
      (2, 'bare string',      '"just text"'),
      (3, 'number',           '42'),
      (4, 'no SKILL.md',      '{"other.md":"x"}'),
      (5, 'non-string value', '{"SKILL.md":123}'),
      (6, 'empty SKILL.md',   '{"SKILL.md":""}')
    ) AS t(n, label, payload)
  LOOP
    BEGIN
      EXECUTE format(
        'INSERT INTO private_registry_skills (team_id, skill_id, version, content) '
        'VALUES (%L, current_setting(''smi5882.ns_a'') || ''/shape-probe-%s'', ''9.9.9'', %L::jsonb)',
        '5882aaaa-0000-0000-0000-00000000a001', r.n, r.payload);
      v_leaked := v_leaked || r.label || '; ';
    EXCEPTION
      WHEN check_violation THEN NULL; -- expected: the derivation trigger rejects it
    END;
  END LOOP;
  IF v_leaked <> '' THEN
    RAISE EXCEPTION 'FAIL (H3): these content payloads were accepted: %', v_leaked;
  END IF;
  RAISE NOTICE 'PASS (H3): non-object content, and content without a non-empty string SKILL.md, '
               'refused with 23514 on the direct-PostgREST path';
END $$;

-- ============================================================================
-- PRIVILEGE / NON-POLICY CHECKS. RLS is not the only thing standing between a role and this
-- table, and policy tests are structurally blind to the rest: a GRANT can reopen access with no
-- policy change at all, and TRUNCATE is not governed by RLS in any way.
-- ============================================================================

RESET ROLE;

-- P1: the table-privilege matrix, recorded as the current baseline. Printed rather than asserted
-- one-way because Wave 3's fix migration is specifically going to change it; the invariants that
-- must hold in BOTH worlds are asserted separately (P3, and the TRUNCATE block at the end).
DO $$
DECLARE r RECORD; v_line TEXT := '';
BEGIN
  FOR r IN
    SELECT g.rolname, p.priv,
           has_table_privilege(g.rolname::name, 'public.private_registry_skills', p.priv) AS ok
    FROM unnest(ARRAY['anon','authenticated']) AS g(rolname),
         unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])
           AS p(priv)
    ORDER BY g.rolname, p.priv
  LOOP
    v_line := v_line || r.rolname || ':' || r.priv || '=' || r.ok || '  ';
  END LOOP;
  RAISE NOTICE 'BASELINE (P1) has_table_privilege on private_registry_skills -- %', v_line;
END $$;

-- P2: column-level privileges, now ASSERTED rather than merely printed.
--
-- Wave 1 printed this as a baseline because the fix migration was going to change it. It has, so
-- the exact post-fix shape is pinned here. C1-C7/H1 test the observable behaviour; P2 tests the
-- catalog that produces it, and the two failing together is what distinguishes "the grant
-- regressed" from "a policy regressed".
DO $$
DECLARE
  r RECORD; v_upd TEXT := ''; v_ins TEXT := ''; v_bad TEXT := '';
  -- The intended allow-lists, stated once. Anything outside them must be false.
  c_upd_allowed CONSTANT TEXT[] := ARRAY['deprecated'];
  c_ins_allowed CONSTANT TEXT[] := ARRAY['team_id','skill_id','version','description','content'];
BEGIN
  FOR r IN
    SELECT c.col,
           has_column_privilege('authenticated', 'public.private_registry_skills', c.col, 'UPDATE') AS u,
           has_column_privilege('authenticated', 'public.private_registry_skills', c.col, 'INSERT') AS i
    FROM unnest(ARRAY['id','team_id','skill_id','version','description','content','content_hash',
                      'deprecated','published_by','published_at']) AS c(col)
  LOOP
    v_upd := v_upd || r.col || '=' || r.u || ' ';
    v_ins := v_ins || r.col || '=' || r.i || ' ';
    IF r.u <> (r.col = ANY(c_upd_allowed)) THEN
      v_bad := v_bad || 'UPDATE(' || r.col || ')=' || r.u || ' ';
    END IF;
    IF r.i <> (r.col = ANY(c_ins_allowed)) THEN
      v_bad := v_bad || 'INSERT(' || r.col || ')=' || r.i || ' ';
    END IF;
  END LOOP;
  RAISE NOTICE '(P2) authenticated UPDATE per column -- %', v_upd;
  RAISE NOTICE '(P2) authenticated INSERT per column -- %', v_ins;
  IF v_bad <> '' THEN
    RAISE EXCEPTION 'FAIL (P2): column privileges do not match the intended allow-lists '
                    '(UPDATE=%, INSERT=%). Divergences: %', c_upd_allowed, c_ins_allowed, v_bad;
  END IF;
  RAISE NOTICE 'PASS (P2): UPDATE is scoped to `deprecated` and INSERT to the client-supplied set';
END $$;

-- P2b (Wave 3, new): anon EXECUTE on the three team helpers is revoked BY NAME, while
-- authenticated + service_role keep it. Wave 1 found anon held EXECUTE on all three despite
-- 071:65-70's `REVOKE ALL ... FROM PUBLIC` -- an explicit Supabase default-privileges grant that a
-- PUBLIC-scoped revoke cannot remove (same class as SMI-5510). If authenticated ever loses these,
-- every RLS policy on this table silently stops evaluating, so both directions are asserted.
DO $$
DECLARE r RECORD; v_bad TEXT := ''; v_line TEXT := '';
BEGIN
  FOR r IN
    SELECT g.rolname, f.fn,
           has_function_privilege(g.rolname::name, to_regprocedure(f.fn), 'EXECUTE') AS ok
    FROM unnest(ARRAY['public.user_team_ids()','public.user_member_team_ids()',
                      'public.user_admin_team_ids()']) AS f(fn),
         unnest(ARRAY['anon','authenticated','service_role']) AS g(rolname)
  LOOP
    v_line := v_line || r.rolname || ':' || r.fn || '=' || r.ok || '  ';
    IF r.rolname = 'anon' AND r.ok THEN
      v_bad := v_bad || 'anon still holds EXECUTE on ' || r.fn || '; ';
    ELSIF r.rolname <> 'anon' AND NOT r.ok THEN
      v_bad := v_bad || r.rolname || ' LOST EXECUTE on ' || r.fn || '; ';
    END IF;
  END LOOP;
  IF v_bad <> '' THEN
    RAISE EXCEPTION 'FAIL (P2b): %  (full matrix: %)', v_bad, v_line;
  END IF;
  RAISE NOTICE 'PASS (P2b): anon EXECUTE revoked on all three team helpers; authenticated + '
               'service_role retain it -- %', v_line;
END $$;

-- P3: no authenticated DELETE reaches a row. There is no delete policy and no delete in the
-- product ("No delete (out of scope, ADR-123/129)", 20260724000000:62). Assert the OUTCOME, not
-- the absence of a policy: the table grant includes DELETE, so only RLS stops it -- and an
-- RLS-filtered DELETE affects zero rows silently rather than raising.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"5882aaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
DO $$
DECLARE v_rows INT;
BEGIN
  DELETE FROM private_registry_skills WHERE team_id = '5882aaaa-0000-0000-0000-00000000a001';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'FAIL (P3): team-A admin DELETEd % rows -- there is no delete policy, so this '
                    'is a data-destruction path the product does not intend', v_rows;
  END IF;
  RAISE NOTICE 'PASS (P3): authenticated DELETE reaches 0 rows (RLS default-deny). Note the '
               'table-level DELETE GRANT itself is still present -- see the P1 baseline.';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS (P3): authenticated denied DELETE at the privilege layer';
END $$;

-- P3b: privileged confirmation that the rows survived P3 (a DELETE that silently removed rows
-- while reporting 0 would be the worst possible outcome to miss).
RESET ROLE;
DO $$
DECLARE v_left INT;
BEGIN
  SELECT count(*) INTO v_left FROM private_registry_skills
   WHERE team_id = '5882aaaa-0000-0000-0000-00000000a001';
  IF v_left < 1 THEN
    RAISE EXCEPTION 'FAIL (P3b): team-A rows are gone after the authenticated DELETE attempt';
  END IF;
  RAISE NOTICE 'PASS (P3b): % team-A row(s) survived the DELETE attempt', v_left;
END $$;

-- P4: EXECUTE grants on the definer trigger functions. 20260727000000 explicitly REVOKEs
-- EXECUTE on both from anon and authenticated (steps 6 and 7).
DO $$
DECLARE r RECORD; v_bad TEXT := ''; v_ok TEXT := ''; v_p oid;
BEGIN
  FOR r IN
    SELECT f.fn, g.rolname
    FROM unnest(ARRAY['public.enforce_private_skill_namespace()',
                      'public.prevent_skill_namespace_mutation()']) AS f(fn),
         unnest(ARRAY['anon','authenticated']) AS g(rolname)
  LOOP
    v_p := to_regprocedure(r.fn);
    IF v_p IS NULL THEN
      RAISE EXCEPTION 'FAIL (P4): function % does not exist', r.fn;
    END IF;
    IF has_function_privilege(r.rolname::name, v_p, 'EXECUTE') THEN
      v_bad := v_bad || r.rolname || '->' || r.fn || ' ';
    ELSE
      v_ok := v_ok || r.rolname || '->' || r.fn || ' ';
    END IF;
  END LOOP;
  IF v_bad <> '' THEN
    RAISE EXCEPTION 'FAIL (P4): EXECUTE is NOT revoked as the migration claims: %', v_bad;
  END IF;
  RAISE NOTICE 'PASS (P4): EXECUTE denied for anon+authenticated on both definer trigger '
               'functions -- %', v_ok;
END $$;

-- P4b: the RLS helper functions the policies depend on must stay EXECUTE-able by authenticated
-- (071:68-70), and ensure_team_for_subscription is deliberately service_role-only (073:168-170).
-- A silent regression here changes who the policies can even be evaluated for.
DO $$
DECLARE r RECORD; v_line TEXT := ''; v_p oid; v_fail TEXT := '';
BEGIN
  FOR r IN
    SELECT f.fn, g.rolname
    FROM unnest(ARRAY['public.user_team_ids()','public.user_member_team_ids()',
                      'public.user_admin_team_ids()',
                      'public.ensure_team_for_subscription(text)']) AS f(fn),
         unnest(ARRAY['anon','authenticated','service_role']) AS g(rolname)
  LOOP
    v_p := to_regprocedure(r.fn);
    IF v_p IS NULL THEN
      RAISE EXCEPTION 'FAIL (P4b): function % does not exist', r.fn;
    END IF;
    v_line := v_line || r.rolname || ':' || r.fn || '=' ||
              has_function_privilege(r.rolname::name, v_p, 'EXECUTE') || '  ';
  END LOOP;
  IF NOT has_function_privilege('authenticated',
       to_regprocedure('public.user_team_ids()'), 'EXECUTE') THEN
    v_fail := v_fail || 'authenticated lost EXECUTE on user_team_ids(); ';
  END IF;
  IF has_function_privilege('authenticated',
       to_regprocedure('public.ensure_team_for_subscription(text)'), 'EXECUTE') THEN
    v_fail := v_fail || 'authenticated GAINED EXECUTE on ensure_team_for_subscription(); ';
  END IF;
  IF v_fail <> '' THEN
    RAISE EXCEPTION 'FAIL (P4b): %  (full matrix: %)', v_fail, v_line;
  END IF;
  RAISE NOTICE 'PASS (P4b) EXECUTE matrix -- %', v_line;
END $$;

-- P5: every helper this table depends on must pin search_path. Recorded as a confirm-not-broken
-- check: the reviewed functions already set `search_path = public, pg_temp`. It exists so a
-- future definer function added without it fails loudly.
DO $$
DECLARE r RECORD; v_bad TEXT := '';
BEGIN
  FOR r IN
    SELECT p.proname, p.proconfig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('enforce_private_skill_namespace','prevent_skill_namespace_mutation',
                        'derive_team_skill_namespace','user_team_ids','user_member_team_ids',
                        'user_admin_team_ids','ensure_team_for_subscription')
  LOOP
    IF r.proconfig IS NULL
       OR NOT EXISTS (SELECT 1 FROM unnest(r.proconfig) AS c WHERE c LIKE 'search_path=%') THEN
      v_bad := v_bad || r.proname || ' ';
    END IF;
  END LOOP;
  IF v_bad <> '' THEN
    RAISE EXCEPTION 'FAIL (P5): these functions do not pin search_path: %', v_bad;
  END IF;
  RAISE NOTICE 'PASS (P5): all namespace/RLS helper functions pin search_path';
END $$;

-- ============================================================================
-- MIGRATION-073 NAMESPACE-COLLISION RACE (Wave 1 Step 6) -- PARTIAL ONLY. READ BEFORE CITING.
--
-- The disputed question is whether 073:119-134's `unique_violation` retry recovers when
-- derive_team_skill_namespace() re-derives from an UNCHANGED NEW.name (the retry regenerates
-- only v_slug, 073:132; v_team_name is never touched, and the trigger derives v_base from
-- NEW.name at 20260727000000:243). The two readings diverge on exactly ONE thing: whether the
-- retry's fresh INSERT statement sees a competing team that COMMITTED after this transaction
-- began.
--
-- THAT DISTINCTION CANNOT BE TESTED FROM THIS SCRIPT, and no approximation of it is attempted:
--   * a single transaction cannot model two transactions racing. Sequential DO blocks share one
--     XID and one snapshot lineage, so any "collision" staged here is not the collision under
--     dispute, and calling it one would be a fabricated result.
--   * the .sh wrapper COULD background two psql connections, but the deciding interleaving
--     requires the WINNER to actually COMMIT a `teams` row (plus subscriptions / profiles /
--     auth.users rows to satisfy ensure_team_for_subscription's preconditions) so the loser's
--     retry can see it. That destroys this script's whole safety property -- every fixture rolled
--     back -- and replaces a two-gate guarantee with a cleanup script. Deliberately not done.
-- The disputed finding in What Changes §8 therefore remains OPEN. Settling it needs a
-- multi-connection harness (two `pg` clients, or two psql sessions coordinated by
-- pg_advisory_xact_lock) with its own fixture-cleanup path, against a database where committing
-- and then deleting fixture teams is acceptable -- i.e. a local Supabase stack once SMI-5885's
-- fresh-replay bug is fixed, NOT staging.
--
-- What N1 DOES establish empirically -- and it is the mechanism Reading B depends on -- is that
-- the derivation trigger's suffix loop steers away from a competing namespace WHEN THAT
-- COMPETITOR IS VISIBLE. Had N1 failed, Reading B would be dead without any concurrency test at
-- all. N1 passing narrows the dispute to visibility timing alone; it does not settle it.
-- ============================================================================

DO $$
DECLARE
  c_t1 CONSTANT TEXT := '5882cccc-0000-0000-0000-00000000c001';
  c_t2 CONSTANT TEXT := '5882cccc-0000-0000-0000-00000000c002';
  v_ns1 TEXT; v_ns2 TEXT;
BEGIN
  INSERT INTO teams (id, name, owner_id)
  VALUES (c_t1, 'SMI5882 Race Probe Team', '5882aaaa-0000-0000-0000-0000000000a1');
  INSERT INTO teams (id, name, owner_id)
  VALUES (c_t2, 'SMI5882 Race Probe Team', '5882aaaa-0000-0000-0000-0000000000a1');

  SELECT skill_namespace INTO v_ns1 FROM teams WHERE id = c_t1;
  SELECT skill_namespace INTO v_ns2 FROM teams WHERE id = c_t2;

  IF v_ns1 IS NULL OR v_ns2 IS NULL THEN
    RAISE EXCEPTION 'FAIL (N1): a race-probe team got a NULL namespace (1=%, 2=%)',
      COALESCE(v_ns1, '<null>'), COALESCE(v_ns2, '<null>');
  END IF;
  IF v_ns1 = v_ns2 THEN
    RAISE EXCEPTION 'FAIL (N1): two identically-named teams derived the SAME namespace (%)', v_ns1;
  END IF;
  IF v_ns2 !~ '-t[0-9a-f]{6}$' THEN
    RAISE EXCEPTION 'FAIL (N1): second team''s namespace "%" is not the trigger''s suffixed form',
      v_ns2;
  END IF;
  RAISE NOTICE 'PARTIAL PASS (N1): identical team names -> distinct namespaces (% vs %) via the '
               'trigger''s own suffix loop, with the competitor VISIBLE. This is Reading B''s '
               'mechanism working; it does NOT test concurrency and does NOT settle the disputed '
               '073 retry question -- see this block''s header.', v_ns1, v_ns2;
END $$;

-- ============================================================================
-- FINAL ASSERTION -- TRUNCATE denial (Wave 3: INVERTED, now expected GREEN). Still LAST.
--
-- RLS does not govern TRUNCATE at all, so this tests the table-level grant, not a policy -- and it
-- is the single command that could wipe every tenant's private registry in one statement. This is
-- the exact shape of smi-5817-rls-role-boundary.sql:81-88, applied to this table.
--
-- WAVE 1 RESULT: this block ABORTED the script. Prod's relacl was
--   {postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,...}
-- and `D` is TRUNCATE, so `authenticated` truncated the table (block T1, the run's non-zero exit).
-- Migration 20260729000000 revoked TRUNCATE from both client roles, so a clean run now reaches
-- the PASS notice and exits 0.
--
-- It stays LAST for the same reason it was last before: if the revoke is ever reverted, the
-- TRUNCATE succeeds, and no earlier assertion should be able to be masked by that. The abort still
-- rolls the whole transaction back, TRUNCATE included (TRUNCATE is transactional in Postgres).
--
-- Severity framing, unchanged and stated so the fix is neither over- nor under-sold: PostgREST
-- exposes no TRUNCATE verb, so this was never reachable by an ordinary dashboard user holding a
-- JWT. It was a defense-in-depth gap on the same footing as the one SMI-5817 closed by REVOKE on
-- its own table, and it matters for any direct-SQL or pooled-connection path running as
-- `authenticated`.
-- ============================================================================

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"5882aaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
DO $$
BEGIN
  TRUNCATE private_registry_skills;
  RAISE EXCEPTION 'FAIL (T1): authenticated could TRUNCATE private_registry_skills -- one statement '
                  'wipes every tenant''s private registry. Migration 20260729000000''s '
                  '`REVOKE ... TRUNCATE ... FROM anon, authenticated` is missing or was reverted.';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS (T1): authenticated denied TRUNCATE on private_registry_skills';
END $$;

-- T2 (Wave 3, new): the same for anon. anon has no policy on this table, but TRUNCATE never
-- consults policies -- so anon's TRUNCATE grant would have been just as total as authenticated's.
RESET ROLE;
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
DO $$
BEGIN
  TRUNCATE private_registry_skills;
  RAISE EXCEPTION 'FAIL (T2): anon could TRUNCATE private_registry_skills';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS (T2): anon denied TRUNCATE on private_registry_skills';
END $$;

RESET ROLE;
ROLLBACK;
