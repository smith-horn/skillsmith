-- ============================================================================
-- SMI-6267: synthetic end-to-end UAT harness for the SMI-6200 Enterprise RBAC
-- permission model (Wave 1 = SMI-6202, Wave 2 = SMI-6203).
--
-- Invocation: run via scripts/staging/smi-6267-rbac-uat-e2e.sh (from any cwd -- that
-- wrapper resolves this file's path relative to its own location, not the caller's cwd).
-- Never invoke this file directly through `./scripts/pooler-psql.sh -f <path>` -- that
-- resolves the path INSIDE the container, and from a worktree resolves against the MAIN
-- checkout's container (SMI-5559), where this file does not exist. The wrapper also
-- performs a load-bearing text substitution (see "WAVE 2 SHIM" below) that a bare
-- `cat | psql` would skip entirely.
--
-- STAGING ONLY (ovhcifugwqnzoebwfuku). EVERY fixture row AND every schema change this
-- file makes is rolled back -- the whole run is one transaction ending in ROLLBACK.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS COVERS (and why each block exists)
-- ---------------------------------------------------------------------------
--   P0  Preflight: record the AS-APPLIED state of this database (which of the four
--       RBAC migrations are actually live) BEFORE anything is shimmed. This is itself
--       a finding surface -- see "WAVE 2 SHIM".
--   T1  Role-default matrix: every (role x permission) default, asserted against an
--       INDEPENDENTLY hardcoded copy of the plan's design table -- never against
--       default_role_permission() itself, which would be tautological.
--   T2  Explicit-grant override matrix: the full (4 permissions x 3 roles x 3 grant
--       states) cross product through has_team_permission(), including a leak check
--       that a grant on one permission never moves any other permission.
--   T3  Owner immutability: the CHECK constraint, the RPC's typed refusal, a
--       "every other cell denied" configuration, and set_team_member_role's owner guard.
--   T4  Cross-team isolation: one user, two teams, differing grant configurations.
--   T5  SMI-6242 regression: admin must NOT hold team:manage_rbac / team:manage_sso by
--       default. This was a real, live security bug in Wave 1.
--   T6  Grant-write RPC gate matrix + the set-then-reset bypass CLASS (not just the one
--       sequence already found and fixed): set/reset/set-set-reset/reset-then-set, from
--       four different caller vantage points.
--   T7  Error-shape contract: the exact SQLSTATEs and message texts the MCP tool layer's
--       PASSTHROUGH_REFUSALS allowlist byte-matches on.
--   T8  team_ids_with_permission() <-> has_team_permission() parity across the SAME full
--       matrix as T2. A bug affecting only one of the two forms is a previously-seen bug
--       class in this initiative.
--   T9  RLS propagation: real row-level SELECT/UPDATE access through the widened
--       private_registry_skills policy, under real role impersonation.
--
-- ---------------------------------------------------------------------------
-- WAVE 2 SHIM -- READ THIS BEFORE TRUSTING A GREEN RUN
-- ---------------------------------------------------------------------------
-- As of authoring, staging (ovhcifugwqnzoebwfuku) is at schema_version 102 -- ONLY
-- 20260827000000_team_permission_grants.sql (Wave 1 Step 1) is applied. Missing:
--   103  20260827000001_rbac_seam_widening.sql   (Wave 1 Step 2 -- the seam)
--   104  20260827000004_rbac_seam_smoke.sql      (Wave 1 Step 3)
--   105  20260828000000_rbac_grant_writes.sql    (Wave 2 -- BOTH grant-write RPCs AND
--                                                 the SMI-6242 security fix)
-- So the RPCs under test do not exist on staging, and the SMI-6242 bug is LIVE there.
--
-- Rather than test nothing, this harness exploits the fact that Postgres DDL is
-- transactional: the wrapper splices the REAL, MERGED SQL for the missing pieces into
-- this transaction at the `-- @@WAVE2_SHIM@@` marker below, runs the full matrix against
-- it, and ROLLBACKs -- so the functions vanish again and staging is left byte-identical.
--
-- The spliced text is EXTRACTED FROM THE MIGRATION FILE ITSELF by the wrapper (awk
-- between two stable section-header markers), never copy-pasted here. There is therefore
-- no second copy of the function bodies to drift out of sync with the migration: this
-- harness always tests the real merged SQL, whatever it currently says.
--
-- The three CREATE OR REPLACE statements are idempotent, so the splice is a harmless
-- no-op against a database that ALREADY has Wave 2 applied (e.g. prod, or staging once
-- someone pushes it). That is deliberate: the same harness is correct in both worlds,
-- and P0 -- which runs BEFORE the splice -- is what tells you which world you are in.
--
-- CONSEQUENCE FOR READING RESULTS: a green T5/T6 proves the MERGED CODE is correct. It
-- does NOT prove the deployed database is. P0's report is the only statement this file
-- makes about deployed state, and it is printed again in the final summary.
--
-- ---------------------------------------------------------------------------
-- READING THE OUTPUT. Every check is self-verifying: it emits `NOTICE: PASS (Tn.k) ...`
-- or it raises. A clean run exits 0. ANY non-zero exit is a real finding. The final
-- SUMMARY block re-prints the P0 deployed-state findings, which are NOT failures of the
-- code under test and so deliberately do not abort the run.
-- ============================================================================
\set ON_ERROR_STOP on

-- `\quit` deliberately NOT used: it exits psql with status 0, which would make a bare
-- `cat file | ./scripts/pooler-psql.sh` -- skipping the wrapper, and therefore skipping
-- the shim substitution -- silently "succeed" having asserted nothing. A RAISE EXCEPTION
-- under ON_ERROR_STOP is what makes this refusal a non-zero exit.
\if :{?confirm_ref}
\else
  \echo '*** REFUSING: :confirm_ref is not set. Run this through'
  \echo '*** scripts/staging/smi-6267-rbac-uat-e2e.sh'
  DO $guard0$ BEGIN
    RAISE EXCEPTION 'REFUSING: :confirm_ref is not set -- this script must be invoked via '
                    'scripts/staging/smi-6267-rbac-uat-e2e.sh, never piped directly.';
  END $guard0$;
\endif

SELECT :'confirm_ref' = 'ovhcifugwqnzoebwfuku' AS is_staging \gset
\if :is_staging
\else
  \echo '*** REFUSING: connected project ref is not staging.'
  DO $guard1$ BEGIN
    RAISE EXCEPTION 'REFUSING: this script INSERTs fixture rows into auth.users and creates '
                    'fixture tenants; it may only run against staging (ovhcifugwqnzoebwfuku).';
  END $guard1$;
\endif

-- Second, independent gate on the LIVE connection rather than on a psql variable the
-- caller supplied. :confirm_ref proves what the wrapper INTENDED; this proves where we
-- actually landed. A mismatch means the wrapper's env override did not take effect.
DO $guard2$
DECLARE v_db TEXT; v_user TEXT;
BEGIN
  SELECT current_database(), current_user INTO v_db, v_user;
  IF v_user NOT LIKE '%ovhcifugwqnzoebwfuku%' AND v_user <> 'postgres' THEN
    RAISE EXCEPTION 'REFUSING: unexpected connection user %', v_user;
  END IF;
  RAISE NOTICE 'Connected as % to % (intended ref: staging)', v_user, v_db;
END $guard2$;

BEGIN;
-- Bounds EVERY statement in this transaction, including each statement inside the DO
-- blocks below (SET LOCAL statement_timeout applies per-statement, not to the
-- transaction as a whole). lock_timeout keeps the shim's CREATE OR REPLACE from ever
-- queueing behind a long staging query and stalling other callers.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

-- ============================================================================
-- P0. PREFLIGHT -- record the AS-APPLIED state BEFORE the shim rewrites anything.
--
-- Stored in transaction-local GUCs so the final SUMMARY can re-report them after the
-- shim has made the live definitions unrepresentative of the deployed ones.
-- ============================================================================
DO $p0$
DECLARE
  v_sv               INT;
  v_has_set_rpc      BOOLEAN;
  v_has_reset_rpc    BOOLEAN;
  v_admin_rbac       BOOLEAN;
  v_admin_sso        BOOLEAN;
  v_policy           TEXT;
  v_seam_widened     BOOLEAN;
BEGIN
  SELECT max(version) INTO v_sv FROM schema_version;

  SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'set_team_role_permission')
    INTO v_has_set_rpc;
  SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'reset_team_role_permission')
    INTO v_has_reset_rpc;

  -- The SMI-6242 bug, read straight off the DEPLOYED function.
  SELECT default_role_permission('admin', 'team:manage_rbac') INTO v_admin_rbac;
  SELECT default_role_permission('admin', 'team:manage_sso')  INTO v_admin_sso;

  SELECT pg_get_expr(polqual, polrelid) INTO v_policy
    FROM pg_policy
   WHERE polrelid = 'private_registry_skills'::regclass
     AND polname = 'private_registry_skills_admin_update';
  v_seam_widened := COALESCE(v_policy LIKE '%team_ids_with_permission%', FALSE);

  PERFORM set_config('smi6267.schema_version',   COALESCE(v_sv::text, '<none>'), true);
  PERFORM set_config('smi6267.has_set_rpc',      v_has_set_rpc::text,  true);
  PERFORM set_config('smi6267.has_reset_rpc',    v_has_reset_rpc::text, true);
  PERFORM set_config('smi6267.admin_rbac_bug',   v_admin_rbac::text,   true);
  PERFORM set_config('smi6267.admin_sso_bug',    v_admin_sso::text,    true);
  PERFORM set_config('smi6267.seam_widened',     v_seam_widened::text, true);

  RAISE NOTICE '--------------------------------------------------------------------';
  RAISE NOTICE 'P0 DEPLOYED STATE (before shim):';
  RAISE NOTICE '  schema_version                       = %', v_sv;
  RAISE NOTICE '  set_team_role_permission exists      = %', v_has_set_rpc;
  RAISE NOTICE '  reset_team_role_permission exists    = %', v_has_reset_rpc;
  RAISE NOTICE '  default_role_permission(admin,rbac)  = %  (MUST be false post-SMI-6242)', v_admin_rbac;
  RAISE NOTICE '  default_role_permission(admin,sso)   = %  (MUST be false post-SMI-6242)', v_admin_sso;
  RAISE NOTICE '  registry seam policy widened         = %', v_seam_widened;
  RAISE NOTICE '  admin_update USING = %', COALESCE(v_policy, '<policy missing>');
  RAISE NOTICE '--------------------------------------------------------------------';

  -- A missing table means Wave 1 Step 1 itself is absent -- nothing below can mean
  -- anything, so this one IS fatal.
  IF to_regclass('public.team_permission_grants') IS NULL THEN
    RAISE EXCEPTION 'FAIL (P0): team_permission_grants does not exist -- '
                    '20260827000000_team_permission_grants.sql has not been applied to this '
                    'database. Every assertion below would be meaningless.';
  END IF;
  RAISE NOTICE 'PASS (P0): team_permission_grants present; deployed-state recorded.';
END $p0$;

-- ============================================================================
-- WAVE 2 SHIM SPLICE POINT.
--
-- The wrapper replaces the marker line below with Sections 1-4 of
-- supabase/migrations/20260828000000_rbac_grant_writes.sql (the SMI-6242
-- default_role_permission fix, set_team_role_permission, reset_team_role_permission, and
-- their GRANT/REVOKE block), extracted verbatim from that file. All three statements are
-- CREATE OR REPLACE, so this is a no-op where Wave 2 is already applied.
--
-- If you see "syntax error" immediately after this comment, the wrapper's awk extraction
-- found nothing -- check that the section-header markers it greps for still exist in the
-- migration. The wrapper refuses rather than splicing empty text, so this should be
-- unreachable.
-- ============================================================================
-- @@WAVE2_SHIM@@

-- ============================================================================
-- FIXTURES.
--
-- Three tenants, nine users. Every identifier is prefixed `_e2e_rbac_6267_` (teams) or
-- carries the `62670000-` UUID prefix (users) so it is trivially greppable and can never
-- be mistaken for customer data. Everything is rolled back at the end regardless.
--
-- ROLE CAST:
--   owner_a   team A owner        -- the un-narrowable principal
--   admin_a   team A admin        -- default admin; post-6242 holds NEITHER meta-permission
--   admin2_a  team A second admin -- target for the admin-vs-admin gate
--   member_a  team A member       -- default member; holds nothing
--   mgr_a     team A member       -- + an explicit team:manage_rbac ALLOW grant. This is
--                                    the "delegated RBAC manager": the single most
--                                    dangerous principal in the model, and the one the
--                                    set-then-reset bypass class is about.
--   dual      team A + team B member -- cross-team isolation
--   outsider  no team at all      -- existence-oracle probing
--   owner_b   team B owner
--   member_b  team B member
--
-- teams.skill_namespace is NOT set explicitly: it must be produced by
-- derive_team_skill_namespace() (BEFORE INSERT ON teams). Setting it directly would make
-- T9's namespace-dependent inserts prove nothing about the real team-creation path.
-- ============================================================================
INSERT INTO auth.users (id, email) VALUES
  ('62670000-0000-0000-0000-000000000001', 'e2e-rbac-6267-owner-a@example.test'),
  ('62670000-0000-0000-0000-000000000002', 'e2e-rbac-6267-admin-a@example.test'),
  ('62670000-0000-0000-0000-000000000003', 'e2e-rbac-6267-member-a@example.test'),
  ('62670000-0000-0000-0000-000000000004', 'e2e-rbac-6267-admin2-a@example.test'),
  ('62670000-0000-0000-0000-000000000005', 'e2e-rbac-6267-mgr-a@example.test'),
  ('62670000-0000-0000-0000-000000000006', 'e2e-rbac-6267-dual@example.test'),
  ('62670000-0000-0000-0000-000000000011', 'e2e-rbac-6267-owner-b@example.test'),
  ('62670000-0000-0000-0000-000000000012', 'e2e-rbac-6267-member-b@example.test'),
  ('62670000-0000-0000-0000-00000000000f', 'e2e-rbac-6267-outsider@example.test')
ON CONFLICT (id) DO NOTHING;

INSERT INTO profiles (id, email, tier, role) VALUES
  ('62670000-0000-0000-0000-000000000001', 'e2e-rbac-6267-owner-a@example.test',  'enterprise', 'user'),
  ('62670000-0000-0000-0000-000000000002', 'e2e-rbac-6267-admin-a@example.test',  'enterprise', 'user'),
  ('62670000-0000-0000-0000-000000000003', 'e2e-rbac-6267-member-a@example.test', 'enterprise', 'user'),
  ('62670000-0000-0000-0000-000000000004', 'e2e-rbac-6267-admin2-a@example.test', 'enterprise', 'user'),
  ('62670000-0000-0000-0000-000000000005', 'e2e-rbac-6267-mgr-a@example.test',    'enterprise', 'user'),
  ('62670000-0000-0000-0000-000000000006', 'e2e-rbac-6267-dual@example.test',     'enterprise', 'user'),
  ('62670000-0000-0000-0000-000000000011', 'e2e-rbac-6267-owner-b@example.test',  'enterprise', 'user'),
  ('62670000-0000-0000-0000-000000000012', 'e2e-rbac-6267-member-b@example.test', 'enterprise', 'user'),
  ('62670000-0000-0000-0000-00000000000f', 'e2e-rbac-6267-outsider@example.test', 'enterprise', 'user')
ON CONFLICT (id) DO UPDATE SET tier = EXCLUDED.tier;

INSERT INTO teams (id, name, owner_id) VALUES
  ('_e2e_rbac_6267_team_a', 'E2E RBAC 6267 Alpha',   '62670000-0000-0000-0000-000000000001'),
  ('_e2e_rbac_6267_team_b', 'E2E RBAC 6267 Bravo',   '62670000-0000-0000-0000-000000000011'),
  ('_e2e_rbac_6267_team_c', 'E2E RBAC 6267 Charlie', '62670000-0000-0000-0000-000000000001')
ON CONFLICT (id) DO NOTHING;

INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES
  ('_e2e_rbac_6267_team_a', '62670000-0000-0000-0000-000000000001', 'owner',  NOW()),
  ('_e2e_rbac_6267_team_a', '62670000-0000-0000-0000-000000000002', 'admin',  NOW()),
  ('_e2e_rbac_6267_team_a', '62670000-0000-0000-0000-000000000003', 'member', NOW()),
  ('_e2e_rbac_6267_team_a', '62670000-0000-0000-0000-000000000004', 'admin',  NOW()),
  ('_e2e_rbac_6267_team_a', '62670000-0000-0000-0000-000000000005', 'member', NOW()),
  ('_e2e_rbac_6267_team_a', '62670000-0000-0000-0000-000000000006', 'member', NOW()),
  ('_e2e_rbac_6267_team_b', '62670000-0000-0000-0000-000000000011', 'owner',  NOW()),
  ('_e2e_rbac_6267_team_b', '62670000-0000-0000-0000-000000000012', 'member', NOW()),
  ('_e2e_rbac_6267_team_b', '62670000-0000-0000-0000-000000000006', 'member', NOW()),
  ('_e2e_rbac_6267_team_c', '62670000-0000-0000-0000-000000000001', 'owner',  NOW())
ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role;

-- ---------------------------------------------------------------------------
-- F1 (CONTROL). Impersonation actually works.
--
-- Without this, every "denied" assertion below could pass vacuously: if set_config on
-- request.jwt.claims did not reach auth.uid(), has_team_permission() would see a NULL
-- uid, find no membership row, and return FALSE for EVERYONE -- making the whole
-- negative half of this suite green while testing nothing. Prove a POSITIVE case first.
-- ---------------------------------------------------------------------------
DO $f1$
DECLARE v_uid UUID; v_owner_can BOOLEAN; v_outsider_can BOOLEAN;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', '62670000-0000-0000-0000-000000000001',
                      'role', 'authenticated')::text, true);
  SELECT auth.uid() INTO v_uid;
  IF v_uid IS DISTINCT FROM '62670000-0000-0000-0000-000000000001'::uuid THEN
    RAISE EXCEPTION 'FAIL (F1): impersonation is not working -- auth.uid() returned %, '
                    'expected the owner_a fixture uuid. Every assertion below would be '
                    'vacuous.', COALESCE(v_uid::text, '<null>');
  END IF;
  SELECT has_team_permission('_e2e_rbac_6267_team_a', 'registry:approve') INTO v_owner_can;
  IF v_owner_can IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL (F1): owner_a was refused registry:approve on their own team -- '
                    'the fixture did not take, or the owner short-circuit is broken.';
  END IF;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', '62670000-0000-0000-0000-00000000000f',
                      'role', 'authenticated')::text, true);
  SELECT has_team_permission('_e2e_rbac_6267_team_a', 'registry:approve') INTO v_outsider_can;
  IF v_outsider_can IS NOT FALSE THEN
    RAISE EXCEPTION 'FAIL (F1): a non-member evaluated TRUE (got %) -- the membership gate '
                    'is not firing.', COALESCE(v_outsider_can::text, '<null>');
  END IF;

  RAISE NOTICE 'PASS (F1): impersonation live; owner TRUE and outsider FALSE (non-vacuous).';
END $f1$;

-- ============================================================================
-- T1 + T2 + T8. THE FULL MATRIX.
--
-- 4 permissions x {owner, admin, member} x {no grant, explicit allow, explicit deny},
-- minus the six owner-with-a-grant cells (structurally impossible -- the CHECK forbids
-- role='owner' in the grant table; T3 asserts that separately). 28 live cells.
--
-- For every cell this asserts THREE things:
--   (a) has_team_permission()      == the independently-derived expectation
--   (b) team_ids_with_permission() agrees with (a)  [T8 parity]
--   (c) the OTHER three permissions still sit at their own defaults for this role
--       [leak check -- a grant on one permission must not move any other]
--
-- The expectation is HARDCODED from the plan's design table (What Changes section 1),
-- never read back from default_role_permission() -- otherwise T1 would be a tautology
-- and could not have caught SMI-6242.
--
--   DESIGN TABLE (post-SMI-6242):
--     registry:approve    owner Y / admin Y / member N
--     registry:deprecate  owner Y / admin Y / member N
--     team:manage_rbac    owner Y / admin N / member N
--     team:manage_sso     owner Y / admin N / member N
-- ============================================================================
DO $matrix$
DECLARE
  c_team      CONSTANT TEXT := '_e2e_rbac_6267_team_a';
  c_perms     CONSTANT TEXT[] := ARRAY['registry:approve','registry:deprecate',
                                       'team:manage_rbac','team:manage_sso'];
  c_roles     CONSTANT TEXT[] := ARRAY['owner','admin','member'];
  c_states    CONSTANT TEXT[] := ARRAY['none','allow','deny'];
  v_perm      TEXT;
  v_role      TEXT;
  v_state     TEXT;
  v_uid       UUID;
  v_default   BOOLEAN;
  v_expected  BOOLEAN;
  v_actual    BOOLEAN;
  v_setof     BOOLEAN;
  v_other     TEXT;
  v_other_exp BOOLEAN;
  v_other_act BOOLEAN;
  v_cells     INT := 0;
BEGIN
  FOREACH v_perm IN ARRAY c_perms LOOP
  FOREACH v_role IN ARRAY c_roles LOOP
  FOREACH v_state IN ARRAY c_states LOOP
    -- An owner can never carry a grant row (CHECK role IN ('admin','member')). T3 proves
    -- the constraint fires; here we simply skip the impossible cells.
    CONTINUE WHEN v_role = 'owner' AND v_state <> 'none';

    v_uid := CASE v_role
               WHEN 'owner'  THEN '62670000-0000-0000-0000-000000000001'
               WHEN 'admin'  THEN '62670000-0000-0000-0000-000000000002'
               ELSE               '62670000-0000-0000-0000-000000000003'
             END::uuid;

    -- Full reset each cell: exactly one grant row can exist for team A at a time, so a
    -- leak from a previous iteration cannot be mistaken for correct behaviour.
    DELETE FROM team_permission_grants WHERE team_id = c_team;
    IF v_state <> 'none' THEN
      INSERT INTO team_permission_grants (team_id, role, permission, effect, created_by)
      VALUES (c_team, v_role, v_perm, v_state, '62670000-0000-0000-0000-000000000001');
    END IF;

    -- THE INDEPENDENT EXPECTATION (plan design table, hardcoded).
    v_default := (v_role = 'admin' AND v_perm IN ('registry:approve','registry:deprecate'));
    v_expected := CASE
                    WHEN v_role  = 'owner' THEN TRUE      -- never narrowable
                    WHEN v_state = 'allow' THEN TRUE
                    WHEN v_state = 'deny'  THEN FALSE     -- deny wins
                    ELSE v_default
                  END;

    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

    -- (a) scalar form
    SELECT has_team_permission(c_team, v_perm) INTO v_actual;
    IF v_actual IS NULL THEN
      RAISE EXCEPTION 'FAIL (T2): has_team_permission returned NULL for role=% perm=% '
                      'grant=%. NULL fails OPEN at every `IF NOT has_team_permission(...)` '
                      'call site -- this is a critical fail-open bug.', v_role, v_perm, v_state;
    END IF;
    IF v_actual IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION 'FAIL (T1/T2): has_team_permission(%, %) = % but the design table says % '
                      '(role=%, grant state=%, built-in default=%)',
                      c_team, v_perm, v_actual, v_expected, v_role, v_state, v_default;
    END IF;

    -- (b) SETOF form must agree -- T8 parity
    SELECT EXISTS (SELECT 1 FROM team_ids_with_permission(v_perm) t WHERE t = c_team)
      INTO v_setof;
    IF v_setof IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION 'FAIL (T8): team_ids_with_permission(%) %s team % for role=% grant=%, '
                      'but has_team_permission said %. The scalar and SETOF forms have '
                      'DIVERGED -- RLS policies call the SETOF form, so this is a live '
                      'authorization split-brain.',
                      v_perm, CASE WHEN v_setof THEN 'INCLUDES' ELSE 'EXCLUDES' END,
                      c_team, v_role, v_state, v_expected;
    END IF;

    -- (c) leak check: no other permission moved
    FOREACH v_other IN ARRAY c_perms LOOP
      CONTINUE WHEN v_other = v_perm;
      v_other_exp := CASE WHEN v_role = 'owner' THEN TRUE
                          ELSE (v_role = 'admin'
                                AND v_other IN ('registry:approve','registry:deprecate'))
                     END;
      SELECT has_team_permission(c_team, v_other) INTO v_other_act;
      IF v_other_act IS DISTINCT FROM v_other_exp THEN
        -- TWO causes produce this, and the message must not prejudge which:
        --   (a) a real leak -- the grant on v_perm moved an unrelated permission; or
        --   (b) v_other's BUILT-IN DEFAULT disagrees with the design table, independent of
        --       any grant. (b) is how this assertion catches SMI-6242: with the buggy Wave 1
        --       default_role_permission, admin x team:manage_rbac reads TRUE here while
        --       testing an unrelated permission, and this check fires before the matrix
        --       ever reaches team:manage_rbac as its own primary cell.
        RAISE EXCEPTION 'FAIL (T2): while testing a "%" grant on %, permission % evaluated to '
                        '% for role=% but the design table says %. Either that grant leaked '
                        'across permissions, or %''s built-in default disagrees with the '
                        'design table (this is the shape SMI-6242 takes).',
                        v_state, v_perm, v_other, v_other_act, v_role, v_other_exp, v_other;
      END IF;
    END LOOP;

    v_cells := v_cells + 1;
  END LOOP; END LOOP; END LOOP;

  DELETE FROM team_permission_grants WHERE team_id = c_team;
  IF v_cells <> 28 THEN
    RAISE EXCEPTION 'FAIL (T1/T2): expected 28 matrix cells, executed % -- the loop bounds '
                    'drifted and coverage is not what this file claims.', v_cells;
  END IF;
  RAISE NOTICE 'PASS (T1/T2/T8): all % matrix cells correct (scalar == SETOF, no cross-'
               'permission leak).', v_cells;
END $matrix$;

-- ============================================================================
-- T3. OWNER IMMUTABILITY.
--
-- Four independent attack surfaces on the no-lockout invariant:
--   T3.1 the CHECK constraint itself refuses a role='owner' grant row (all 4 permissions
--        x both effects = 8 attempts, every one must raise 23514)
--   T3.2 the RPC refuses p_role='owner' with a TYPED 22023, not the raw 23514
--   T3.3 with EVERY other cell explicitly denied, the owner still holds all 4
--   T3.4 set_team_member_role can never change the owner's role
-- ============================================================================
DO $t3$
DECLARE
  c_team   CONSTANT TEXT := '_e2e_rbac_6267_team_a';
  c_perms  CONSTANT TEXT[] := ARRAY['registry:approve','registry:deprecate',
                                    'team:manage_rbac','team:manage_sso'];
  c_effects CONSTANT TEXT[] := ARRAY['allow','deny'];
  v_perm   TEXT;
  v_eff    TEXT;
  v_n      INT := 0;
  v_can    BOOLEAN;
  v_owner_mid TEXT;
  v_sqlstate TEXT;
  v_accepted BOOLEAN;
BEGIN
  -- T3.1 -- the database-level no-lockout guard.
  FOREACH v_perm IN ARRAY c_perms LOOP
  FOREACH v_eff IN ARRAY c_effects LOOP
    BEGIN
      INSERT INTO team_permission_grants (team_id, role, permission, effect, created_by)
      VALUES (c_team, 'owner', v_perm, v_eff, '62670000-0000-0000-0000-000000000001');
      RAISE EXCEPTION 'FAIL (T3.1): a grant row for role=owner (%, %) was ACCEPTED. The '
                      'no-lockout CHECK constraint is missing or was weakened -- an owner '
                      'could be denied a permission.', v_perm, v_eff;
    EXCEPTION
      WHEN check_violation THEN
        v_n := v_n + 1;      -- 23514, exactly as designed
      WHEN unique_violation THEN
        RAISE EXCEPTION 'FAIL (T3.1): got a UNIQUE violation instead of a CHECK violation '
                        'for role=owner -- the CHECK is not firing first.';
    END;
  END LOOP; END LOOP;
  IF v_n <> 8 THEN
    RAISE EXCEPTION 'FAIL (T3.1): only % of 8 owner-grant attempts were refused.', v_n;
  END IF;
  RAISE NOTICE 'PASS (T3.1): all 8 role=owner grant rows refused with 23514.';

  -- T3.2 -- the RPC's own typed refusal, called AS THE OWNER (the most privileged caller
  -- there is, so a refusal here cannot be attributed to lack of permission).
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', '62670000-0000-0000-0000-000000000001',
                      'role', 'authenticated')::text, true);
  --
  -- NOTE ON THIS SHAPE (used by every "must be refused with SQLSTATE X" check below).
  -- The FAIL raise must NOT sit inside the BEGIN block: a `WHEN OTHERS` handler would
  -- catch this file's own assertion failure and re-report it as "expected 22023, got
  -- P0001", which is technically still a failure but names the wrong cause. Recording a
  -- flag inside the block and raising outside it keeps the diagnosis honest.
  v_accepted := FALSE;
  BEGIN
    PERFORM set_team_role_permission(c_team, 'owner', 'registry:approve', 'deny');
    v_accepted := TRUE;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE;
    IF v_sqlstate <> '22023' THEN
      RAISE EXCEPTION 'FAIL (T3.2): expected a typed 22023 refusal for p_role=owner, got % '
                      '(%). A raw constraint error here leaks schema internals to the '
                      'customer.', v_sqlstate, SQLERRM;
    END IF;
  END;
  IF v_accepted THEN
    RAISE EXCEPTION 'FAIL (T3.2): set_team_role_permission ACCEPTED p_role=owner -- an owner '
                    'can be given a grant row, defeating the no-lockout invariant.';
  END IF;
  RAISE NOTICE 'PASS (T3.2): set_team_role_permission refuses p_role=owner with 22023.';

  -- T3.3 -- maximal hostile configuration: every admin AND member cell explicitly denied.
  DELETE FROM team_permission_grants WHERE team_id = c_team;
  INSERT INTO team_permission_grants (team_id, role, permission, effect, created_by)
  SELECT c_team, r, p, 'deny', '62670000-0000-0000-0000-000000000001'
    FROM unnest(ARRAY['admin','member']) r CROSS JOIN unnest(c_perms) p;

  FOREACH v_perm IN ARRAY c_perms LOOP
    SELECT has_team_permission(c_team, v_perm) INTO v_can;
    IF v_can IS NOT TRUE THEN
      RAISE EXCEPTION 'FAIL (T3.3): with every admin+member cell denied, the OWNER lost % '
                      '(got %). The owner short-circuit must be evaluated BEFORE any grant '
                      'lookup.', v_perm, COALESCE(v_can::text, '<null>');
    END IF;
  END LOOP;
  -- Also prove the SETOF form keeps the owner (RLS policies read this one).
  IF NOT EXISTS (SELECT 1 FROM team_ids_with_permission('team:manage_rbac') t WHERE t = c_team) THEN
    RAISE EXCEPTION 'FAIL (T3.3): team_ids_with_permission dropped the owner''s team under a '
                    'fully-denied grant configuration.';
  END IF;
  RAISE NOTICE 'PASS (T3.3): owner retains all 4 permissions with every other cell denied '
               '(scalar and SETOF).';

  -- T3.4 -- role change on the owner, attempted by the owner themselves.
  SELECT id INTO v_owner_mid FROM team_members
   WHERE team_id = c_team AND user_id = '62670000-0000-0000-0000-000000000001';
  v_accepted := FALSE;
  BEGIN
    PERFORM set_team_member_role(v_owner_mid, 'member');
    v_accepted := TRUE;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE;
    IF v_sqlstate <> '42501' THEN
      RAISE EXCEPTION 'FAIL (T3.4): expected 42501 refusing an owner role change, got % (%)',
                      v_sqlstate, SQLERRM;
    END IF;
  END;
  IF v_accepted THEN
    RAISE EXCEPTION 'FAIL (T3.4): set_team_member_role DEMOTED THE OWNER. This orphans the '
                    'team -- no principal can ever restore any permission.';
  END IF;
  RAISE NOTICE 'PASS (T3.4): set_team_member_role refuses to change the owner''s role.';

  DELETE FROM team_permission_grants WHERE team_id = c_team;
END $t3$;

-- ============================================================================
-- T4. CROSS-TEAM ISOLATION.
--
-- `dual` is a plain member of BOTH team A and team B. A grant in one team must never
-- move the same (user, permission) in the other -- ADR-129 names this as a required
-- risk control, not an optional extra.
-- ============================================================================
DO $t4$
DECLARE
  c_a CONSTANT TEXT := '_e2e_rbac_6267_team_a';
  c_b CONSTANT TEXT := '_e2e_rbac_6267_team_b';
  v_a BOOLEAN; v_b BOOLEAN; v_teams TEXT[];
BEGIN
  DELETE FROM team_permission_grants WHERE team_id IN (c_a, c_b);
  -- Widen member x registry:approve in A only.
  INSERT INTO team_permission_grants (team_id, role, permission, effect, created_by)
  VALUES (c_a, 'member', 'registry:approve', 'allow',
          '62670000-0000-0000-0000-000000000001');
  -- ...and DENY the same cell in B, so a leak in either direction is visible.
  INSERT INTO team_permission_grants (team_id, role, permission, effect, created_by)
  VALUES (c_b, 'member', 'registry:approve', 'deny',
          '62670000-0000-0000-0000-000000000011');

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', '62670000-0000-0000-0000-000000000006',
                      'role', 'authenticated')::text, true);

  SELECT has_team_permission(c_a, 'registry:approve') INTO v_a;
  SELECT has_team_permission(c_b, 'registry:approve') INTO v_b;
  IF v_a IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL (T4): the allow grant in team A did not apply (got %)', v_a;
  END IF;
  IF v_b IS NOT FALSE THEN
    RAISE EXCEPTION 'FAIL (T4): team A''s allow grant LEAKED into team B (got %) -- '
                    'cross-tenant authorization bleed.', v_b;
  END IF;

  SELECT array_agg(t ORDER BY t) INTO v_teams FROM team_ids_with_permission('registry:approve') t;
  IF NOT (v_teams @> ARRAY[c_a]) THEN
    RAISE EXCEPTION 'FAIL (T4): SETOF form omitted team A. Got %', v_teams;
  END IF;
  IF v_teams @> ARRAY[c_b] THEN
    RAISE EXCEPTION 'FAIL (T4): SETOF form INCLUDED team B despite an explicit deny there. '
                    'Got %', v_teams;
  END IF;

  -- And the reverse direction: team B's owner is unaffected by anything in team A.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', '62670000-0000-0000-0000-000000000011',
                      'role', 'authenticated')::text, true);
  SELECT has_team_permission(c_a, 'registry:approve') INTO v_a;
  IF v_a IS NOT FALSE THEN
    RAISE EXCEPTION 'FAIL (T4): team B''s owner holds permissions in team A (got %) -- the '
                    'owner short-circuit is not membership-scoped.', v_a;
  END IF;

  DELETE FROM team_permission_grants WHERE team_id IN (c_a, c_b);
  RAISE NOTICE 'PASS (T4): grants are strictly per-team in both directions; team B''s owner '
               'has no authority in team A.';
END $t4$;

-- ============================================================================
-- T5. SMI-6242 REGRESSION.
--
-- Wave 1 shipped default_role_permission() granting `admin` all four permissions,
-- including the two META-permissions the plan's design table marks owner-only. That is a
-- privilege-escalation bug: any team admin could rewrite the team's whole permission
-- matrix and register the team's IdP. Wave 2's migration corrects it.
--
-- Asserted three ways, because a fix that only holds at one layer is not a fix:
--   T5.1 the matrix function itself
--   T5.2 an actual fresh admin, through has_team_permission (no grants anywhere)
--   T5.3 the same admin through the SETOF form
-- ============================================================================
DO $t5$
DECLARE
  c_team CONSTANT TEXT := '_e2e_rbac_6267_team_a';
  v_rbac BOOLEAN; v_sso BOOLEAN; v_appr BOOLEAN; v_depr BOOLEAN;
BEGIN
  DELETE FROM team_permission_grants WHERE team_id = c_team;

  -- T5.1
  SELECT default_role_permission('admin','team:manage_rbac') INTO v_rbac;
  SELECT default_role_permission('admin','team:manage_sso')  INTO v_sso;
  IF v_rbac IS NOT FALSE OR v_sso IS NOT FALSE THEN
    RAISE EXCEPTION 'FAIL (T5.1): SMI-6242 REGRESSION -- default_role_permission grants admin '
                    'team:manage_rbac=% team:manage_sso=%. Both must be FALSE (owner-only). '
                    'Any team admin can now rewrite the permission matrix and claim the '
                    'team''s SSO domains.', v_rbac, v_sso;
  END IF;

  -- The two that SHOULD still be admin-allowed -- guards against an over-correction that
  -- silently strips admins of the permissions they are supposed to have.
  SELECT default_role_permission('admin','registry:approve')   INTO v_appr;
  SELECT default_role_permission('admin','registry:deprecate') INTO v_depr;
  IF v_appr IS NOT TRUE OR v_depr IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL (T5.1): over-correction -- admin lost registry:approve=% / '
                    'registry:deprecate=%, which the design table grants.', v_appr, v_depr;
  END IF;

  -- T5.2 / T5.3 -- a real admin principal, end to end.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', '62670000-0000-0000-0000-000000000002',
                      'role', 'authenticated')::text, true);
  SELECT has_team_permission(c_team,'team:manage_rbac') INTO v_rbac;
  SELECT has_team_permission(c_team,'team:manage_sso')  INTO v_sso;
  IF v_rbac IS NOT FALSE OR v_sso IS NOT FALSE THEN
    RAISE EXCEPTION 'FAIL (T5.2): a fresh admin with NO grants holds team:manage_rbac=% '
                    'team:manage_sso=%. Both must be FALSE.', v_rbac, v_sso;
  END IF;
  IF EXISTS (SELECT 1 FROM team_ids_with_permission('team:manage_rbac') t WHERE t = c_team)
     OR EXISTS (SELECT 1 FROM team_ids_with_permission('team:manage_sso') t WHERE t = c_team) THEN
    RAISE EXCEPTION 'FAIL (T5.3): the SETOF form still hands a fresh admin a meta-permission '
                    'even though the scalar form does not -- the SMI-6242 fix did not reach '
                    'team_ids_with_permission (which is the form RLS policies call).';
  END IF;

  RAISE NOTICE 'PASS (T5): admin holds neither meta-permission by default, via all three '
               'surfaces; registry:approve/deprecate unaffected.';
END $t5$;

-- ============================================================================
-- T6. GRANT-WRITE RPC GATES + THE SET-THEN-RESET BYPASS CLASS.
--
-- The high-value adversarial block. The principal of interest is `mgr_a`: role='member'
-- carrying an explicit team:manage_rbac ALLOW grant -- a first-class, insertable
-- configuration (it is a real cell in get_effective_team_permissions' own output). That
-- principal passes the RPCs' has_team_permission gate but is NOT owner and NOT admin, so
-- every "only owners and admins may widen" gate has to hold against them specifically.
--
-- The already-known finding was: set(deny) then reset() reaches the same widened state as
-- one set(allow) call, which gate 5 blocks directly. This block re-derives that sequence
-- from scratch AND probes its siblings -- reset-first, set-set-reset, no-op resets, both
-- meta-permissions, both directions of the role-change RPC.
-- ============================================================================
DO $t6$
DECLARE
  c_team  CONSTANT TEXT := '_e2e_rbac_6267_team_a';
  c_owner CONSTANT UUID := '62670000-0000-0000-0000-000000000001';
  c_admin CONSTANT UUID := '62670000-0000-0000-0000-000000000002';
  c_mgr   CONSTANT UUID := '62670000-0000-0000-0000-000000000005';
  c_out   CONSTANT UUID := '62670000-0000-0000-0000-00000000000f';
  v_state TEXT;
  v_ok    BOOLEAN;
  v_mid   TEXT;
  v_eff   TEXT;
  v_accepted BOOLEAN;
BEGIN
  ------------------------------------------------------------------
  -- Setup: owner delegates team:manage_rbac to the `member` role.
  ------------------------------------------------------------------
  DELETE FROM team_permission_grants WHERE team_id = c_team;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', c_owner, 'role','authenticated')::text, true);
  PERFORM set_team_role_permission(c_team, 'member', 'team:manage_rbac', 'allow');

  SELECT effect INTO v_eff FROM team_permission_grants
   WHERE team_id = c_team AND role='member' AND permission='team:manage_rbac';
  IF v_eff IS DISTINCT FROM 'allow' THEN
    RAISE EXCEPTION 'FAIL (T6.setup): the owner could not delegate team:manage_rbac (got %)',
                    COALESCE(v_eff,'<none>');
  END IF;
  RAISE NOTICE 'PASS (T6.0): owner can delegate team:manage_rbac to the member role.';

  ------------------------------------------------------------------
  -- T6.1  A DEFAULT ADMIN (post-6242: no team:manage_rbac) is refused outright.
  ------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', c_admin, 'role','authenticated')::text, true);
  BEGIN
    PERFORM set_team_role_permission(c_team,'member','registry:approve','allow');
    RAISE EXCEPTION 'FAIL (T6.1): a default admin (who holds NO team:manage_rbac post-6242) '
                    'was allowed to write a permission grant.';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;   -- 42501, correct
  END;
  RAISE NOTICE 'PASS (T6.1): a default admin cannot write grants (42501).';

  ------------------------------------------------------------------
  -- T6.2  A NON-MEMBER gets the same 42501 -- no cross-tenant existence oracle.
  ------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', c_out, 'role','authenticated')::text, true);
  BEGIN
    PERFORM set_team_role_permission(c_team,'member','registry:approve','allow');
    RAISE EXCEPTION 'FAIL (T6.2): a non-member wrote a grant into a team they do not belong to.';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- ...and a team that does not exist AT ALL must be indistinguishable from one that does.
  -- Flag-then-raise (see T3.2's note): raising the FAIL inside the block would be caught by
  -- this block's own WHEN OTHERS and misreported as an unexpected SQLSTATE.
  v_accepted := FALSE;
  BEGIN
    PERFORM set_team_role_permission('_e2e_rbac_6267_no_such_team','member',
                                     'registry:approve','allow');
    v_accepted := TRUE;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
    WHEN OTHERS THEN
      RAISE EXCEPTION 'FAIL (T6.2): a nonexistent team raised % instead of 42501 -- a caller '
                      'can distinguish "no such team" from "not permitted" and enumerate '
                      'tenant ids. (%)', SQLSTATE, SQLERRM;
  END;
  IF v_accepted THEN
    RAISE EXCEPTION 'FAIL (T6.2): a grant write against a NONEXISTENT team SUCCEEDED.';
  END IF;
  RAISE NOTICE 'PASS (T6.2): non-member and nonexistent-team both refused with an identical '
               '42501 (no existence oracle).';

  ------------------------------------------------------------------
  -- Everything below runs as `mgr_a` -- the delegated RBAC manager.
  ------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', c_mgr, 'role','authenticated')::text, true);

  -- T6.3  Direct widening is refused (gate 5).
  BEGIN
    PERFORM set_team_role_permission(c_team,'admin','registry:approve','allow');
    RAISE EXCEPTION 'FAIL (T6.3): a member-role caller wrote effect=allow.';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'PASS (T6.3): member-role caller cannot write effect=allow.';

  -- T6.4  Narrowing IS permitted (they are a real RBAC manager, after all).
  PERFORM set_team_role_permission(c_team,'admin','registry:approve','deny');
  SELECT effect INTO v_eff FROM team_permission_grants
   WHERE team_id=c_team AND role='admin' AND permission='registry:approve';
  IF v_eff IS DISTINCT FROM 'deny' THEN
    RAISE EXCEPTION 'FAIL (T6.4): the delegated manager could not write a deny (got %)',
                    COALESCE(v_eff,'<none>');
  END IF;
  RAISE NOTICE 'PASS (T6.4): member-role caller may narrow (write deny).';

  -- T6.5  *** THE BYPASS CLASS *** set(deny) -> reset() must NOT restore the allow default.
  --       admin x registry:approve has a built-in default of ALLOW, so clearing the deny
  --       row widens -- reaching exactly the state T6.3 just refused.
  BEGIN
    PERFORM reset_team_role_permission(c_team,'admin','registry:approve');
    RAISE EXCEPTION 'FAIL (T6.5): SET-THEN-RESET BYPASS IS LIVE. A member-role caller wrote '
                    'deny then cleared it, restoring the allow default -- the exact state '
                    'gate 5 refuses in one call (T6.3). Two calls reach what one cannot.';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'PASS (T6.5): set(deny)->reset() bypass is closed.';

  -- T6.6  RESET-FIRST variant: clearing a cell that has NO row, whose default is allow.
  --       If the gate keyed on "a row exists" rather than "the result would be allow",
  --       this would slip through as a harmless no-op.
  DELETE FROM team_permission_grants
   WHERE team_id=c_team AND role='admin' AND permission='registry:deprecate';
  BEGIN
    PERFORM reset_team_role_permission(c_team,'admin','registry:deprecate');
    RAISE EXCEPTION 'FAIL (T6.6): a member-role caller cleared an allow-default cell that had '
                    'no explicit row. The gate is keyed on row existence, not on whether the '
                    'RESULT would be allow -- so the no-op path is unguarded.';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'PASS (T6.6): reset on a no-row allow-default cell is refused (gate keys on '
               'the resulting effect, not on row existence).';

  -- T6.7  SET-SET-RESET: repeat the write before clearing, in case the gate only inspects
  --       the most recent transition rather than the cell's own default.
  PERFORM set_team_role_permission(c_team,'admin','registry:deprecate','deny');
  PERFORM set_team_role_permission(c_team,'admin','registry:deprecate','deny');
  BEGIN
    PERFORM reset_team_role_permission(c_team,'admin','registry:deprecate');
    RAISE EXCEPTION 'FAIL (T6.7): set-set-reset reached the allow default.';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'PASS (T6.7): set-set-reset does not bypass the widening gate.';

  -- T6.8  The LEGITIMATE reset must still work: a member-role cell defaults to DENY, so
  --       clearing it narrows-or-no-ops and must NOT be blocked. A gate that refuses this
  --       too would be over-broad and would break the delegated manager's actual job.
  PERFORM set_team_role_permission(c_team,'member','registry:approve','deny');
  SELECT reset_team_role_permission(c_team,'member','registry:approve') INTO v_ok;
  IF v_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL (T6.8): clearing a deny-default cell returned % -- expected TRUE '
                    '(a row existed and should have been removed).', v_ok;
  END IF;
  -- ...and it is genuinely gone, and idempotent.
  SELECT reset_team_role_permission(c_team,'member','registry:approve') INTO v_ok;
  IF v_ok IS NOT FALSE THEN
    RAISE EXCEPTION 'FAIL (T6.8): the second reset returned % -- expected FALSE for a no-op.',
                    v_ok;
  END IF;
  RAISE NOTICE 'PASS (T6.8): clearing a deny-default cell is allowed, returns TRUE then FALSE '
               '(idempotent, no spurious raise).';

  -- T6.9  BOTH meta-permissions are owner-only for BOTH verbs, for a non-owner.
  --       team:manage_sso matters as much as team:manage_rbac: whoever controls the IdP
  --       registration can authenticate AS the owner, reaching owner authority in two hops.
  FOREACH v_state IN ARRAY ARRAY['team:manage_rbac','team:manage_sso'] LOOP
    BEGIN
      PERFORM set_team_role_permission(c_team,'admin',v_state,'allow');
      RAISE EXCEPTION 'FAIL (T6.9): a non-owner GRANTED the meta-permission %.', v_state;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM set_team_role_permission(c_team,'admin',v_state,'deny');
      RAISE EXCEPTION 'FAIL (T6.9): a non-owner DENIED the meta-permission % -- they can '
                      'revoke a delegation only the owner should control.', v_state;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM reset_team_role_permission(c_team,'member',v_state);
      RAISE EXCEPTION 'FAIL (T6.9): a non-owner CLEARED the meta-permission % -- a delegated '
                      'manager could strip its own peers, or lock everyone out.', v_state;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
  END LOOP;
  RAISE NOTICE 'PASS (T6.9): both meta-permissions are owner-only for set(allow), set(deny) '
               'and reset.';

  -- T6.10 SELF-ESCALATION via the role RPC: the delegated manager promotes itself to admin,
  --       which would hand it registry:approve/deprecate that team:manage_rbac never granted.
  SELECT id INTO v_mid FROM team_members WHERE team_id=c_team AND user_id=c_mgr;
  BEGIN
    PERFORM set_team_member_role(v_mid,'admin');
    RAISE EXCEPTION 'FAIL (T6.10): SELF-ESCALATION -- a member-role caller holding only '
                    'team:manage_rbac promoted ITSELF to admin, acquiring registry:approve '
                    'and registry:deprecate.';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'PASS (T6.10): a delegated manager cannot self-promote to admin.';

  -- T6.11 OUTRANKING: the delegated manager demotes a real admin.
  SELECT id INTO v_mid FROM team_members WHERE team_id=c_team AND user_id=c_admin;
  BEGIN
    PERFORM set_team_member_role(v_mid,'member');
    RAISE EXCEPTION 'FAIL (T6.11): a member-role caller demoted an ADMIN -- the delegated '
                    'manager outranks every admin on the team.';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'PASS (T6.11): a delegated manager cannot demote an admin.';

  ------------------------------------------------------------------
  -- T6.12  Positive controls as the OWNER. Without these, every PASS above could be
  --        explained by "the RPC refuses everything", which would be equally wrong.
  ------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', c_owner, 'role','authenticated')::text, true);
  PERFORM set_team_role_permission(c_team,'admin','registry:approve','allow');   -- widen
  PERFORM set_team_role_permission(c_team,'admin','team:manage_sso','allow');    -- meta
  SELECT reset_team_role_permission(c_team,'admin','registry:approve') INTO v_ok;
  IF v_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL (T6.12): the owner could not clear a grant it had just written.';
  END IF;
  SELECT reset_team_role_permission(c_team,'admin','team:manage_sso') INTO v_ok;
  IF v_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL (T6.12): the owner could not clear a meta-permission grant.';
  END IF;
  RAISE NOTICE 'PASS (T6.12): the owner CAN widen, set both meta-permissions, and clear '
               'either -- the gates above are selective, not blanket refusals.';

  -- T6.13 Typed input validation: an unenforced permission must raise a TYPED 22023, never
  --       leak the table''s raw 23514 CHECK violation to the caller.
  v_accepted := FALSE;
  BEGIN
    PERFORM set_team_role_permission(c_team,'admin','audit:read','allow');
    v_accepted := TRUE;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '22023' THEN
      RAISE EXCEPTION 'FAIL (T6.13): audit:read raised % (%) instead of a typed 22023. A raw '
                      '23514 CHECK violation here would reach the customer naming internal '
                      'schema objects.', SQLSTATE, SQLERRM;
    END IF;
  END;
  IF v_accepted THEN
    RAISE EXCEPTION 'FAIL (T6.13): a grant for the UNENFORCED permission audit:read was '
                    'ACCEPTED -- it would persist, appear in the effective-permission view, '
                    'and never be checked by anything (the "settable but unenforced" trap).';
  END IF;
  -- The raw table must refuse it too (defence in depth, independent of the RPC).
  v_accepted := FALSE;
  BEGIN
    INSERT INTO team_permission_grants (team_id, role, permission, effect, created_by)
    VALUES (c_team,'admin','audit:read','allow',c_owner);
    v_accepted := TRUE;
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF v_accepted THEN
    RAISE EXCEPTION 'FAIL (T6.13): the team_permission_grants CHECK accepted audit:read.';
  END IF;
  RAISE NOTICE 'PASS (T6.13): unenforced permissions refused with a typed 22023 at the RPC '
               'and 23514 at the table.';

  DELETE FROM team_permission_grants WHERE team_id = c_team;
END $t6$;

-- ============================================================================
-- T7. ERROR-SHAPE CONTRACT.
--
-- rbac-tools.ts maps a refusal to the structured PermissionDeniedError only when the
-- SQLSTATE is 42501 AND the message is either exactly `permission_denied` or one of
-- team-permission-error.ts's PASSTHROUGH_REFUSALS byte-matched sentences. If a message
-- here is reworded without updating that allowlist, the customer silently starts seeing
-- either a raw Postgres string or a generic fallback instead of the authored copy.
--
-- This block pins the exact (sqlstate, message) pairs the TypeScript layer depends on.
-- ============================================================================
DO $t7$
DECLARE
  c_team  CONSTANT TEXT := '_e2e_rbac_6267_team_a';
  c_owner CONSTANT UUID := '62670000-0000-0000-0000-000000000001';
  c_mgr   CONSTANT UUID := '62670000-0000-0000-0000-000000000005';
  v_msg TEXT; v_state TEXT; v_n INT := 0;
BEGIN
  DELETE FROM team_permission_grants WHERE team_id = c_team;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', c_owner,'role','authenticated')::text, true);
  PERFORM set_team_role_permission(c_team,'member','team:manage_rbac','allow');

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', c_mgr,'role','authenticated')::text, true);

  -- (1) the owner-only meta-permission refusal
  BEGIN
    PERFORM set_team_role_permission(c_team,'admin','team:manage_sso','allow');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
    IF v_state <> '42501' THEN
      RAISE EXCEPTION 'FAIL (T7.1): sqlstate % not 42501', v_state;
    END IF;
    IF v_msg <> 'Only the team owner can change who holds the "team:manage_sso" permission.' THEN
      RAISE EXCEPTION 'FAIL (T7.1): message drift. Got: %  -- PASSTHROUGH_REFUSALS in '
                      'team-permission-error.ts byte-matches this string; a reword here '
                      'silently downgrades the customer-facing error.', v_msg;
    END IF;
    v_n := v_n + 1;
  END;

  -- (2) the no-self-widening refusal
  BEGIN
    PERFORM set_team_role_permission(c_team,'admin','registry:approve','allow');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
    IF v_state <> '42501' THEN
      RAISE EXCEPTION 'FAIL (T7.2): sqlstate % not 42501', v_state;
    END IF;
    IF v_msg <> 'Only owners and admins can widen a role''s permissions. You can review '
                'permissions and remove grants, but not add an allow.' THEN
      RAISE EXCEPTION 'FAIL (T7.2): message drift. Got: %', v_msg;
    END IF;
    v_n := v_n + 1;
  END;

  -- (3) the generic denial -- must be EXACTLY `permission_denied`, which is the other
  --     half of toPermissionDeniedError()'s test.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub','62670000-0000-0000-0000-00000000000f',
                      'role','authenticated')::text, true);
  BEGIN
    PERFORM set_team_role_permission(c_team,'admin','registry:approve','deny');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
    IF v_state <> '42501' OR v_msg <> 'permission_denied' THEN
      RAISE EXCEPTION 'FAIL (T7.3): expected (42501, "permission_denied"), got (%, "%")',
                      v_state, v_msg;
    END IF;
    v_n := v_n + 1;
  END;

  ------------------------------------------------------------------
  -- The remaining THREE allowlist entries come from set_team_member_role(). All six
  -- PASSTHROUGH_REFUSALS strings must be pinned, not just the grant-write pair: any one of
  -- them drifting silently downgrades that refusal to the generic sentence.
  ------------------------------------------------------------------
  -- (4) owner-role-change refusal, raised to the OWNER (who holds every permission, so the
  --     refusal cannot be attributed to a missing one).
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', c_owner,'role','authenticated')::text, true);
  BEGIN
    PERFORM set_team_member_role(
      (SELECT id FROM team_members WHERE team_id=c_team AND user_id=c_owner), 'member');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
    IF v_state <> '42501' OR v_msg <> 'cannot change the team owner''s role' THEN
      RAISE EXCEPTION 'FAIL (T7.4): expected (42501, "cannot change the team owner''s role"), '
                      'got (%, "%")', v_state, v_msg;
    END IF;
    v_n := v_n + 1;
  END;

  -- (5) only-the-owner-may-touch-an-admin refusal, raised to the delegated manager.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', c_mgr,'role','authenticated')::text, true);
  BEGIN
    PERFORM set_team_member_role(
      (SELECT id FROM team_members WHERE team_id=c_team
        AND user_id='62670000-0000-0000-0000-000000000002'), 'member');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
    IF v_state <> '42501'
       OR v_msg <> 'forbidden: only the team owner can change an admin''s role' THEN
      RAISE EXCEPTION 'FAIL (T7.5): expected the owner-anchored admin-role refusal, got '
                      '(%, "%")', v_state, v_msg;
    END IF;
    v_n := v_n + 1;
  END;

  -- (6) no-self-promotion refusal, same caller, promotion direction.
  BEGIN
    PERFORM set_team_member_role(
      (SELECT id FROM team_members WHERE team_id=c_team
        AND user_id='62670000-0000-0000-0000-000000000003'), 'admin');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
    IF v_state <> '42501'
       OR v_msg <> 'forbidden: only owners and admins can promote a member to admin' THEN
      RAISE EXCEPTION 'FAIL (T7.6): expected the promotion refusal, got (%, "%")',
                      v_state, v_msg;
    END IF;
    v_n := v_n + 1;
  END;

  IF v_n <> 6 THEN
    RAISE EXCEPTION 'FAIL (T7): only % of 6 refusals were actually raised -- a call that '
                    'should have failed SUCCEEDED.', v_n;
  END IF;
  DELETE FROM team_permission_grants WHERE team_id = c_team;
  RAISE NOTICE 'PASS (T7): all 6 PASSTHROUGH_REFUSALS strings + the generic permission_denied '
               'sentence match the TypeScript allowlist byte-for-byte.';
END $t7$;

-- ============================================================================
-- T9. RLS PROPAGATION -- real row-level access, not just the raw predicate.
--
-- The seam's whole point is that team_ids_with_permission() decides real access to
-- private_registry_skills. Everything above tests the FUNCTION; this tests the POLICY,
-- under `SET LOCAL ROLE authenticated`, which is the only way to make RLS actually
-- evaluate (as `postgres` we bypass it entirely and every assertion would be vacuous).
--
-- NOTE ON SCOPE: 20260827000001_rbac_seam_widening.sql is NOT applied to staging (P0
-- reports this). This block therefore installs the widened policy exactly as that
-- migration specifies, inside this rolled-back transaction, and tests the MECHANISM --
-- "does the SETOF resolver correctly gate a real RLS policy". It does NOT prove staging's
-- deployed policy is widened; P0 is the authority on that, and it says it is not.
-- ============================================================================
DO $t9_setup$
DECLARE v_ns TEXT;
BEGIN
  SELECT skill_namespace INTO v_ns FROM teams WHERE id = '_e2e_rbac_6267_team_a';
  IF v_ns IS NULL THEN
    RAISE EXCEPTION 'FAIL (T9.setup): derive_team_skill_namespace() did not populate '
                    'skill_namespace for the fixture team.';
  END IF;
  PERFORM set_config('smi6267.ns_a', v_ns, true);
  SELECT skill_namespace INTO v_ns FROM teams WHERE id = '_e2e_rbac_6267_team_b';
  PERFORM set_config('smi6267.ns_b', v_ns, true);
END $t9_setup$;

-- Seed one row per tenant, privileged (published_by defaults to auth.uid(), so set a
-- claim first -- a NULL publisher is refused by the approval trigger).
SELECT set_config('request.jwt.claims',
  json_build_object('sub','62670000-0000-0000-0000-000000000001',
                    'role','authenticated')::text, true);
INSERT INTO private_registry_skills (team_id, skill_id, version, description, content, content_hash)
VALUES ('_e2e_rbac_6267_team_a', current_setting('smi6267.ns_a') || '/e2e-rbac-6267-probe',
        '1.0.0', 'SMI-6267 RLS probe', '{"SKILL.md":"probe"}'::jsonb,
        encode(sha256('{"SKILL.md":"probe"}'::bytea), 'hex'));

SELECT set_config('request.jwt.claims',
  json_build_object('sub','62670000-0000-0000-0000-000000000011',
                    'role','authenticated')::text, true);
INSERT INTO private_registry_skills (team_id, skill_id, version, description, content, content_hash)
VALUES ('_e2e_rbac_6267_team_b', current_setting('smi6267.ns_b') || '/e2e-rbac-6267-probe',
        '1.0.0', 'SMI-6267 RLS probe (tenant B)', '{"SKILL.md":"probe"}'::jsonb,
        encode(sha256('{"SKILL.md":"probe"}'::bytea), 'hex'));

-- Both probe rows land at approval_status='pending' (the column default, with
-- trg_prs_approval setting approval_mode='review'). Promote them to 'approved',
-- privileged.
--
-- WHY THIS IS LOAD-BEARING, not fixture noise. The sibling SELECT policy
-- private_registry_skills_member_read is
--   (team_id IN (SELECT user_team_ids())) AND approval_status = 'approved'
-- and Postgres applies SELECT policies to an UPDATE whenever the UPDATE references
-- columns -- which every statement in T9 does, via its WHERE clause. A pending row is
-- therefore invisible to the UPDATE regardless of the admin_update policy, so T9.1 would
-- report "0 rows" and look exactly like an authorization failure while actually testing
-- row VISIBILITY. Approving the rows first isolates the one policy under test.
UPDATE private_registry_skills
   SET approval_status = 'approved', approval_mode = 'auto'
 WHERE team_id IN ('_e2e_rbac_6267_team_a', '_e2e_rbac_6267_team_b');

-- Install the widened policy exactly as 20260827000001 specifies. The `IN (SELECT ...)`
-- shape is load-bearing, not stylistic: it keeps the predicate UNCORRELATED so the planner
-- evaluates it once per query as a hashed SubPlan, instead of once per row.
DROP POLICY IF EXISTS private_registry_skills_admin_update ON private_registry_skills;
CREATE POLICY private_registry_skills_admin_update ON private_registry_skills
  FOR UPDATE TO authenticated
  USING (team_id IN (SELECT team_ids_with_permission('registry:deprecate')))
  WITH CHECK (team_id IN (SELECT team_ids_with_permission('registry:deprecate')));

DO $t9$
DECLARE
  c_a CONSTANT TEXT := '_e2e_rbac_6267_team_a';
  c_b CONSTANT TEXT := '_e2e_rbac_6267_team_b';
  v_ns_a TEXT := current_setting('smi6267.ns_a');
  v_n INT;
BEGIN
  DELETE FROM team_permission_grants WHERE team_id IN (c_a, c_b);

  ------------------------------------------------------------------
  -- T9.1  A default ADMIN can UPDATE (registry:deprecate defaults to allow for admin).
  ------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub','62670000-0000-0000-0000-000000000002',
                      'role','authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  UPDATE private_registry_skills SET deprecated = TRUE
   WHERE team_id = c_a AND skill_id = v_ns_a || '/e2e-rbac-6267-probe';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RESET ROLE;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FAIL (T9.1): a default admin could not UPDATE their own team''s row '
                    '(% rows). The widened policy has locked out the population it must '
                    'preserve.', v_n;
  END IF;
  RAISE NOTICE 'PASS (T9.1): default admin can UPDATE via the widened policy.';

  ------------------------------------------------------------------
  -- T9.2  An explicit DENY on admin x registry:deprecate removes that access.
  ------------------------------------------------------------------
  INSERT INTO team_permission_grants (team_id, role, permission, effect, created_by)
  VALUES (c_a,'admin','registry:deprecate','deny','62670000-0000-0000-0000-000000000001');
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub','62670000-0000-0000-0000-000000000002',
                      'role','authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  UPDATE private_registry_skills SET deprecated = FALSE
   WHERE team_id = c_a AND skill_id = v_ns_a || '/e2e-rbac-6267-probe';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RESET ROLE;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FAIL (T9.2): a DENIED admin still updated % row(s). The deny grant does '
                    'not reach the RLS policy -- grants are settable but unenforced at the '
                    'real enforcement point.', v_n;
  END IF;
  RAISE NOTICE 'PASS (T9.2): an explicit deny removes real row-level UPDATE access.';

  ------------------------------------------------------------------
  -- T9.3  An explicit ALLOW gives a plain MEMBER real access (the new capability).
  ------------------------------------------------------------------
  DELETE FROM team_permission_grants WHERE team_id = c_a;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub','62670000-0000-0000-0000-000000000003',
                      'role','authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  UPDATE private_registry_skills SET deprecated = TRUE
   WHERE team_id = c_a AND skill_id = v_ns_a || '/e2e-rbac-6267-probe';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RESET ROLE;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FAIL (T9.3a): an ungranted member updated % row(s).', v_n;
  END IF;

  INSERT INTO team_permission_grants (team_id, role, permission, effect, created_by)
  VALUES (c_a,'member','registry:deprecate','allow','62670000-0000-0000-0000-000000000001');
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub','62670000-0000-0000-0000-000000000003',
                      'role','authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  UPDATE private_registry_skills SET deprecated = TRUE
   WHERE team_id = c_a AND skill_id = v_ns_a || '/e2e-rbac-6267-probe';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RESET ROLE;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FAIL (T9.3b): a member with an explicit registry:deprecate ALLOW could '
                    'not update (% rows). The grant is settable but unenforced -- exactly the '
                    'trap the plan warns about.', v_n;
  END IF;
  RAISE NOTICE 'PASS (T9.3): an explicit allow grants a plain member real row-level access; '
               'without it, none.';

  ------------------------------------------------------------------
  -- T9.4  CROSS-TENANT: team A's grants never reach team B's rows.
  ------------------------------------------------------------------
  INSERT INTO team_permission_grants (team_id, role, permission, effect, created_by)
  VALUES (c_a,'admin','registry:deprecate','allow','62670000-0000-0000-0000-000000000001')
  ON CONFLICT (team_id, role, permission) DO UPDATE SET effect = 'allow';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub','62670000-0000-0000-0000-000000000002',
                      'role','authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  UPDATE private_registry_skills SET deprecated = TRUE WHERE team_id = c_b;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RESET ROLE;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FAIL (T9.4): team A''s admin updated % row(s) in TEAM B -- cross-tenant '
                    'write through the widened policy.', v_n;
  END IF;
  RAISE NOTICE 'PASS (T9.4): no cross-tenant write through the widened policy.';

  ------------------------------------------------------------------
  -- T9.5  Anonymous callers get nothing.
  ------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims', '', true);
  EXECUTE 'SET LOCAL ROLE anon';
  BEGIN
    UPDATE private_registry_skills SET deprecated = TRUE WHERE team_id = c_a;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  EXCEPTION WHEN insufficient_privilege THEN
    v_n := 0;   -- a hard privilege refusal is an equally acceptable outcome
  END;
  RESET ROLE;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FAIL (T9.5): the anon role updated % row(s).', v_n;
  END IF;
  RAISE NOTICE 'PASS (T9.5): anon cannot write through the widened policy.';

  DELETE FROM team_permission_grants WHERE team_id IN (c_a, c_b);
END $t9$;

-- ============================================================================
-- T10. get_effective_team_permissions -- the read surface the MCP `list_roles` action and
-- the website permission page both render. A wrong answer here is a UI that shows an
-- admin controls they cannot actually use (or hides ones they can).
-- ============================================================================
DO $t10$
DECLARE
  c_team  CONSTANT TEXT := '_e2e_rbac_6267_team_a';
  c_owner CONSTANT UUID := '62670000-0000-0000-0000-000000000001';
  v_rows INT; v_eff TEXT; v_src TEXT; v_state TEXT;
BEGIN
  DELETE FROM team_permission_grants WHERE team_id = c_team;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', c_owner,'role','authenticated')::text, true);

  SELECT count(*) INTO v_rows FROM get_effective_team_permissions(c_team);
  IF v_rows <> 8 THEN
    RAISE EXCEPTION 'FAIL (T10.1): expected 8 rows (2 roles x 4 permissions), got %', v_rows;
  END IF;

  -- Every cell must agree with the design table, and be labelled source='default'.
  SELECT effect, source INTO v_eff, v_src FROM get_effective_team_permissions(c_team)
   WHERE role='admin' AND permission='team:manage_rbac';
  IF v_eff <> 'deny' OR v_src <> 'default' THEN
    RAISE EXCEPTION 'FAIL (T10.2): admin x team:manage_rbac shows (%, %) -- expected '
                    '(deny, default). The UI would offer an admin a control the RPC refuses.',
                    v_eff, v_src;
  END IF;
  SELECT effect, source INTO v_eff, v_src FROM get_effective_team_permissions(c_team)
   WHERE role='admin' AND permission='registry:approve';
  IF v_eff <> 'allow' OR v_src <> 'default' THEN
    RAISE EXCEPTION 'FAIL (T10.2): admin x registry:approve shows (%, %) -- expected '
                    '(allow, default).', v_eff, v_src;
  END IF;

  -- An explicit grant must flip both the effect AND the source label.
  PERFORM set_team_role_permission(c_team,'member','registry:approve','allow');
  SELECT effect, source INTO v_eff, v_src FROM get_effective_team_permissions(c_team)
   WHERE role='member' AND permission='registry:approve';
  IF v_eff <> 'allow' OR v_src <> 'grant' THEN
    RAISE EXCEPTION 'FAIL (T10.3): after an explicit allow, member x registry:approve shows '
                    '(%, %) -- expected (allow, grant).', v_eff, v_src;
  END IF;
  RAISE NOTICE 'PASS (T10.1-3): effective-permission view is complete and correctly sourced.';

  -- T10.4 The view is itself gated on team:manage_rbac -- a plain member must not be able
  -- to read the team's whole permission matrix.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub','62670000-0000-0000-0000-000000000003',
                      'role','authenticated')::text, true);
  BEGIN
    PERFORM count(*) FROM get_effective_team_permissions(c_team);
    RAISE EXCEPTION 'FAIL (T10.4): a plain member read the full effective-permission matrix.';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- ...and so must a default admin, post-SMI-6242.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub','62670000-0000-0000-0000-000000000002',
                      'role','authenticated')::text, true);
  BEGIN
    PERFORM count(*) FROM get_effective_team_permissions(c_team);
    RAISE EXCEPTION 'FAIL (T10.4): a DEFAULT ADMIN read the effective-permission matrix. '
                    'Post-SMI-6242 an admin holds no team:manage_rbac, so this is the same '
                    'privilege-escalation surface SMI-6242 closed, reopened at the read path.';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'PASS (T10.4): the effective-permission view is gated on team:manage_rbac for '
               'members and default admins alike.';

  DELETE FROM team_permission_grants WHERE team_id = c_team;
END $t10$;

-- ============================================================================
-- T11. GRANT-TABLE DIRECT-ACCESS POSTURE.
--
-- Wave 1 revokes INSERT/UPDATE/DELETE/TRUNCATE on team_permission_grants from anon and
-- authenticated, because RLS does not govern TRUNCATE at all: without the revoke, any
-- authenticated user could wipe every deny row in one statement and silently restore
-- every denied admin's default permissions (a fail-OPEN wipe).
-- ============================================================================
DO $t11$
DECLARE v_bad TEXT := ''; v_anon_rows INT;
BEGIN
  IF has_table_privilege('authenticated','team_permission_grants','INSERT') THEN
    v_bad := v_bad || ' INSERT'; END IF;
  IF has_table_privilege('authenticated','team_permission_grants','UPDATE') THEN
    v_bad := v_bad || ' UPDATE'; END IF;
  IF has_table_privilege('authenticated','team_permission_grants','DELETE') THEN
    v_bad := v_bad || ' DELETE'; END IF;
  IF has_table_privilege('authenticated','team_permission_grants','TRUNCATE') THEN
    v_bad := v_bad || ' TRUNCATE'; END IF;
  IF v_bad <> '' THEN
    RAISE EXCEPTION 'FAIL (T11.1): the authenticated role still holds% on '
                    'team_permission_grants. TRUNCATE in particular bypasses RLS entirely and '
                    'would wipe every deny grant.', v_bad;
  END IF;

  IF NOT has_table_privilege('authenticated','team_permission_grants','SELECT') THEN
    RAISE EXCEPTION 'FAIL (T11.2): authenticated has no SELECT -- the member-read RLS policy '
                    'is unreachable and the website permission view would show nothing.';
  END IF;

  -- T11.3 anon WRITE privileges must be gone. This is the one that matters: RLS does not
  -- govern TRUNCATE at all, so a surviving TRUNCATE grant would let any anonymous caller
  -- wipe every deny row -- silently restoring every denied admin's default permissions.
  IF has_table_privilege('anon','team_permission_grants','INSERT')
     OR has_table_privilege('anon','team_permission_grants','UPDATE')
     OR has_table_privilege('anon','team_permission_grants','DELETE')
     OR has_table_privilege('anon','team_permission_grants','TRUNCATE') THEN
    RAISE EXCEPTION 'FAIL (T11.3): the anon role holds a WRITE privilege on '
                    'team_permission_grants. TRUNCATE in particular bypasses RLS entirely.';
  END IF;

  -- T11.3b BEHAVIOURAL check, not just a privilege bit: with a real grant row present, an
  -- anonymous caller must see ZERO rows. This is the property that actually protects the
  -- table, and it is carried by RLS (the sole SELECT policy is `TO authenticated`), not by
  -- the table grant.
  INSERT INTO team_permission_grants (team_id, role, permission, effect, created_by)
  VALUES ('_e2e_rbac_6267_team_a','admin','registry:approve','deny',
          '62670000-0000-0000-0000-000000000001')
  ON CONFLICT (team_id, role, permission) DO UPDATE SET effect = 'deny';
  PERFORM set_config('request.jwt.claims', '', true);
  EXECUTE 'SET LOCAL ROLE anon';
  SELECT count(*) INTO v_anon_rows FROM team_permission_grants;
  RESET ROLE;
  IF v_anon_rows <> 0 THEN
    RAISE EXCEPTION 'FAIL (T11.3b): the anon role can READ % grant row(s). A team''s whole '
                    'permission configuration is exposed to unauthenticated callers.',
                    v_anon_rows;
  END IF;
  DELETE FROM team_permission_grants WHERE team_id = '_e2e_rbac_6267_team_a';

  -- T11.3c DEFENCE-IN-DEPTH GAP, reported not raised. Wave 1 revokes only
  -- INSERT/UPDATE/DELETE/TRUNCATE from anon and grants SELECT to `authenticated` -- it
  -- never revokes SELECT from `anon`, so Supabase's platform-default
  -- `GRANT ALL ON TABLES TO anon, authenticated` leaves that one bit standing. T11.3b just
  -- proved RLS makes it unexploitable (0 rows), so this is NOT a failure -- but it is a
  -- redundant grant that contradicts the migration's own stated "revoked explicitly rather
  -- than left to 'no policy exists to allow it'" posture, and it would become load-bearing
  -- the moment anyone adds a `TO anon` policy or a permissive `TO public` one.
  IF has_table_privilege('anon','team_permission_grants','SELECT') THEN
    PERFORM set_config('smi6267.anon_select_grant', 'true', true);
    RAISE NOTICE 'FINDING (T11.3c, low): anon still holds table-level SELECT on '
                 'team_permission_grants (Supabase default grant; Wave 1''s REVOKE covers '
                 'only INSERT/UPDATE/DELETE/TRUNCATE). RLS blocks every row today, so this '
                 'is defence-in-depth only -- see the SUMMARY.';
  END IF;

  -- The five Wave 1 resolvers must be EXECUTE-able by authenticated but not by anon --
  -- 20260729000001 carries a live smoke assertion on exactly this posture.
  IF has_function_privilege('anon','has_team_permission(text,text)','EXECUTE')
     OR has_function_privilege('anon','team_ids_with_permission(text)','EXECUTE')
     OR has_function_privilege('anon','set_team_member_role(text,text)','EXECUTE')
     OR has_function_privilege('anon','get_effective_team_permissions(text)','EXECUTE') THEN
    RAISE EXCEPTION 'FAIL (T11.4): the anon role can EXECUTE an RBAC resolver.';
  END IF;
  IF NOT has_function_privilege('authenticated','has_team_permission(text,text)','EXECUTE')
     OR NOT has_function_privilege('authenticated','team_ids_with_permission(text)','EXECUTE') THEN
    RAISE EXCEPTION 'FAIL (T11.5): authenticated cannot EXECUTE the resolvers RLS depends on.';
  END IF;

  RAISE NOTICE 'PASS (T11): grant-table and resolver privilege posture is correct for both '
               'authenticated and anon.';
END $t11$;

-- ============================================================================
-- T12. STRUCTURAL INVARIANTS that other blocks silently depend on.
-- ============================================================================
DO $t12$
DECLARE v_def TEXT; v_n INT;
BEGIN
  -- UNIQUE (team_id, role, permission): without it, two rows could exist for one cell and
  -- has_team_permission's `(SELECT r FROM me)` scalar-subquery shape would be reached with
  -- ambiguous input. It is also what makes ON CONFLICT DO UPDATE well-defined.
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conrelid='team_permission_grants'::regclass AND contype='u'
     AND pg_get_constraintdef(oid) LIKE '%team_id%role%permission%';
  IF v_n < 1 THEN
    RAISE EXCEPTION 'FAIL (T12.1): UNIQUE (team_id, role, permission) is missing.';
  END IF;

  -- UNIQUE (team_id, user_id) on team_members: two membership rows for one user in one
  -- team would make has_team_permission''s `me` CTE return 2 rows and raise 21000, while
  -- team_ids_with_permission would happily return the team -- a scalar/SETOF divergence
  -- that T8 could not otherwise reach.
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conrelid='team_members'::regclass AND contype='u'
     AND pg_get_constraintdef(oid) LIKE '%team_id%user_id%';
  IF v_n < 1 THEN
    RAISE EXCEPTION 'FAIL (T12.2): UNIQUE (team_id, user_id) on team_members is missing -- '
                    'duplicate membership would split the scalar and SETOF resolvers.';
  END IF;

  -- The four resolver/writer functions must keep their search_path pin. Losing it is a
  -- search-path-injection privilege escalation on a SECURITY DEFINER function.
  FOR v_def IN
    SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public'
       AND p.proname IN ('has_team_permission','team_ids_with_permission',
                         'get_effective_team_permissions','set_team_member_role',
                         'set_team_role_permission','reset_team_role_permission')
       AND p.prosecdef
       AND (p.proconfig IS NULL
            OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'))
  LOOP
    RAISE EXCEPTION 'FAIL (T12.3): SECURITY DEFINER function % has no search_path pin.', v_def;
  END LOOP;

  -- default_role_permission must stay IMMUTABLE + non-SECURITY-DEFINER + no SET clause, or
  -- the planner stops inlining it and every RLS read that depends on it goes O(rows).
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='default_role_permission'
     AND p.provolatile='i' AND NOT p.prosecdef AND p.proconfig IS NULL;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FAIL (T12.4): default_role_permission is no longer IMMUTABLE / '
                    'non-SECURITY-DEFINER / SET-clause-free -- the planner can no longer '
                    'inline it, and every policy that reaches it regresses to per-row '
                    'evaluation.';
  END IF;

  RAISE NOTICE 'PASS (T12): structural invariants (uniqueness, search_path pins, '
               'inlinability) hold.';
END $t12$;

-- ============================================================================
-- FINAL SUMMARY. Re-prints the P0 deployed-state findings, which are deliberately NOT
-- fatal: they describe the DATABASE, while everything above describes the CODE.
-- ============================================================================
DO $summary$
DECLARE
  v_sv TEXT := current_setting('smi6267.schema_version', true);
  v_set TEXT := current_setting('smi6267.has_set_rpc', true);
  v_reset TEXT := current_setting('smi6267.has_reset_rpc', true);
  v_rbac TEXT := current_setting('smi6267.admin_rbac_bug', true);
  v_sso  TEXT := current_setting('smi6267.admin_sso_bug', true);
  v_seam TEXT := current_setting('smi6267.seam_widened', true);
  v_anon TEXT := current_setting('smi6267.anon_select_grant', true);
  v_findings INT := 0;
BEGIN
  RAISE NOTICE '====================================================================';
  RAISE NOTICE 'SMI-6267 RBAC UAT: all code-level assertions PASSED.';
  RAISE NOTICE '--------------------------------------------------------------------';
  RAISE NOTICE 'DEPLOYED-STATE FINDINGS for this database (schema_version %):', v_sv;
  IF v_set <> 'true' OR v_reset <> 'true' THEN
    v_findings := v_findings + 1;
    RAISE NOTICE '  [FINDING] The grant-write RPCs are NOT deployed here '
                 '(set=%, reset=%). 20260828000000_rbac_grant_writes.sql has not been '
                 'applied. rbac_manage set_role_permission / reset_role_permission would '
                 'fail at runtime.', v_set, v_reset;
  END IF;
  IF v_rbac = 'true' OR v_sso = 'true' THEN
    v_findings := v_findings + 1;
    RAISE NOTICE '  [FINDING - SECURITY] SMI-6242 is LIVE here: default_role_permission '
                 'grants admin team:manage_rbac=% team:manage_sso=%. Every team admin can '
                 'rewrite the permission matrix and claim SSO domains.', v_rbac, v_sso;
  END IF;
  IF v_seam <> 'true' THEN
    v_findings := v_findings + 1;
    RAISE NOTICE '  [FINDING] The registry seam is NOT widened here -- '
                 'private_registry_skills_admin_update still uses user_admin_team_ids(), so '
                 'permission grants have NO effect on the real enforcement point.';
  END IF;
  IF v_anon = 'true' THEN
    v_findings := v_findings + 1;
    RAISE NOTICE '  [FINDING - low, defence-in-depth] anon holds table-level SELECT on '
                 'team_permission_grants. NOT exploitable today (T11.3b proves RLS returns '
                 '0 rows to anon), but the grant is redundant and contradicts Wave 1''s own '
                 'explicit-revoke posture. Fix: REVOKE SELECT ON team_permission_grants '
                 'FROM anon.';
  END IF;
  IF v_findings = 0 THEN
    RAISE NOTICE '  None -- this database carries the full, corrected Wave 1 + Wave 2 state.';
  END IF;
  RAISE NOTICE '====================================================================';
END $summary$;

-- ============================================================================
-- Everything -- fixtures, grants, the spliced Wave 2 functions, the T9 policy swap -- is
-- discarded here. Nothing this file did survives.
-- ============================================================================
ROLLBACK;

-- Post-rollback proof that we left no trace. Runs in its own implicit transaction.
DO $verify$
DECLARE v_teams INT; v_users INT; v_rpc BOOLEAN;
BEGIN
  SELECT count(*) INTO v_teams FROM teams WHERE id LIKE '\_e2e\_rbac\_6267\_%';
  SELECT count(*) INTO v_users FROM auth.users WHERE email LIKE 'e2e-rbac-6267-%@example.test';
  SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='set_team_role_permission')
    INTO v_rpc;
  IF v_teams <> 0 OR v_users <> 0 THEN
    RAISE EXCEPTION 'CLEANUP FAIL: % fixture team(s) and % fixture user(s) survived the '
                    'ROLLBACK. Remove them manually: DELETE FROM teams WHERE id LIKE '
                    '''\_e2e\_rbac\_6267\_%%''; DELETE FROM auth.users WHERE email LIKE '
                    '''e2e-rbac-6267-%%@example.test'';', v_teams, v_users;
  END IF;
  RAISE NOTICE 'CLEANUP VERIFIED: 0 fixture teams, 0 fixture users remain. '
               'set_team_role_permission present after rollback = % (matches P0''s '
               'deployed-state reading, NOT the shim).', v_rpc;
END $verify$;
