-- ============================================================================
-- Invocation: run via scripts/staging/smi-5817-rls-role-boundary.sh (from any cwd -- that
-- wrapper resolves this file's path relative to its own location, not the caller's cwd, and
-- refuses to run if this file is missing). Never invoke this file directly through
-- `./scripts/pooler-psql.sh -f <path>` -- that resolves the path INSIDE the container, and
-- from a worktree resolves against the MAIN checkout's container (SMI-5559), where this
-- file does not exist. See the wrapper script's own header for the exact piped-stdin form
-- it uses; do not hand-reproduce it here where it could drift out of sync.
-- ============================================================================

-- SMI-5817 ad-hoc staging verification: skill_update_notifications_sent RLS.
-- NOT a CI test -- no live-Postgres role-switching harness exists (Linear SMI-5825).
-- STAGING ONLY (ovhcifugwqnzoebwfuku). All fixtures rolled back.
--
-- HARD GUARD. This script INSERTs rows into auth.users. Running it against prod would
-- create real orphaned auth users. `pooler-psql.sh` connects with SUPABASE_PROJECT_REF,
-- which in .env is the PROD ref -- so "I ran the documented command" is NOT evidence that
-- this hit staging. Two independent gates:
--   (1) the shell wrapper above refuses unless STAGING_SUPABASE_PROJECT_REF is set, and
--       passes it in as :confirm_ref;
--   (2) this block refuses unless :confirm_ref is BOTH set AND equal to the staging ref.
-- A bare `cat file | ./scripts/pooler-psql.sh` leaves :confirm_ref unset and stops at (2).
\set ON_ERROR_STOP on

-- `\quit` deliberately NOT used here: it exits psql with status 0 (it is not an error to
-- psql, just an early stop), which would make a bare `cat file | ./scripts/pooler-psql.sh`
-- -- skipping the wrapper entirely -- silently "succeed" having asserted nothing. A RAISE
-- EXCEPTION inside ON_ERROR_STOP is what actually makes this refusal a non-zero exit.
\if :{?confirm_ref}
\else
  \echo '*** REFUSING: :confirm_ref is not set. Run this through the wrapper documented in'
  \echo '*** docs/internal/implementation/smi-5817-drift-detection-public-private-registry.md'
  DO $guard0$ BEGIN
    RAISE EXCEPTION 'REFUSING: :confirm_ref is not set -- this script must be invoked via '
                    'scripts/staging/smi-5817-rls-role-boundary.sh, never piped directly.';
  END $guard0$;
\endif

SELECT :'confirm_ref' = 'ovhcifugwqnzoebwfuku' AS is_staging \gset
\if :is_staging
\else
  \echo '*** REFUSING: connected project ref is not staging.'
  DO $guard$ BEGIN
    RAISE EXCEPTION 'REFUSING: this script INSERTs fixture rows into auth.users and may only '
                    'run against the staging project (ovhcifugwqnzoebwfuku).';
  END $guard$;
\endif

BEGIN;

INSERT INTO auth.users (id, email) VALUES
  ('5817cccc-0000-0000-0000-000000000001', 'smi5817-rls-1@example.test'),
  ('5817cccc-0000-0000-0000-000000000002', 'smi5817-rls-2@example.test')
ON CONFLICT (id) DO NOTHING;

INSERT INTO skill_update_notifications_sent
  (user_id, source_key, skill_id, last_notified_hash)
VALUES ('5817cccc-0000-0000-0000-000000000001', 'public', 'smi5817/rls', repeat('f', 64));

-- U1 sees exactly its own row.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"5817cccc-0000-0000-0000-000000000001","role":"authenticated"}', true);
SELECT 'U1 own rows (expect 1): ' || count(*) FROM skill_update_notifications_sent;

-- U2 sees ZERO. Any non-zero here is a cross-user leak.
SELECT set_config('request.jwt.claims',
  '{"sub":"5817cccc-0000-0000-0000-000000000002","role":"authenticated"}', true);
SELECT 'U2 cross-user rows (expect 0): ' || count(*) FROM skill_update_notifications_sent;

-- U1 must not be able to delete its own ledger row (owner SELECT only -- AC-2).
SELECT set_config('request.jwt.claims',
  '{"sub":"5817cccc-0000-0000-0000-000000000001","role":"authenticated"}', true);
DELETE FROM skill_update_notifications_sent WHERE user_id IS NOT NULL;  -- expect 0 rows
SELECT 'U1 rows after self-delete attempt (expect 1): ' || count(*)
FROM skill_update_notifications_sent;

-- TRUNCATE must be denied. RLS does NOT cover TRUNCATE at all, so this is testing the
-- table-level REVOKE, not a policy -- and it is the one command that could wipe the whole
-- fleet's dedup state and re-notify everyone. Expect `insufficient_privilege`, not a pass.
DO $$
BEGIN
  TRUNCATE skill_update_notifications_sent;
  RAISE EXCEPTION 'FAIL: authenticated could TRUNCATE skill_update_notifications_sent -- the '
                  'table-level REVOKE did not take effect (RLS does not cover TRUNCATE)';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS: authenticated denied TRUNCATE on skill_update_notifications_sent';
END $$;

-- INSERT/UPDATE must also be denied (no owner write policy, and no table grant).
DO $$
BEGIN
  INSERT INTO skill_update_notifications_sent
    (user_id, source_key, skill_id, last_notified_hash)
  VALUES ('5817cccc-0000-0000-0000-000000000001', 'public', 'smi5817/forged', repeat('e', 64));
  RAISE EXCEPTION 'FAIL: authenticated could INSERT a ledger row -- a user can now suppress '
                  'their own real notifications';
EXCEPTION WHEN insufficient_privilege OR check_violation THEN
  RAISE NOTICE 'PASS: authenticated denied INSERT on skill_update_notifications_sent';
END $$;

-- The RPC must be unreachable from `authenticated` at all.
DO $$
BEGIN
  PERFORM * FROM get_skill_update_candidates('immediate');
  RAISE EXCEPTION 'FAIL: authenticated could EXECUTE get_skill_update_candidates';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS: authenticated denied EXECUTE on get_skill_update_candidates';
END $$;

RESET ROLE;
ROLLBACK;
