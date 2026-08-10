-- ============================================================================
-- Invocation: run via scripts/staging/smi-5949-approval-gate-rls-boundary.sh (from any cwd --
-- that wrapper resolves this file's path relative to its own location, not the caller's cwd, and
-- refuses to run if this file is missing). Never invoke this file directly through
-- `./scripts/pooler-psql.sh -f <path>` -- that resolves the path INSIDE the container, and from a
-- worktree resolves against the MAIN checkout's container (SMI-5559), where this file does not
-- exist. See the wrapper's own header for the exact piped-stdin form it uses; do not hand-
-- reproduce it here where it could drift out of sync.
-- ============================================================================

-- SMI-5949 staging verification: the private-registry approval gate's RLS + role boundary.
-- Adapted from scripts/staging/smi-5882-private-registry-rls-role-boundary.sql, the working
-- precedent for role-switching verification against this database (SET LOCAL ROLE +
-- request.jwt.claims, BEGIN/ROLLBACK fixtures, self-verifying DO blocks, two-gate prod-safety
-- refusal).
--
-- WHY THIS FILE IS THE REAL PROOF, AND THE UNIT TESTS ARE NOT. The approval gate's central
-- property -- a pending row has NO PostgREST read path, not even for its own submitter -- is
-- enforced by an RLS policy. Two of the five read surfaces (the private-registry-get Edge Function
-- and getSkillContent()) are protected by that policy with ZERO application-code change, which
-- means their unit tests cannot regress and cannot confirm: a mocked Supabase client does not
-- evaluate a policy. Green CI proves the TypeScript agrees with its fixtures and nothing more. The
-- migration's own DO-block smoke suite (20260809000001) is stronger, but it runs as the migration
-- owner, which bypasses RLS on its own table; only role impersonation against a real Postgres
-- closes that gap. That is this file.
--
-- WHY THIS IS A STAGING SCRIPT AND NOT A VITEST SUITE. Unchanged from SMI-5882: a CI-wired
-- live-Postgres harness is not buildable today, because the full supabase/migrations/ set has been
-- un-replayable onto an empty database since 2026-06-01 (20260526000001 hardcodes
-- search_metrics_202604/05/06 while 20260519000003 creates partitions relative to NOW()), filed
-- as SMI-5885. This is weaker than CI regression coverage and should be described as such -- it
-- runs when a human runs it.
--
-- STAGING ONLY (ovhcifugwqnzoebwfuku). All fixtures rolled back.
--
-- HARD GUARD. This script INSERTs rows into auth.users, profiles, teams, team_members and
-- private_registry_skills. Running it against prod would create real orphaned auth users and real
-- fixture tenants. `pooler-psql.sh` connects with SUPABASE_PROJECT_REF, which in .env is the PROD
-- ref -- so "I ran the documented command" is NOT evidence that this hit staging. Two independent
-- gates:
--   (1) the shell wrapper refuses unless STAGING_SUPABASE_PROJECT_REF is set, and passes it in as
--       :confirm_ref;
--   (2) this block refuses unless :confirm_ref is BOTH set AND equal to the staging ref.
-- A bare `cat file | ./scripts/pooler-psql.sh` leaves :confirm_ref unset and stops at (2).
--
-- READING THE OUTPUT. Every check is self-verifying: it emits `NOTICE: ... PASS ...` or it raises.
-- A clean run exits 0. ANY non-zero exit is a real finding.
--
-- **RUN ORDER MATTERS.** Against a database where 20260809000000_private_registry_approval_gate.sql
-- has NOT been applied, this file is expected to fail immediately (block F2, the control). It is
-- the POST-apply verification.
\set ON_ERROR_STOP on

-- `\quit` deliberately NOT used here: it exits psql with status 0 (it is not an error to psql,
-- just an early stop), which would make a bare `cat file | ./scripts/pooler-psql.sh` -- skipping
-- the wrapper entirely -- silently "succeed" having asserted nothing. A RAISE EXCEPTION inside
-- ON_ERROR_STOP is what actually makes this refusal a non-zero exit.
\if :{?confirm_ref}
\else
  \echo '*** REFUSING: :confirm_ref is not set. Run this through'
  \echo '*** scripts/staging/smi-5949-approval-gate-rls-boundary.sh'
  DO $guard0$ BEGIN
    RAISE EXCEPTION 'REFUSING: :confirm_ref is not set -- this script must be invoked via '
                    'scripts/staging/smi-5949-approval-gate-rls-boundary.sh, never piped '
                    'directly.';
  END $guard0$;
\endif

SELECT :'confirm_ref' = 'ovhcifugwqnzoebwfuku' AS is_staging \gset
\if :is_staging
\else
  \echo '*** REFUSING: connected project ref is not staging.'
  DO $guard$ BEGIN
    RAISE EXCEPTION 'REFUSING: this script INSERTs fixture rows into auth.users and creates '
                    'fixture tenants; it may only run against staging (ovhcifugwqnzoebwfuku).';
  END $guard$;
\endif

BEGIN;

-- ============================================================================
-- FIXTURES. Two tenants, five users, distinct team_members.role values.
--
-- WHY TEAM A NEEDS *TWO* ADMINS. D-1 restricts approval to user_admin_team_ids() and D-6 forbids
-- self-approval, so a team whose only admin is also the publisher cannot get anything approved --
-- a real state, named in D-9, whose remediation is "promote a second admin". A3 exists so block
-- W4 has a legitimate approver at all; A1 exists so W1 can reach the self-approval check (step 3,
-- the admin check, is evaluated BEFORE step 7, so a non-admin submitter would be refused for the
-- wrong reason and W1 would prove nothing).
--
-- teams.skill_namespace is NOT set explicitly anywhere below: it must be produced by
-- derive_team_skill_namespace() (BEFORE INSERT ON teams, 20260727000000:270-276). Setting it
-- directly would make every namespace assertion here prove nothing about the real team-creation
-- path.
-- ============================================================================

INSERT INTO auth.users (id, email) VALUES
  ('5949aaaa-0000-0000-0000-0000000000a1', 'smi5949-a1-admin@example.test'),
  ('5949aaaa-0000-0000-0000-0000000000a2', 'smi5949-a2-member@example.test'),
  ('5949aaaa-0000-0000-0000-0000000000a3', 'smi5949-a3-admin@example.test'),
  ('5949bbbb-0000-0000-0000-0000000000b1', 'smi5949-b1-owner@example.test'),
  ('5949bbbb-0000-0000-0000-0000000000b2', 'smi5949-b2-member@example.test')
ON CONFLICT (id) DO NOTHING;

INSERT INTO profiles (id, email, tier, role) VALUES
  ('5949aaaa-0000-0000-0000-0000000000a1', 'smi5949-a1-admin@example.test',  'enterprise', 'user'),
  ('5949aaaa-0000-0000-0000-0000000000a2', 'smi5949-a2-member@example.test', 'enterprise', 'user'),
  ('5949aaaa-0000-0000-0000-0000000000a3', 'smi5949-a3-admin@example.test',  'enterprise', 'user'),
  ('5949bbbb-0000-0000-0000-0000000000b1', 'smi5949-b1-owner@example.test',  'enterprise', 'user'),
  ('5949bbbb-0000-0000-0000-0000000000b2', 'smi5949-b2-member@example.test', 'enterprise', 'user')
ON CONFLICT (id) DO UPDATE SET tier = EXCLUDED.tier;

INSERT INTO teams (id, name, owner_id) VALUES
  ('5949aaaa-0000-0000-0000-00000000a001', 'SMI5949 Approval Boundary Alpha',
   '5949aaaa-0000-0000-0000-0000000000a1'),
  ('5949bbbb-0000-0000-0000-00000000b001', 'SMI5949 Approval Boundary Bravo',
   '5949bbbb-0000-0000-0000-0000000000b1')
ON CONFLICT (id) DO NOTHING;

INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES
  ('5949aaaa-0000-0000-0000-00000000a001', '5949aaaa-0000-0000-0000-0000000000a1', 'admin',  NOW()),
  ('5949aaaa-0000-0000-0000-00000000a001', '5949aaaa-0000-0000-0000-0000000000a2', 'member', NOW()),
  ('5949aaaa-0000-0000-0000-00000000a001', '5949aaaa-0000-0000-0000-0000000000a3', 'admin',  NOW()),
  ('5949bbbb-0000-0000-0000-00000000b001', '5949bbbb-0000-0000-0000-0000000000b1', 'owner',  NOW()),
  ('5949bbbb-0000-0000-0000-00000000b001', '5949bbbb-0000-0000-0000-0000000000b2', 'member', NOW())
ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role;

-- Stash both namespaces in transaction-local custom GUCs while still privileged. WHY: the
-- impersonated roles below must build a namespace-correct skill_id, but `teams` is itself
-- RLS-protected. If a negative test resolved the namespace by reading `teams` and came back
-- empty, trg_prs_namespace (23514) would reject the insert before the policy under test was ever
-- evaluated -- the test would report "denied" while never touching the thing it claims to cover.
-- Custom GUCs are readable by every role. (psql's :vars cannot be used: psql does not interpolate
-- variables inside dollar-quoted DO bodies.)
SELECT set_config('smi5949.ns_a',
  (SELECT skill_namespace FROM teams WHERE id = '5949aaaa-0000-0000-0000-00000000a001'), true);
SELECT set_config('smi5949.ns_b',
  (SELECT skill_namespace FROM teams WHERE id = '5949bbbb-0000-0000-0000-00000000b001'), true);

-- Fixture rows. published_by is server-derived from auth.uid() (20260729000000:229) and the
-- approval trigger now REFUSES a NULL one, so every seeded row needs a JWT claim set first.
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '5949aaaa-0000-0000-0000-0000000000a2', 'role', 'authenticated')::text,
  true);
INSERT INTO private_registry_skills (team_id, skill_id, version, description, content)
SELECT t.id, t.skill_namespace || '/legacy-fixture', '1.0.0', 'stands in for a pre-feature row',
       '{"SKILL.md":"legacy"}'::jsonb
FROM teams t WHERE t.id = '5949aaaa-0000-0000-0000-00000000a001';
INSERT INTO private_registry_skills (team_id, skill_id, version, description, content)
SELECT t.id, t.skill_namespace || '/queue-probe', '1.0.0', 'pending, published by a plain member',
       '{"SKILL.md":"queue"}'::jsonb
FROM teams t WHERE t.id = '5949aaaa-0000-0000-0000-00000000a001';
INSERT INTO private_registry_skills (team_id, skill_id, version, description, content)
SELECT t.id, t.skill_namespace || '/reject-probe', '1.0.0', 'pending, destined for rejection',
       '{"SKILL.md":"reject"}'::jsonb
FROM teams t WHERE t.id = '5949aaaa-0000-0000-0000-00000000a001';

-- Published by A1, who IS an admin -- the only way block W1 can reach the self-approval check.
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '5949aaaa-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text,
  true);
INSERT INTO private_registry_skills (team_id, skill_id, version, description, content)
SELECT t.id, t.skill_namespace || '/self-probe', '1.0.0', 'pending, published by an admin',
       '{"SKILL.md":"self"}'::jsonb
FROM teams t WHERE t.id = '5949aaaa-0000-0000-0000-00000000a001';

SELECT set_config('request.jwt.claims',
  json_build_object('sub', '5949bbbb-0000-0000-0000-0000000000b1', 'role', 'authenticated')::text,
  true);
INSERT INTO private_registry_skills (team_id, skill_id, version, description, content)
SELECT t.id, t.skill_namespace || '/other-tenant', '1.0.0', 'second tenant, pending',
       '{"SKILL.md":"other"}'::jsonb
FROM teams t WHERE t.id = '5949bbbb-0000-0000-0000-00000000b001';

-- Stand in for a GRANDFATHERED row -- the state the ADD COLUMN DEFAULT left every pre-migration
-- row in (D-9). Done with a privileged UPDATE rather than through the review RPC on purpose: a
-- grandfathered row has approval_mode='auto' and approved_by=NULL, which the RPC can never
-- produce, and this is the ONLY population whose behaviour must be completely unchanged.
UPDATE private_registry_skills
   SET approval_status = 'approved', approval_mode = 'auto'
 WHERE team_id = '5949aaaa-0000-0000-0000-00000000a001'
   AND skill_id = current_setting('smi5949.ns_a') || '/legacy-fixture';

SELECT set_config('request.jwt.claims', '', true);

-- ---------------------------------------------------------------------------
-- F1. Setup sanity. Without this, a policy that filtered EVERYTHING for EVERYONE would make every
-- "sees zero rows" assertion below pass vacuously.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  c_a CONSTANT TEXT := '5949aaaa-0000-0000-0000-00000000a001';
  c_b CONSTANT TEXT := '5949bbbb-0000-0000-0000-00000000b001';
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
  IF current_setting('smi5949.ns_a', true) IS DISTINCT FROM v_ns_a
     OR current_setting('smi5949.ns_b', true) IS DISTINCT FROM v_ns_b THEN
    RAISE EXCEPTION 'FAIL (F1): namespace GUCs did not take (a=%, b=%)',
      current_setting('smi5949.ns_a', true), current_setting('smi5949.ns_b', true);
  END IF;
  SELECT count(*) INTO v_rows FROM private_registry_skills WHERE team_id IN (c_a, c_b);
  IF v_rows <> 5 THEN
    RAISE EXCEPTION 'FAIL (F1): expected 5 fixture rows visible to the privileged setup role, got %',
      v_rows;
  END IF;
  RAISE NOTICE 'PASS (F1): namespaces A=% B=%, 5 fixture rows visible privileged', v_ns_a, v_ns_b;
END $$;

-- ---------------------------------------------------------------------------
-- F2 (CONTROL). trg_prs_approval IS armed. Every fixture row above was inserted WITHOUT naming
-- approval_status, so if the trigger is absent they are all sitting at the column DEFAULT. If that
-- default were still 'approved' -- i.e. if 20260809000000's two ALTER statements were reordered --
-- every "pending is invisible" assertion below would pass for the wrong reason, or fail for the
-- wrong reason. Prove the mechanism fires before relying on its silence.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  c_a CONSTANT TEXT := '5949aaaa-0000-0000-0000-00000000a001';
  v_ns TEXT := current_setting('smi5949.ns_a');
  v_pending INT; v_legacy_status TEXT; v_legacy_mode TEXT; v_default TEXT;
BEGIN
  SELECT count(*) INTO v_pending
    FROM private_registry_skills
   WHERE team_id = c_a
     AND skill_id IN (v_ns || '/queue-probe', v_ns || '/self-probe', v_ns || '/reject-probe')
     AND approval_status = 'pending' AND approval_mode = 'review';
  IF v_pending <> 3 THEN
    RAISE EXCEPTION 'FAIL (F2): only % of 3 seeded rows landed pending/review. trg_prs_approval is '
                    'not armed -- migration 20260809000000 has not been applied to this database, '
                    'and every assertion below is meaningless.', v_pending;
  END IF;

  SELECT approval_status, approval_mode INTO v_legacy_status, v_legacy_mode
    FROM private_registry_skills WHERE team_id = c_a AND skill_id = v_ns || '/legacy-fixture';
  IF v_legacy_status IS DISTINCT FROM 'approved' OR v_legacy_mode IS DISTINCT FROM 'auto' THEN
    RAISE EXCEPTION 'FAIL (F2): the grandfathered stand-in reads %/% instead of approved/auto',
      v_legacy_status, v_legacy_mode;
  END IF;

  SELECT pg_get_expr(d.adbin, d.adrelid) INTO v_default
    FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
   WHERE d.adrelid = 'public.private_registry_skills'::regclass AND a.attname = 'approval_status';
  IF v_default IS NULL OR v_default NOT LIKE '%pending%' THEN
    RAISE EXCEPTION 'FAIL (F2): approval_status DEFAULT is % -- the gate does not fail closed',
      COALESCE(v_default, '<none>');
  END IF;

  RAISE NOTICE 'PASS (F2): trigger armed (3 pending), grandfathered row approved/auto, DEFAULT is '
               'pending';
END $$;

-- ---------------------------------------------------------------------------
-- R1-R4. THE READ BOUNDARY -- the crux of the whole feature. A pending row has no PostgREST read
-- path at all. R4 is the positive control that stops R1-R3 passing vacuously.
-- ---------------------------------------------------------------------------
RESET ROLE;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '5949aaaa-0000-0000-0000-0000000000a2', 'role', 'authenticated')::text,
  true);
SET LOCAL ROLE authenticated;

-- R1 (negative): the SUBMITTER cannot see its own pending row. This is the strictest reading of
-- "not live until approved" and it is what makes the policy predicate a single equality -- the
-- looser alternative (submitter may read their own pending work) would need an application-layer
-- content filter on two transports, which is the exact failure mode `deprecated` already
-- demonstrates on this table.
-- R4 (positive, same session): the grandfathered approved row IS visible, so this member is not
-- simply blind to the table.
DO $$
DECLARE
  v_ns TEXT := current_setting('smi5949.ns_a');
  v_pending INT; v_approved INT;
BEGIN
  SELECT count(*) INTO v_pending FROM private_registry_skills
   WHERE skill_id IN (v_ns || '/queue-probe', v_ns || '/reject-probe');
  IF v_pending <> 0 THEN
    RAISE EXCEPTION 'FAIL (R1): the submitter can SELECT % of its own pending row(s). '
                    'private_registry_skills_member_read is missing the '
                    '`approval_status = ''approved''` conjunct -- unreviewed content is readable '
                    'through PostgREST, the private-registry-get Edge Function and '
                    'getSkillContent(), all three of which rely on this policy alone.', v_pending;
  END IF;

  SELECT count(*) INTO v_approved FROM private_registry_skills
   WHERE skill_id = v_ns || '/legacy-fixture';
  IF v_approved <> 1 THEN
    RAISE EXCEPTION 'FAIL (R4): the grandfathered APPROVED row is not visible to a team member '
                    '(saw % rows). Either the policy denies everything -- making R1 vacuous -- or '
                    'the migration broke every already-published version.', v_approved;
  END IF;
  RAISE NOTICE 'PASS (R1/R4): pending invisible to its own submitter; grandfathered approved row '
               'still visible';
END $$;

-- R2 (negative, admin): an ADMIN cannot see a pending row either. Review UX is served by
-- get_private_registry_submissions(), which has no `content` column -- see V1-V4.
RESET ROLE;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '5949aaaa-0000-0000-0000-0000000000a3', 'role', 'authenticated')::text,
  true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_ns TEXT := current_setting('smi5949.ns_a');
  v_rows INT;
BEGIN
  SELECT count(*) INTO v_rows FROM private_registry_skills
   WHERE skill_id IN (v_ns || '/queue-probe', v_ns || '/self-probe', v_ns || '/reject-probe');
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'FAIL (R2): an admin can SELECT % pending row(s) directly. Pending CONTENT '
                    'must be unreachable on every transport -- the review surface is the '
                    'content-free RPC, not this table.', v_rows;
  END IF;
  RAISE NOTICE 'PASS (R2): pending rows invisible to a team admin';
END $$;

-- R3 (negative, anon): there is intentionally no anon policy (20260724000000:20-22), so RLS
-- default-denies anon every row -- pending or approved. Recorded as a confirm-not-broken baseline.
RESET ROLE;
SELECT set_config('request.jwt.claims', '', true);
SET LOCAL ROLE anon;
DO $$
DECLARE v_rows INT;
BEGIN
  SELECT count(*) INTO v_rows FROM private_registry_skills;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'FAIL (R3): anon can SELECT % private_registry_skills row(s)', v_rows;
  END IF;
  RAISE NOTICE 'PASS (R3): anon sees zero rows';
END $$;

-- ---------------------------------------------------------------------------
-- V1-V4. get_private_registry_submissions() -- the metadata-only review window. This is what
-- makes the strict R1/R2 boundary usable: submitters and admins can still SEE that something is
-- queued, without any transport being able to fetch its content.
-- ---------------------------------------------------------------------------
RESET ROLE;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '5949aaaa-0000-0000-0000-0000000000a2', 'role', 'authenticated')::text,
  true);
SET LOCAL ROLE authenticated;

-- V1: the submitter sees its OWN pending rows (queue-probe, reject-probe) plus the approved one,
--     but NOT the pending row published by someone else (self-probe, published by A1).
DO $$
DECLARE
  c_a CONSTANT TEXT := '5949aaaa-0000-0000-0000-00000000a001';
  v_ns TEXT := current_setting('smi5949.ns_a');
  v_own INT; v_other INT; v_approved INT;
BEGIN
  SELECT count(*) INTO v_own FROM get_private_registry_submissions(c_a)
   WHERE skill_id IN (v_ns || '/queue-probe', v_ns || '/reject-probe');
  SELECT count(*) INTO v_other FROM get_private_registry_submissions(c_a)
   WHERE skill_id = v_ns || '/self-probe';
  SELECT count(*) INTO v_approved FROM get_private_registry_submissions(c_a, 'approved');

  IF v_own <> 2 THEN
    RAISE EXCEPTION 'FAIL (V1): a submitter sees % of its own 2 pending submissions -- it cannot '
                    'tell whether its own publish landed at all', v_own;
  END IF;
  IF v_other <> 0 THEN
    RAISE EXCEPTION 'FAIL (V1): a plain member sees another member''s pending submission. Only the '
                    'submitter and team admins may.';
  END IF;
  IF v_approved <> 1 THEN
    RAISE EXCEPTION 'FAIL (V1): p_status=''approved'' returned % rows, expected the 1 '
                    'grandfathered row', v_approved;
  END IF;
  RAISE NOTICE 'PASS (V1): submitter sees own pending (2) + approved (1), not a peer''s pending';
END $$;

-- V2: an ADMIN sees every non-approved row in the team, which is the queue they must act on.
RESET ROLE;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '5949aaaa-0000-0000-0000-0000000000a3', 'role', 'authenticated')::text,
  true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  c_a CONSTANT TEXT := '5949aaaa-0000-0000-0000-00000000a001';
  v_pending INT;
BEGIN
  SELECT count(*) INTO v_pending FROM get_private_registry_submissions(c_a, 'pending');
  IF v_pending <> 3 THEN
    RAISE EXCEPTION 'FAIL (V2): an admin sees % of the 3 pending submissions -- the review queue '
                    'is incomplete, so submissions would sit unreviewed forever', v_pending;
  END IF;
  RAISE NOTICE 'PASS (V2): admin sees all 3 pending submissions';
END $$;

-- V3 (cross-tenant): a member of team B gets NOTHING for team A, and the RPC does not distinguish
--     "not your team" from "nothing queued" -- so it cannot be used to probe team ids.
RESET ROLE;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '5949bbbb-0000-0000-0000-0000000000b2', 'role', 'authenticated')::text,
  true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  c_a CONSTANT TEXT := '5949aaaa-0000-0000-0000-00000000a001';
  c_b CONSTANT TEXT := '5949bbbb-0000-0000-0000-00000000b001';
  v_cross INT; v_own INT; v_bogus INT;
BEGIN
  SELECT count(*) INTO v_cross FROM get_private_registry_submissions(c_a);
  IF v_cross <> 0 THEN
    RAISE EXCEPTION 'FAIL (V3): a member of team B sees % of team A''s submissions -- the RPC is '
                    'SECURITY DEFINER, so its in-body user_team_ids() check is the ONLY tenant '
                    'boundary it has', v_cross;
  END IF;
  SELECT count(*) INTO v_own FROM get_private_registry_submissions(c_b);
  IF v_own <> 0 THEN
    RAISE EXCEPTION 'FAIL (V3): a plain member of team B sees % of its own team''s rows -- team '
                    'B''s only row is pending and was published by B1, so a non-submitter '
                    'non-admin must see none', v_own;
  END IF;
  SELECT count(*) INTO v_bogus
    FROM get_private_registry_submissions('5949cccc-0000-0000-0000-00000000c001');
  IF v_bogus <> 0 THEN
    RAISE EXCEPTION 'FAIL (V3): a nonexistent team id returned % rows', v_bogus;
  END IF;
  RAISE NOTICE 'PASS (V3): cross-tenant, non-admin-non-submitter and nonexistent-team all return '
               'zero rows (indistinguishable, so no probing)';
END $$;

-- V4: the RESULT TYPE carries no `content` column. Asserted here as well as in the migration's own
--     smoke suite, because this is the property the whole D-4 design rests on: pending content is
--     unreachable BY CONSTRUCTION rather than by a predicate someone remembered.
RESET ROLE;
DO $$
DECLARE v_result TEXT;
BEGIN
  v_result := pg_get_function_result(
    'public.get_private_registry_submissions(text,text)'::regprocedure);
  IF v_result ILIKE '%content%' THEN
    RAISE EXCEPTION 'FAIL (V4): the submissions RPC now returns a content column (%)', v_result;
  END IF;
  RAISE NOTICE 'PASS (V4): submissions RPC exposes metadata only';
END $$;

-- ---------------------------------------------------------------------------
-- W1-W6. review_private_registry_submission() -- the decision path, in check order. Every negative
-- runs BEFORE the positive, so a broken refusal cannot be masked by an already-approved row.
-- ---------------------------------------------------------------------------

-- W1: SELF-APPROVAL IS REFUSED, even for an admin. A1 published /self-probe and A1 is an admin, so
--     steps 1-6 all pass and step 7 is the only thing that can refuse. The message is asserted,
--     not just the SQLSTATE: steps 3 and 7 share 42501 and are distinguished by their message.
RESET ROLE;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '5949aaaa-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text,
  true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  c_a CONSTANT TEXT := '5949aaaa-0000-0000-0000-00000000a001';
  v_ns TEXT := current_setting('smi5949.ns_a');
BEGIN
  BEGIN
    PERFORM * FROM review_private_registry_submission(
      c_a, v_ns || '/self-probe', '1.0.0', 'approved', 'approving my own work');
    RAISE EXCEPTION 'FAIL (W1): an admin APPROVED THEIR OWN SUBMISSION. The gate is a formality -- '
                    'one person can publish and ship arbitrary content into every teammate''s '
                    '~/.claude/skills with no second party involved.';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    IF SQLERRM NOT LIKE '%submitter may not approve%' THEN
      RAISE EXCEPTION 'FAIL (W1): 42501 raised by the ADMIN check, not the SELF-APPROVAL check '
                      '(%). This fixture''s submitter IS an admin, so reaching the admin check '
                      'means the check ORDER changed.', SQLERRM;
    END IF;
  END;
  RAISE NOTICE 'PASS (W1): self-approval refused (42501, self-approval rule)';
END $$;

-- W2: a plain member cannot review. The approver set is user_admin_team_ids() (D-1), NOT
--     "anyone but the submitter" -- which would make the gate a formality inside a team of three.
RESET ROLE;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '5949aaaa-0000-0000-0000-0000000000a2', 'role', 'authenticated')::text,
  true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  c_a CONSTANT TEXT := '5949aaaa-0000-0000-0000-00000000a001';
  v_ns TEXT := current_setting('smi5949.ns_a');
BEGIN
  BEGIN
    PERFORM * FROM review_private_registry_submission(
      c_a, v_ns || '/queue-probe', '1.0.0', 'approved', NULL);
    RAISE EXCEPTION 'FAIL (W2): a plain member approved a submission';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    IF SQLERRM NOT LIKE '%only a team admin or owner%' THEN
      RAISE EXCEPTION 'FAIL (W2): 42501 raised by the wrong rule (%)', SQLERRM;
    END IF;
  END;
  RAISE NOTICE 'PASS (W2): non-admin review refused (42501, admin rule)';
END $$;

-- W3: cross-tenant review, plus the decision-vocabulary and not-found refusals. A team-B owner is
--     an admin OF TEAM B, so this proves the admin check is scoped to the ROW's team, not to
--     "is an admin somewhere".
RESET ROLE;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '5949bbbb-0000-0000-0000-0000000000b1', 'role', 'authenticated')::text,
  true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  c_a CONSTANT TEXT := '5949aaaa-0000-0000-0000-00000000a001';
  c_b CONSTANT TEXT := '5949bbbb-0000-0000-0000-00000000b001';
  v_ns_a TEXT := current_setting('smi5949.ns_a');
  v_ns_b TEXT := current_setting('smi5949.ns_b');
BEGIN
  BEGIN
    PERFORM * FROM review_private_registry_submission(
      c_a, v_ns_a || '/queue-probe', '1.0.0', 'approved', NULL);
    RAISE EXCEPTION 'FAIL (W3): team B''s owner approved a TEAM A submission -- the admin check is '
                    'not scoped to the row''s own team';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;

  BEGIN
    PERFORM * FROM review_private_registry_submission(
      c_b, v_ns_b || '/other-tenant', '1.0.0', 'maybe', NULL);
    RAISE EXCEPTION 'FAIL (W3): a decision of ''maybe'' was accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;

  BEGIN
    PERFORM * FROM review_private_registry_submission(
      c_b, v_ns_b || '/no-such-skill', '1.0.0', 'approved', NULL);
    RAISE EXCEPTION 'FAIL (W3): reviewing a nonexistent submission succeeded';
  EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL;
  END;

  RAISE NOTICE 'PASS (W3): cross-tenant review 42501, bad decision 22023, not-found P0002';
END $$;

-- W4 (POSITIVE): a SECOND admin approves, and the row becomes readable to an ordinary member.
--     This is the end-to-end proof that the gate opens as well as closes.
RESET ROLE;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '5949aaaa-0000-0000-0000-0000000000a3', 'role', 'authenticated')::text,
  true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  c_a  CONSTANT TEXT := '5949aaaa-0000-0000-0000-00000000a001';
  c_a2 CONSTANT UUID := '5949aaaa-0000-0000-0000-0000000000a2';
  c_a3 CONSTANT UUID := '5949aaaa-0000-0000-0000-0000000000a3';
  v_ns TEXT := current_setting('smi5949.ns_a');
  v_status TEXT; v_by UUID; v_at TIMESTAMPTZ; v_note TEXT;
BEGIN
  SELECT r.approval_status, r.approved_by, r.approved_at, r.review_note
    INTO v_status, v_by, v_at, v_note
    FROM review_private_registry_submission(
           c_a, v_ns || '/queue-probe', '1.0.0', 'approved', 'reviewed, looks fine') r;

  IF v_status IS DISTINCT FROM 'approved' OR v_by IS DISTINCT FROM c_a3 OR v_at IS NULL
     OR v_note IS DISTINCT FROM 'reviewed, looks fine' THEN
    RAISE EXCEPTION 'FAIL (W4): decision written as status=%, approved_by=%, approved_at=%, note=% '
                    '-- expected approved / % / non-null / the supplied note',
      COALESCE(v_status, '<null>'), COALESCE(v_by::text, '<null>'), COALESCE(v_at::text, '<null>'),
      COALESCE(v_note, '<null>'), c_a3;
  END IF;
  IF v_by = c_a2 THEN
    RAISE EXCEPTION 'FAIL (W4): approved_by recorded the SUBMITTER, not the approver';
  END IF;
  RAISE NOTICE 'PASS (W4): admin approval recorded against the approver''s own uid';
END $$;

RESET ROLE;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '5949aaaa-0000-0000-0000-0000000000a2', 'role', 'authenticated')::text,
  true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_ns TEXT := current_setting('smi5949.ns_a');
  v_rows INT;
BEGIN
  SELECT count(*) INTO v_rows FROM private_registry_skills
   WHERE skill_id = v_ns || '/queue-probe';
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'FAIL (W4): after approval the row is visible to % member(s) instead of 1 -- '
                    'approval does not make a version readable, so R1/R2 above were passing for '
                    'the wrong reason (the policy denies everything)', v_rows;
  END IF;
  RAISE NOTICE 'PASS (W4): approved row is now readable by an ordinary team member';
END $$;

-- W5: approved is TERMINAL. A second decision must be refused rather than silently overwriting
--     the first, which would erase the record of who approved a live version.
RESET ROLE;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '5949aaaa-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text,
  true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  c_a CONSTANT TEXT := '5949aaaa-0000-0000-0000-00000000a001';
  v_ns TEXT := current_setting('smi5949.ns_a');
BEGIN
  BEGIN
    PERFORM * FROM review_private_registry_submission(
      c_a, v_ns || '/queue-probe', '1.0.0', 'rejected', 'changed my mind');
    RAISE EXCEPTION 'FAIL (W5): an already-approved submission was reviewed a second time';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  RAISE NOTICE 'PASS (W5): a decided submission is terminal (55000)';
END $$;

-- W6: REJECTION. The row stays in the table (no delete -- ADR-123/129), stays invisible on the
--     read path, and is still visible to its submitter through the metadata RPC so they can see
--     the reason. Rejection is also terminal, for the same reason W5 is.
RESET ROLE;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '5949aaaa-0000-0000-0000-0000000000a3', 'role', 'authenticated')::text,
  true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  c_a CONSTANT TEXT := '5949aaaa-0000-0000-0000-00000000a001';
  v_ns TEXT := current_setting('smi5949.ns_a');
  v_status TEXT;
BEGIN
  SELECT r.approval_status INTO v_status
    FROM review_private_registry_submission(
           c_a, v_ns || '/reject-probe', '1.0.0', 'rejected', 'ships a curl|sh in SKILL.md') r;
  IF v_status IS DISTINCT FROM 'rejected' THEN
    RAISE EXCEPTION 'FAIL (W6): rejection wrote status=%', COALESCE(v_status, '<null>');
  END IF;
  RAISE NOTICE 'PASS (W6a): rejection recorded';
END $$;

RESET ROLE;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '5949aaaa-0000-0000-0000-0000000000a2', 'role', 'authenticated')::text,
  true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  c_a CONSTANT TEXT := '5949aaaa-0000-0000-0000-00000000a001';
  v_ns TEXT := current_setting('smi5949.ns_a');
  v_visible INT; v_queued INT; v_note TEXT;
BEGIN
  SELECT count(*) INTO v_visible FROM private_registry_skills
   WHERE skill_id = v_ns || '/reject-probe';
  IF v_visible <> 0 THEN
    RAISE EXCEPTION 'FAIL (W6): a REJECTED version is readable. The read predicate is not the '
                    'single equality `approval_status = ''approved''` -- it is matching a set that '
                    'includes rejected.';
  END IF;

  SELECT count(*), max(s.review_note) INTO v_queued, v_note
    FROM get_private_registry_submissions(c_a, 'rejected') s
   WHERE s.skill_id = v_ns || '/reject-probe';
  IF v_queued <> 1 OR v_note IS DISTINCT FROM 'ships a curl|sh in SKILL.md' THEN
    RAISE EXCEPTION 'FAIL (W6): the submitter cannot see the rejection or its reason (rows=%, '
                    'note=%) -- they would have no way to learn why', v_queued,
      COALESCE(v_note, '<null>');
  END IF;
  RAISE NOTICE 'PASS (W6b): rejected version unreadable, reason still visible to its submitter';
END $$;

-- ---------------------------------------------------------------------------
-- P1-P3. Privilege and policy shape. These are the controls that make the behaviour above a
-- PROPERTY of the database rather than a property of the paths this script happened to take.
-- ---------------------------------------------------------------------------
RESET ROLE;
SELECT set_config('request.jwt.claims', '', true);

-- P1: `authenticated` holds neither INSERT nor UPDATE on any approval column, and still holds
--     UPDATE on `deprecated` (so the negative half is not passing because the table lost every
--     grant).
DO $$
DECLARE v_ok BOOLEAN;
BEGIN
  SELECT bool_or(has_column_privilege('authenticated', 'public.private_registry_skills',
                                      c.col, 'INSERT'))
    INTO v_ok
    FROM unnest(ARRAY['approval_status','approval_mode','approved_by','approved_at','review_note'])
         AS c(col);
  IF v_ok IS NOT FALSE THEN
    RAISE EXCEPTION 'FAIL (P1): authenticated holds INSERT on an approval column -- a client can '
                    'publish pre-approved';
  END IF;

  SELECT bool_or(has_column_privilege('authenticated', 'public.private_registry_skills',
                                      c.col, 'UPDATE'))
    INTO v_ok
    FROM unnest(ARRAY['approval_status','approval_mode','approved_by','approved_at','review_note'])
         AS c(col);
  IF v_ok IS NOT FALSE THEN
    RAISE EXCEPTION 'FAIL (P1): authenticated holds UPDATE on an approval column -- a client can '
                    'self-approve with a direct PostgREST PATCH, bypassing every check in the RPC';
  END IF;

  IF has_column_privilege('authenticated', 'public.private_registry_skills', 'deprecated', 'UPDATE')
     IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL (P1): authenticated lost UPDATE on `deprecated` -- the negative half '
                    'above would have passed vacuously';
  END IF;
  RAISE NOTICE 'PASS (P1): approval columns are server-owned; `deprecated` still writable';
END $$;

-- P2: EXECUTE on the two new RPCs -- anon and PUBLIC denied, authenticated and service_role
--     allowed. Supabase's ALTER DEFAULT PRIVILEGES grants new functions to anon explicitly, and a
--     PUBLIC-scoped REVOKE cannot remove a role-specific grant (the SMI-5510 / SMI-5882 class), so
--     the by-name revoke is the only thing that works and this is what proves it took.
DO $$
DECLARE
  v_fn TEXT;
  v_public BOOLEAN;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['public.get_private_registry_submissions(text,text)',
                              'public.review_private_registry_submission(text,text,text,text,text)']
  LOOP
    IF to_regprocedure(v_fn) IS NULL THEN
      RAISE EXCEPTION 'FAIL (P2): % does not exist -- migration 20260809000000 is not applied', v_fn;
    END IF;
    IF has_function_privilege('anon', to_regprocedure(v_fn), 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL (P2): anon holds EXECUTE on %', v_fn;
    END IF;
    SELECT EXISTS (
      SELECT 1 FROM pg_proc p, unnest(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
       WHERE p.oid = to_regprocedure(v_fn) AND acl::text LIKE '=%'
    ) INTO v_public;
    IF v_public IS NOT FALSE THEN
      RAISE EXCEPTION 'FAIL (P2): PUBLIC holds EXECUTE on %', v_fn;
    END IF;
    IF NOT has_function_privilege('authenticated', to_regprocedure(v_fn), 'EXECUTE')
       OR NOT has_function_privilege('service_role', to_regprocedure(v_fn), 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL (P2): authenticated or service_role LOST EXECUTE on % -- the review '
                      'path is unreachable', v_fn;
    END IF;
  END LOOP;
  RAISE NOTICE 'PASS (P2): both review RPCs are authenticated+service_role only';
END $$;

-- P3: the policy set is still EXACTLY the four intended policies, and the SELECT policy carries
--     the approval conjunct. Permissive policies OR together, so an ADDED policy widens access --
--     a count-only check would pass for four wrong policies (20260729000001 a10's reasoning).
DO $$
DECLARE
  c_expected CONSTANT TEXT[] := ARRAY[
    'private_registry_skills_member_read',
    'private_registry_skills_member_insert',
    'private_registry_skills_admin_update',
    'private_registry_skills_service_all'
  ];
  v_missing TEXT; v_extra TEXT; v_qual TEXT;
BEGIN
  SELECT string_agg(x, ', ') INTO v_missing
    FROM unnest(c_expected) AS x
   WHERE NOT EXISTS (SELECT 1 FROM pg_policies p
                      WHERE p.schemaname = 'public' AND p.tablename = 'private_registry_skills'
                        AND p.policyname = x);
  SELECT string_agg(p.policyname, ', ') INTO v_extra
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = 'private_registry_skills'
     AND NOT (p.policyname = ANY(c_expected));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL (P3): expected policy missing: %', v_missing;
  END IF;
  IF v_extra IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL (P3): UNEXPECTED policy on private_registry_skills: % -- permissive '
                    'policies OR together, so this can widen access silently', v_extra;
  END IF;

  SELECT p.qual INTO v_qual FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = 'private_registry_skills'
     AND p.policyname = 'private_registry_skills_member_read';
  IF v_qual IS NULL OR v_qual NOT LIKE '%approval_status%' THEN
    RAISE EXCEPTION 'FAIL (P3): private_registry_skills_member_read''s USING clause has no '
                    'approval_status conjunct (%). Every read surface depends on it.',
      COALESCE(v_qual, '<null>');
  END IF;
  IF v_qual NOT LIKE '%user_team_ids%' THEN
    RAISE EXCEPTION 'FAIL (P3): the SELECT policy lost its tenant scope (%)', v_qual;
  END IF;
  RAISE NOTICE 'PASS (P3): exactly 4 policies; member_read carries BOTH tenant scope and the '
               'approval conjunct';
END $$;

-- ---------------------------------------------------------------------------
-- T1. THE OLD-CLIENT PATH. A publish that carries no user identity is refused loudly at INSERT,
-- naming the remediation -- not accepted into a queue nobody can ever clear. Decision 1 makes this
-- a merge-day event for EVERY Enterprise publisher, including any CI publisher holding only
-- SKILLSMITH_LICENSE_KEY, which is why it is asserted here rather than assumed.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
DO $$
DECLARE v_ns TEXT := current_setting('smi5949.ns_a');
BEGIN
  BEGIN
    INSERT INTO private_registry_skills (team_id, skill_id, version, content)
    VALUES ('5949aaaa-0000-0000-0000-00000000a001', v_ns || '/nojwt-probe', '9.9.9',
            '{"SKILL.md":"n"}'::jsonb);
    RAISE EXCEPTION 'FAIL (T1): an INSERT carrying no user identity was ACCEPTED. That row records '
                    'no submitter, so self-approval cannot be checked and it can NEVER be '
                    'approved -- a permanently stuck queue with no operator recourse short of '
                    'manual SQL.';
  EXCEPTION
    WHEN SQLSTATE '23514' THEN
      IF SQLERRM NOT LIKE '%published_by%' THEN
        RAISE EXCEPTION 'FAIL (T1): a 23514 was raised but by a different rule (%) -- the approval '
                        'trigger may not be armed at all', SQLERRM;
      END IF;
      RAISE NOTICE 'PASS (T1): a submitter-less publish is refused at INSERT, naming published_by';
    WHEN SQLSTATE '42501' THEN
      -- Also acceptable: RLS refused it first because auth.uid() is NULL, so
      -- user_member_team_ids() is empty and the WITH CHECK fails. Same outcome (loud, immediate),
      -- different layer -- recorded rather than silently treated as identical.
      RAISE NOTICE 'PASS (T1, via RLS): the WITH CHECK refused it before the trigger ran (no '
                   'auth.uid() means no team membership). The trigger is still the backstop for '
                   'the service-role path, which bypasses RLS.';
  END;
END $$;

RESET ROLE;
SELECT set_config('request.jwt.claims', '', true);

\echo '*** SMI-5949 approval-gate boundary harness: all blocks passed. Rolling back fixtures.'
ROLLBACK;
