/**
 * SMI-6321: live-Postgres harness for the departure-purge TOCTOU regression suite.
 *
 * WHY THIS EXISTS AT ALL. The bug being regressed is invisible to any single-session
 * test: an unlocked `SELECT tier` and a `SELECT tier ... FOR UPDATE NOWAIT` return the
 * identical value, in the identical shape, to a session that has no competitor. That
 * is precisely why 20260707000004's own data smoke -- which correctly asserts the
 * purge / cancel / not-yet-due outcomes -- passed for months while the race shipped.
 * Proving the fix therefore requires TWO REAL, SIMULTANEOUS Postgres sessions with a
 * controlled interleaving, which is what {@link PsqlSession} provides.
 *
 * CONNECTION. Same five-env-var convention, and the same deliberate refusal to touch
 * the pooler or any shared environment, as the existing
 * `scripts/tests/indexer/smi5879-census.test-helpers.ts` harness:
 *
 *   SMI6321_TEST_PGHOST / SMI6321_TEST_PGPORT / SMI6321_TEST_PGUSER /
 *   SMI6321_TEST_PGPASSWORD / SMI6321_TEST_PGDATABASE
 *
 * Stand one up and run the suite:
 *
 *   docker run -d --name smi6321-toctou-test-pg -e POSTGRES_PASSWORD=testpass \
 *     -e POSTGRES_DB=postgres -p 15621:5432 postgres:15-alpine
 *   SMI6321_TEST_PGHOST=host.docker.internal SMI6321_TEST_PGPORT=15621 \
 *   SMI6321_TEST_PGUSER=postgres SMI6321_TEST_PGPASSWORD=testpass \
 *   SMI6321_TEST_PGDATABASE=postgres \
 *     npx vitest run scripts/tests/supabase/purge-departed-toctou.pg.test.ts
 *
 * `host.docker.internal` because the suite runs INSIDE the worktree's own dev
 * container, which has no docker CLI, so the sibling Postgres is provisioned from the
 * host and reached through the Docker Desktop gateway.
 *
 * NO CI COVERAGE YET, STATED PLAINLY. CI provisions no Postgres service and sets none
 * of these vars, so this suite skips there -- loudly, never silently (see
 * {@link noLiveTestPg}). That is the same known, tracked gap SMI-5946 already covers
 * for the smi5879 suite; this file adds a second consumer of that gap rather than a
 * new one. It is also why the skip is unconditional-on-config rather than gated on a
 * CI-detection signal: `Test (root)` runs vitest via a bare `docker run` with no `-e`
 * flags, so no environment signal survives that boundary (smi5879's own header
 * documents confirming this live).
 *
 * SCHEMA. This harness builds a MINIMAL schema rather than replaying the real
 * migration chain: the function under test depends on auth.users, profiles,
 * user_devices, teams, subscriptions, team_members and audit_logs, whose real
 * definitions are spread across dozens of interdependent migrations. What is NOT
 * hand-written is the code that actually matters -- both function bodies are
 * EXTRACTED VERBATIM from the shipped migration files at run time
 * ({@link extractFunction}), so editing either migration changes what this suite
 * executes, and a body that stops taking the lock fails these tests rather than
 * quietly passing against a stale copy.
 *
 * @module scripts/tests/supabase/purge-departed-toctou.test-helpers
 */

import {
  PsqlSession,
  extractFunction as extractFunctionShared,
  extractLatestFunction as extractLatestFunctionShared,
  type TestConn,
} from './pg-session.ts'

// SMI-6345: PsqlSession / extractFunction / extractLatestFunction moved verbatim to
// ./pg-session.ts so the SMI-6345 device-lock suite can use the identical harness
// without importing this module (whose module-level skip warning is specific to
// SMI-6321). Re-exported here so this suite's own imports are unchanged.
export { PsqlSession, type TestConn }

/** SMI-6321-labelled wrappers over the shared extractors (error text unchanged). */
export const extractFunction = (migrationFile: string, functionName: string): string =>
  extractFunctionShared(migrationFile, functionName, 'SMI-6321')
export const extractLatestFunction = (functionName: string): string =>
  extractLatestFunctionShared(functionName, 'SMI-6321')

export function testConnFromEnv(env: NodeJS.ProcessEnv = process.env): TestConn | null {
  const host = env.SMI6321_TEST_PGHOST
  const port = env.SMI6321_TEST_PGPORT
  const user = env.SMI6321_TEST_PGUSER
  const password = env.SMI6321_TEST_PGPASSWORD
  const database = env.SMI6321_TEST_PGDATABASE
  if (!host || !port || !user || !password || !database) return null
  return { host, port, user, password, database }
}

export const noLiveTestPg = !testConnFromEnv()

if (noLiveTestPg) {
  console.warn(
    '[smi6321-toctou] SKIPPED: no live test Postgres configured ' +
      '(SMI6321_TEST_PGHOST/PORT/USER/PASSWORD/DATABASE unset). This suite is the ONLY ' +
      'coverage that can distinguish a locked tier read from an unlocked one — a ' +
      'single-session test cannot. Not covered by CI either (see SMI-5946). Run the ' +
      'docker one-liner in this file to exercise it for real.'
  )
}

export function requireTestConn(): TestConn {
  const conn = testConnFromEnv()
  if (!conn) {
    throw new Error(
      'SMI-6321: no live test Postgres configured. Set SMI6321_TEST_PGHOST/PORT/USER/' +
        'PASSWORD/DATABASE — see this file for a docker run one-liner.'
    )
  }
  return conn
}

export const PURGE_MIGRATION = '20260901120000_purge_departed_inventory_toctou_lock.sql'
export const TIER_SYNC_MIGRATION = '20260524000002_team_member_tier_sync.sql'

export const TEST_USER = '63210000-0000-0000-0000-000000000001'
export const TEST_DEVICE = '6321dddd-0000-0000-0000-000000000001'
export const TEST_TEAM = 'smi6321-team'

/**
 * Minimal schema + the two REAL function bodies. `tier_rank` and `test_sso_reauth` are
 * the only hand-written functions: the former is a three-line pure lookup, the latter
 * is a deliberate stand-in for `record_sso_login()`'s WRITE HALF only — the two writes
 * that matter to this race (the team_members re-provision and the
 * `recompute_user_tier()` call), in the same order and the same transaction the real
 * function performs them. The real function's SSO plumbing reads signed JWT claims and
 * cannot be driven from a test session at all; substituting it here would prove
 * nothing the race depends on, since the race is entirely between
 * `recompute_user_tier()`'s profiles UPDATE and the sweep's tier read.
 */
export function schemaSql(): string {
  return `
DROP SCHEMA IF EXISTS auth CASCADE;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id UUID PRIMARY KEY, email TEXT);

DROP TABLE IF EXISTS audit_logs CASCADE;
DROP TABLE IF EXISTS team_member_inventory_purge_schedule CASCADE;
DROP TABLE IF EXISTS user_devices CASCADE;
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
CREATE TABLE subscriptions (id TEXT PRIMARY KEY, user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE, tier TEXT NOT NULL, status TEXT NOT NULL);
CREATE TABLE teams (id TEXT PRIMARY KEY, subscription_id TEXT REFERENCES subscriptions(id));
CREATE TABLE team_members (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member', UNIQUE (team_id, user_id)
);
CREATE TABLE license_keys (id TEXT PRIMARY KEY, user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE, tier TEXT, status TEXT);
CREATE TABLE user_devices (
  device_id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label TEXT, last_seen_at TIMESTAMPTZ
);
CREATE TABLE team_member_inventory_purge_schedule (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  departed_team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  scheduled_purge_at TIMESTAMPTZ NOT NULL,
  purged_at TIMESTAMPTZ,
  cancelled_reason TEXT CHECK (cancelled_reason IS NULL OR char_length(cancelled_reason) <= 64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_team_member_purge_schedule_pending
  ON team_member_inventory_purge_schedule (scheduled_purge_at)
  WHERE purged_at IS NULL AND cancelled_reason IS NULL;
CREATE TABLE audit_logs (
  id BIGSERIAL PRIMARY KEY, event_type TEXT, actor TEXT, resource TEXT, action TEXT,
  result TEXT, metadata JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION tier_rank(p_tier TEXT) RETURNS INTEGER LANGUAGE sql IMMUTABLE AS $tr$
  SELECT CASE p_tier WHEN 'individual' THEN 1 WHEN 'team' THEN 2 WHEN 'enterprise' THEN 3 ELSE 0 END;
$tr$;

${extractLatestFunction('recompute_user_tier')}

${extractLatestFunction('purge_departed_team_members_inventory')}

CREATE OR REPLACE FUNCTION test_sso_reauth(p_user_id UUID, p_team_id TEXT)
RETURNS TEXT LANGUAGE plpgsql AS $tsr$
BEGIN
  INSERT INTO team_members (id, team_id, user_id, role)
  VALUES ('tm-' || p_user_id::text || '-' || p_team_id, p_team_id, p_user_id, 'member')
  ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role;
  UPDATE license_keys SET status = 'active' WHERE user_id = p_user_id AND TRUE;
  RETURN recompute_user_tier(p_user_id);
END;
$tsr$;
`
}

/**
 * The exact pre-race state of the SMI-6312 R4 UAT scenario: a member who departed >30
 * days ago (due, PENDING schedule row), currently community-tier, holding one device,
 * whose team still has an ACTIVE enterprise subscription — so a re-authentication
 * genuinely restores full entitlement rather than being a no-op.
 */
export function fixtureSql(opts: { withProfile?: boolean } = {}): string {
  const withProfile = opts.withProfile !== false
  return `
DELETE FROM team_member_inventory_purge_schedule;
DELETE FROM user_devices;
DELETE FROM license_keys;
DELETE FROM team_members;
DELETE FROM teams;
DELETE FROM subscriptions;
DELETE FROM profiles;
DELETE FROM auth.users;
DELETE FROM audit_logs;
INSERT INTO auth.users (id, email) VALUES ('${TEST_USER}', 'smi6321@example.test');
${withProfile ? `INSERT INTO profiles (id, email, tier, role) VALUES ('${TEST_USER}', 'smi6321@example.test', 'community', 'user');` : ''}
INSERT INTO subscriptions (id, user_id, tier, status) VALUES ('smi6321-sub', NULL, 'enterprise', 'active');
INSERT INTO teams (id, subscription_id) VALUES ('${TEST_TEAM}', 'smi6321-sub');
INSERT INTO license_keys (id, user_id, tier, status) VALUES ('smi6321-lk', '${TEST_USER}', 'enterprise', 'revoked');
INSERT INTO user_devices (device_id, user_id, label, last_seen_at) VALUES ('${TEST_DEVICE}', '${TEST_USER}', 'uat-box', now());
INSERT INTO team_member_inventory_purge_schedule (user_id, departed_team_id, scheduled_purge_at)
VALUES ('${TEST_USER}', '${TEST_TEAM}', now() - INTERVAL '1 day');
`
}
