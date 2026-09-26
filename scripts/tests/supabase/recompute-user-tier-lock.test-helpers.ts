/**
 * SMI-6656: live-Postgres harness for the recompute_user_tier() lost-update race and the
 * recompute_team_members_tier() member-ordering deadlock.
 *
 * WHY THIS EXISTS AT ALL. Both bugs are invisible to a single session. A recompute whose
 * SELECT ran against a stale snapshot and one whose SELECT ran against a fresh snapshot
 * return the SAME shape of result to a session with no competitor -- the only thing that
 * distinguishes "lost the update" from "won the update" is which of two REAL, SIMULTANEOUS
 * writers committed last, and a lone session cannot construct that. Same rationale as the
 * SMI-6321 and SMI-6345 harnesses this one is styled after.
 *
 * CONNECTION. Same five-env-var convention, same deliberate refusal to touch the pooler or
 * any shared environment:
 *
 *   SMI6656_TEST_PGHOST / SMI6656_TEST_PGPORT / SMI6656_TEST_PGUSER /
 *   SMI6656_TEST_PGPASSWORD / SMI6656_TEST_PGDATABASE
 *
 * Stand one up and run the suite:
 *
 *   docker run -d --rm --name smi6656-tierlock-test-pg -e POSTGRES_PASSWORD=testpass \
 *     -e POSTGRES_DB=postgres -p 15656:5432 postgres:17-alpine
 *   # Tear down with `docker stop smi6656-tierlock-test-pg`: --rm then removes the container
 *   # and its anonymous data volume (a bare `docker rm` would leak the volume, SMI-6619).
 *   SMI6656_TEST_PGHOST=host.docker.internal SMI6656_TEST_PGPORT=15656 \
 *   SMI6656_TEST_PGUSER=postgres SMI6656_TEST_PGPASSWORD=testpass \
 *   SMI6656_TEST_PGDATABASE=postgres \
 *     npx vitest run scripts/tests/supabase/recompute-user-tier-lock.pg.test.ts
 *
 * `host.docker.internal` because the suite runs INSIDE the worktree's own dev container,
 * which has no docker CLI, so the sibling Postgres is provisioned from the host and reached
 * through the Docker Desktop gateway.
 *
 * NO CI COVERAGE YET, STATED PRECISELY. No CI check runs this suite: nothing sets these vars,
 * so it skips there -- loudly, never silently (see {@link noLiveTestPg}). Same known, tracked
 * gap SMI-5946 covers for the smi5879/SMI-6321/SMI-6345 suites; this is a fifth consumer of
 * that gap (and a fifth env namespace), not a new one.
 *
 * Do NOT restate this as "CI provisions no Postgres" -- that is the looser claim, and it is
 * wrong. `Test (root)` provisions none, but .github/workflows/grant-reactivate-concurrency.yml
 * DOES: it runs `supabase start` with git-crypt unlocked and triggers on supabase/migrations/**,
 * so it fires on any PR touching a migration -- it just runs one unrelated test file. The
 * machinery exists; this suite is not wired into it. Datapoint filed on SMI-5946.
 *
 * What that workflow DOES enforce, measured on PR #2945 (run 36217320852): `supabase start`
 * applies 20260925000000, so the migration's own smoke blocks execute and pass there. So the
 * lock's SHAPE is CI-enforced; only the behavioural guarantee in this suite is not. Keep the
 * two separate when describing coverage -- conflating them is what made both earlier drafts of
 * this note wrong.
 *
 * POSTGRES VERSION SENSITIVITY -- MEASURED, not assumed (SMI-6505 rule). Prod runs
 * postgres:17.6 (Debian/glibc, via supabase/postgres); the docker one-liner above uses
 * postgres:17-alpine, which at the time this was written resolved to 17.11 (musl). Both were
 * run directly, side by side, against this exact suite: the lost-update reproduction was
 * 100% reliable on BOTH (every red-test run, both engines); the deadlock reproduction (at the
 * shipped MEMBER_COUNT) was 5/5 on 17.6 and 4/5 on 17.11-alpine -- comparable, not identical,
 * but the same qualitative result on both, and the GREEN (fixed-code) assertions held 100% on
 * both across every run and every roster size tried. Row-level lock strength (FOR UPDATE),
 * READ COMMITTED snapshot/MVCC semantics, and the deadlock detector are core lock-manager /
 * storage-engine behavior -- unrelated to musl-vs-glibc OS packaging, and Postgres's own
 * versioning policy restricts 17.x minor/patch releases to bug fixes, not behavior changes to
 * that engine. If prod-parity matters for a specific investigation, pin the one-liner to
 * `postgres:17.6` explicitly rather than the floating `postgres:17-alpine` tag.
 *
 * SCHEMA. Minimal by hand (auth.users, profiles, subscriptions, teams, team_members,
 * license_keys) EXCEPT the two functions actually under test, which are EXTRACTED VERBATIM
 * from the shipped migration files at run time via {@link extractLatestFunction} -- so a
 * body that stops taking the lock, or drops the ORDER BY, fails these tests rather than
 * quietly passing against a stale hand-copy. `tier_rank` is hand-written (a three-line pure
 * lookup, not itself under test), matching the SMI-6321 harness's own convention.
 *
 * @module scripts/tests/supabase/recompute-user-tier-lock.test-helpers
 */

import {
  PsqlSession,
  extractLatestFunction as extractLatestFunctionShared,
  type TestConn,
} from './pg-session.ts'

export { PsqlSession, type TestConn }

/** SMI-6656-labelled wrapper over the shared extractor (error text unchanged). */
export const extractLatestFunction = (functionName: string): string =>
  extractLatestFunctionShared(functionName, 'SMI-6656')

export function testConnFromEnv(env: NodeJS.ProcessEnv = process.env): TestConn | null {
  const host = env.SMI6656_TEST_PGHOST
  const port = env.SMI6656_TEST_PGPORT
  const user = env.SMI6656_TEST_PGUSER
  const password = env.SMI6656_TEST_PGPASSWORD
  const database = env.SMI6656_TEST_PGDATABASE
  if (!host || !port || !user || !password || !database) return null
  return { host, port, user, password, database }
}

export const noLiveTestPg = !testConnFromEnv()

if (noLiveTestPg) {
  console.warn(
    '[smi6656-tier-lock] SKIPPED: no live test Postgres configured ' +
      '(SMI6656_TEST_PGHOST/PORT/USER/PASSWORD/DATABASE unset). This suite is the ONLY ' +
      'coverage that can distinguish a locked recompute from an unlocked one, and an ' +
      'ordered member loop from an unordered one -- a single-session test cannot. Not ' +
      'covered by CI either (see SMI-5946). Run the docker one-liner in this file to ' +
      'exercise it for real.'
  )
}

export function requireTestConn(): TestConn {
  const conn = testConnFromEnv()
  if (!conn) {
    throw new Error(
      'SMI-6656: no live test Postgres configured. Set SMI6656_TEST_PGHOST/PORT/USER/' +
        'PASSWORD/DATABASE -- see this file for a docker run one-liner.'
    )
  }
  return conn
}

/** Test 1 (lost update) -- a single user with one individual subscription. */
export const TEST_USER = '66560000-0000-0000-0000-000000000001'
export const SUB_A = '6656sub0-indv-0000-0000-000000000001'

/**
 * Test 2 (deadlock) -- MEMBER_COUNT members shared by two DIFFERENT teams/subscriptions, with
 * team_members rows inserted in FULLY REVERSED physical order per team. Without ORDER BY, a
 * plain `WHERE team_id = ...` sequential scan over this tiny table returns rows in that
 * physical (insertion) order, so team T1's loop visits MEMBERS ascending while team T2's loop
 * visits the SAME set descending -- opposite-order lock acquisition that produces a real,
 * measured `deadlock detected` on the unfixed body. MEMBERS is lexically ascending so
 * `ORDER BY tm.user_id` makes BOTH loops agree on the SAME ascending order once the fix is in
 * place.
 *
 * MEMBER_COUNT is 8: MEASURED, not assumed (SMI-6505 rule), and NOT "bigger is always
 * better" -- this is the empirically best of four sizes tried against the unfixed body,
 * 5 runs each on both postgres:17.6 (glibc) and postgres:17.11-alpine (musl):
 *
 *   2 members  -> 2/5 (17.6) reproduced `deadlock detected`
 *   4 members  -> 4/5 (17.6)
 *   8 members  -> 5/5 (17.6), 4/5 (17.11-alpine) = 9/10 combined
 *   16 members -> 4/5 (17.6), 3/5 (17.11-alpine) = 7/10 combined -- WORSE than 8, not better
 *
 * A 2-member roster's single race window is too short relative to the fixed Node/OS/network
 * scheduling jitter between the two spawned psql processes for the two sessions' progress to
 * reliably overlap -- one frequently finishes its whole call before the other starts
 * contending at all. Widening the roster widens that overlap window, but the 16-member result
 * shows this is not monotonic: past some point a longer roster likely gives whichever session
 * gets the small initial scheduling edge more room to pull fully ahead before the other one
 * catches up, so this is reported as a measured optimum among the sizes tried, not a general
 * "more is better" rule. NOT reliable in CI regardless of size (this suite skips there; see
 * this file's own "NO CI COVERAGE YET" section) -- the green (fixed-code) assertion below is
 * what a developer running this suite locally relies on, and it held 100% (8/8 combined runs
 * at every size tried) against the fixed migration.
 */
export const MEMBER_COUNT = 8
export const MEMBERS: string[] = Array.from(
  { length: MEMBER_COUNT },
  (_, i) => `66560000-0000-0000-0000-0000000001${String(i).padStart(2, '0')}`
)
export const TEAM_1 = 'smi6656-team-1'
export const TEAM_2 = 'smi6656-team-2'
export const SUB_TEAM_1 = '6656sub0-team-0000-0000-000000000001'
export const SUB_TEAM_2 = '6656sub0-team-0000-0000-000000000002'

/** Test 3 (non-concurrent control) -- a second, independent user. */
export const CONTROL_USER = '66560000-0000-0000-0000-000000000004'
export const SUB_CONTROL = '6656sub0-ctrl-0000-0000-000000000001'

export function schemaSql(): string {
  return `
DROP SCHEMA IF EXISTS auth CASCADE;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id UUID PRIMARY KEY, email TEXT);

DROP TABLE IF EXISTS license_keys CASCADE;
DROP TABLE IF EXISTS team_members CASCADE;
DROP TABLE IF EXISTS teams CASCADE;
DROP TABLE IF EXISTS subscriptions CASCADE;
DROP TABLE IF EXISTS profiles CASCADE;

CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT, tier TEXT NOT NULL DEFAULT 'community',
  role TEXT NOT NULL DEFAULT 'user',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY, user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  tier TEXT NOT NULL, status TEXT NOT NULL
);
CREATE TABLE teams (id TEXT PRIMARY KEY, subscription_id TEXT REFERENCES subscriptions(id));
CREATE TABLE team_members (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member', UNIQUE (team_id, user_id)
);
CREATE TABLE license_keys (
  id TEXT PRIMARY KEY, user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  tier TEXT, status TEXT, revoked_at TIMESTAMPTZ
);

CREATE OR REPLACE FUNCTION tier_rank(p_tier TEXT) RETURNS INTEGER LANGUAGE sql IMMUTABLE AS $tr$
  SELECT CASE p_tier
    WHEN 'community' THEN 0 WHEN 'individual' THEN 1
    WHEN 'team' THEN 2 WHEN 'enterprise' THEN 3 ELSE 0 END;
$tr$;

${extractLatestFunction('recompute_user_tier')}

${extractLatestFunction('recompute_team_members_tier')}
`
}

/** Fixtures for all three tests, always reset together so tests stay order-independent. */
export function fixtureSql(): string {
  const memberUsersSql = MEMBERS.map((m, i) => `('${m}', 'smi6656-member${i}@example.test')`).join(
    ',\n  '
  )
  const memberProfilesSql = MEMBERS.map(
    (m, i) => `('${m}', 'smi6656-member${i}@example.test', 'community', 'user')`
  ).join(',\n  ')
  const team1MembersSql = MEMBERS.map((m) => `('${TEAM_1}', '${m}', 'member')`).join(',\n  ')
  const team2MembersSql = [...MEMBERS]
    .reverse()
    .map((m) => `('${TEAM_2}', '${m}', 'member')`)
    .join(',\n  ')

  return `
DELETE FROM license_keys;
DELETE FROM team_members;
DELETE FROM teams;
DELETE FROM subscriptions;
DELETE FROM profiles;
DELETE FROM auth.users;

INSERT INTO auth.users (id, email) VALUES
  ('${TEST_USER}', 'smi6656-user@example.test'),
  ${memberUsersSql},
  ('${CONTROL_USER}', 'smi6656-control@example.test');

INSERT INTO profiles (id, email, tier, role) VALUES
  ('${TEST_USER}', 'smi6656-user@example.test', 'community', 'user'),
  ${memberProfilesSql},
  ('${CONTROL_USER}', 'smi6656-control@example.test', 'community', 'user');

-- Test 1 fixture: TEST_USER starts with one active individual subscription.
INSERT INTO subscriptions (id, user_id, tier, status)
  VALUES ('${SUB_A}', '${TEST_USER}', 'individual', 'active');

-- Test 2 fixture: two teams, both linked to active TEAM-tier subscriptions, sharing the
-- SAME MEMBER_COUNT members -- inserted in FULLY REVERSED order per team so an unordered scan
-- of team_members WHERE team_id = ... visits them in opposite physical order per team.
INSERT INTO subscriptions (id, user_id, tier, status) VALUES
  ('${SUB_TEAM_1}', NULL, 'team', 'active'),
  ('${SUB_TEAM_2}', NULL, 'team', 'active');
INSERT INTO teams (id, subscription_id) VALUES
  ('${TEAM_1}', '${SUB_TEAM_1}'),
  ('${TEAM_2}', '${SUB_TEAM_2}');
INSERT INTO team_members (team_id, user_id, role) VALUES
  ${team1MembersSql};
INSERT INTO team_members (team_id, user_id, role) VALUES
  ${team2MembersSql};

-- Test 3 fixture: an independent user + subscription, untouched by tests 1/2.
INSERT INTO subscriptions (id, user_id, tier, status)
  VALUES ('${SUB_CONTROL}', '${CONTROL_USER}', 'enterprise', 'active');
`
}
