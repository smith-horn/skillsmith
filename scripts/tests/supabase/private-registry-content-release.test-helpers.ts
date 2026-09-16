/**
 * SMI-6651 (plan D14, ADR-162 §1): live-Postgres harness for
 * `release_private_registry_skill_content()` — the SECURITY DEFINER RPC that is now the ONLY
 * path back to `private_registry_skills.content` for `authenticated`.
 *
 * WHY LIVE POSTGRES. Every property under test is a PRIVILEGE property (column grant, RLS
 * policy, function EXECUTE ACL) or a TRANSACTIONAL one (an audit-insert failure rolling back a
 * return value) — neither can be faked by a client mock; `has_column_privilege` needs a real
 * catalog and "the call rolled back" can only be observed by trying to violate it.
 *
 * CONNECTION (SMI-6321/6345/6362 five-var convention):
 *   SMI6651_TEST_PGHOST/PORT/USER/PASSWORD/DATABASE. Run from inside the worktree's dev
 *   container (reaches the host Postgres via `host.docker.internal`):
 *
 *   docker run -d --rm --name smi6651-release-test-pg -e POSTGRES_PASSWORD=testpass \
 *     -e POSTGRES_DB=postgres -p 15651:5432 postgres:17-alpine
 *   SMI6651_TEST_PGHOST=host.docker.internal SMI6651_TEST_PGPORT=15651 \
 *   SMI6651_TEST_PGUSER=postgres SMI6651_TEST_PGPASSWORD=testpass SMI6651_TEST_PGDATABASE=postgres \
 *     npx vitest run scripts/tests/supabase/private-registry-content-release.pg.test.ts
 *   # Tear down: `docker stop smi6651-release-test-pg` (--rm also removes its data volume).
 *
 * NO CI COVERAGE YET — same tracked gap as SMI-5946's other live-PG suites.
 *
 * REAL vs STUBBED. REAL (extracted/read verbatim at run time): `user_team_ids()` /
 * `user_admin_team_ids()` (071_team_workspaces.sql, PINNED there rather than via
 * `extractLatestFunction` — 074's own text contains `CREATE OR REPLACE FUNCTION user_team_ids`
 * only inside its non-executed rollback comment, same gotcha SMI-6362's `userTeamIdsSql()`
 * documents); `check_registry_team_entitlement()` (20260824000000); the
 * `private_registry_skills_member_read` (20260809000000, approval-gated form),
 * `private_registry_skills_admin_update` (20260724000000) and `audit_logs_team_scoped_read`
 * (20260420020000, RLS enabled on the stub `audit_logs` too) RLS policies; the INSERT/UPDATE
 * column grants (20260729000000:266-272); and THE ENTIRE NEW MIGRATION FILE verbatim
 * (`migrationSql()`) — so this suite also proves the migration applies cleanly, not just that
 * copied assertions pass. STUBBED (real definitions are entangled with unrelated columns/
 * triggers this RPC never reads): `auth.uid()` (a session GUC, `smi6651.uid`, instead of a
 * signed GoTrue JWT); `profiles` / `subscriptions` / `teams` / `team_members` /
 * `private_registry_skills` (minimal hand-written tables); `audit_logs` / `schema_version`
 * match 001_initial_schema.sql's real column sets exactly.
 *
 * @module scripts/tests/supabase/private-registry-content-release.test-helpers
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractFunction, extractStatement, type TestConn } from './pg-session.ts'

export { PsqlSession, type TestConn } from './pg-session.ts'

const MIGRATIONS_DIR = 'supabase/migrations'
const NEW_MIGRATION = '20260915000000_private_registry_content_release_rpc.sql'
const TEAM_HELPERS_MIGRATION = '071_team_workspaces.sql'
const ENTITLEMENT_MIGRATION = '20260824000000_check_registry_team_entitlement.sql'
const BASE_TABLE_MIGRATION = '20260724000000_private_registry_skills.sql'
const APPROVAL_GATE_MIGRATION = '20260809000000_private_registry_approval_gate.sql'
const PRIVILEGE_HARDENING_MIGRATION = '20260729000000_private_registry_privilege_hardening.sql'
const AUDIT_LOGS_RLS_MIGRATION = '20260420020000_audit_logs_team_rls.sql'
const LABEL = 'SMI-6651'

// ============================================================================
// Connection env (SMI-6321/SMI-6345/SMI-6362 five-var convention)
// ============================================================================

export function testConnFromEnv(env: NodeJS.ProcessEnv = process.env): TestConn | null {
  const host = env.SMI6651_TEST_PGHOST
  const port = env.SMI6651_TEST_PGPORT
  const user = env.SMI6651_TEST_PGUSER
  const password = env.SMI6651_TEST_PGPASSWORD
  const database = env.SMI6651_TEST_PGDATABASE
  if (!host || !port || !user || !password || !database) return null
  return { host, port, user, password, database }
}

export const noLiveTestPg = !testConnFromEnv()

if (noLiveTestPg) {
  console.warn(
    '[smi6651-content-release] no live test Postgres configured ' +
      '(SMI6651_TEST_PGHOST/PORT/USER/PASSWORD/DATABASE unset), so the live-Postgres half of this ' +
      'suite (.pg.test.ts) will SKIP. The PG-free structural half (.structural.test.ts) still ' +
      'runs — do not read this warning as "nothing ran" (SMI-6690). The skipped half is the ONLY ' +
      'coverage that executes the shipped release_private_registry_skill_content() body, its ' +
      "column-vs-table SELECT privilege split, and the migration file's own internal smoke block " +
      'against a real Postgres catalog — a mocked test cannot prove any of the three. Not covered ' +
      "by CI (same tracked gap as SMI-5946). See this file's header for the docker one-liner."
  )
}

export function requireTestConn(): TestConn {
  const conn = testConnFromEnv()
  if (!conn) {
    throw new Error(
      'SMI-6651: no live test Postgres configured. Set SMI6651_TEST_PGHOST/PORT/USER/PASSWORD/' +
        'DATABASE — see this file for a docker run one-liner.'
    )
  }
  return conn
}

// ============================================================================
// Fixture identities
// ============================================================================

export const MEMBER = '66510000-0000-0000-0000-000000000001' // member of every ENT_TEAMS row below
export const ADMIN = '66510000-0000-0000-0000-000000000002' // admin of TEAM_ENT, owner of TEAM_OTHER
export const MEMBER2 = '66510000-0000-0000-0000-000000000003' // fellow member of TEAM_ENT + TEAM_LAPSED, for V-visibility
export const TEAM_ENT = 'smi6651-team-ent' // enterprise / active — entitled
export const TEAM_LAPSED = 'smi6651-team-lapsed' // enterprise / canceled — E2
export const TEAM_OTHER = 'smi6651-team-other' // MEMBER is not a member of this one
export const TEAM_TIER = 'smi6651-team-tier' // tier='team', active — E1 + E6 (cross-team leak)
export const TEAM_NO_SUB = 'smi6651-team-no-sub' // subscription_id NULL — E3
export const TEAM_DANGLING = 'smi6651-team-dangling' // subscription_id points nowhere — E4
export const TEAM_TRIALING = 'smi6651-team-trialing' // enterprise / trialing — E5
export const TEAM_PASTDUE = 'smi6651-team-pastdue' // enterprise / past_due — E5
export const BODY_V1 = 'BODY_SENTINEL_V1_SMI6651'
export const BODY_V2 = 'BODY_SENTINEL_V2_SMI6651'
export const BODY_FALLBACK_V1 = 'BODY_SENTINEL_FALLBACK_V1_SMI6651'

/** One entitlement-denial fixture per E1/E3/E4/E5 row: a team, its subscription (or lack of
 *  one), and one approved/non-deprecated skill row so the RPC reaches step 3 (entitlement) for
 *  every one of them. `subId: null` means no subscription row is inserted at all (E3); the
 *  dangling case (E4) is handled separately below because it needs an FK bypass. */
export interface EntitlementTeamFixture {
  id: string
  subId: string | null
  tier?: string
  status?: string
  skillId: string
}
export const ENTITLEMENT_TEAMS: readonly EntitlementTeamFixture[] = [
  {
    id: TEAM_TIER,
    subId: 'smi6651-sub-tier',
    tier: 'team',
    status: 'active',
    skillId: 'smi6651/tier-skill',
  },
  { id: TEAM_NO_SUB, subId: null, skillId: 'smi6651/no-sub-skill' },
  {
    id: TEAM_TRIALING,
    subId: 'smi6651-sub-trialing',
    tier: 'enterprise',
    status: 'trialing',
    skillId: 'smi6651/trialing-skill',
  },
  {
    id: TEAM_PASTDUE,
    subId: 'smi6651-sub-pastdue',
    tier: 'enterprise',
    status: 'past_due',
    skillId: 'smi6651/pastdue-skill',
  },
]

/** Set the impersonated caller for the rest of the session (GUC persists until changed). */
export function asUid(uid: string | null): string {
  return `SELECT set_config('smi6651.uid', '${uid ?? ''}', false);`
}

// ============================================================================
// Real SQL, extracted verbatim
// ============================================================================

function realTeamHelpers(): string {
  // Real grants (071:68-70) load-bearing here: the RLS policies below invoke these AS THE
  // CALLING ROLE (`authenticated`), unlike the RPC's own internal calls, which run as owner.
  const g1 = extractStatement(
    TEAM_HELPERS_MIGRATION,
    /GRANT EXECUTE ON FUNCTION user_team_ids\(\)/,
    LABEL
  )
  const g2 = extractStatement(
    TEAM_HELPERS_MIGRATION,
    /GRANT EXECUTE ON FUNCTION user_admin_team_ids\(\)/,
    LABEL
  )
  return [
    extractFunction(TEAM_HELPERS_MIGRATION, 'user_team_ids', LABEL),
    extractFunction(TEAM_HELPERS_MIGRATION, 'user_admin_team_ids', LABEL),
    g1,
    g2,
  ].join('\n\n')
}

function realEntitlementFunction(): string {
  const grant = extractStatement(
    ENTITLEMENT_MIGRATION,
    /GRANT EXECUTE ON FUNCTION public\.check_registry_team_entitlement\(TEXT\)/,
    LABEL
  )
  return [
    extractFunction(ENTITLEMENT_MIGRATION, 'public.check_registry_team_entitlement', LABEL),
    grant,
  ].join('\n\n')
}

/** The REAL audit_logs_team_scoped_read policy (20260420020000) -- RLS on the stub `audit_logs`
 *  is enabled here too, so the V-visibility test exercises the actual policy, not a fixture
 *  stand-in. `actor = auth.uid()::TEXT` never matches this RPC's `'user:' || v_uid` actor (same
 *  as trg_prs_audit's), so visibility in practice turns entirely on the OTHER branch,
 *  `metadata->>'team_id' IN (SELECT user_team_ids())` -- exactly the property under test.
 *  MEASURED: RLS alone is not enough on a plain (non-hosted-Supabase) Postgres -- a hosted
 *  project's `ALTER DEFAULT PRIVILEGES` implicitly grants `authenticated` table-wide SELECT at
 *  table-create time (same gap 20260724000000:95-110 hit and fixed for private_registry_skills),
 *  and this stub table predates that grant entirely; without it `authenticated` gets 42501
 *  ("permission denied for table") before RLS ever gets a chance to filter anything. */
function realAuditLogsPolicy(): string {
  return [
    'ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;',
    'GRANT SELECT ON TABLE audit_logs TO authenticated;',
    extractStatement(AUDIT_LOGS_RLS_MIGRATION, /CREATE POLICY audit_logs_team_scoped_read/, LABEL),
  ].join('\n\n')
}

function realPoliciesAndGrants(): string {
  return [
    extractStatement(
      APPROVAL_GATE_MIGRATION,
      /CREATE POLICY private_registry_skills_member_read/,
      LABEL
    ),
    extractStatement(
      BASE_TABLE_MIGRATION,
      /CREATE POLICY private_registry_skills_admin_update/,
      LABEL
    ),
    extractStatement(
      PRIVILEGE_HARDENING_MIGRATION,
      /REVOKE INSERT, UPDATE, TRUNCATE ON TABLE private_registry_skills/,
      LABEL
    ),
    extractStatement(PRIVILEGE_HARDENING_MIGRATION, /GRANT INSERT \(team_id/, LABEL),
    extractStatement(PRIVILEGE_HARDENING_MIGRATION, /GRANT UPDATE \(deprecated\)/, LABEL),
  ].join('\n\n')
}

/** The REAL new migration file, verbatim, unmodified. */
export function migrationSql(): string {
  const path = join(process.cwd(), MIGRATIONS_DIR, NEW_MIGRATION)
  return readFileSync(path, 'utf8')
}

// ============================================================================
// Minimal schema (stub tables/roles/auth) + REAL extracted functions/policies/grants. Does NOT
// include the new migration — callers append `migrationSql()` or `brokenMigrationSql(v)`.
// ============================================================================

export function baseSchemaSql(): string {
  return `
RESET ROLE;
DO $roles$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $roles$;

DROP SCHEMA IF EXISTS auth CASCADE;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id UUID PRIMARY KEY, email TEXT);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $au$
  SELECT NULLIF(current_setting('smi6651.uid', true), '')::uuid;
$au$;

DROP TABLE IF EXISTS audit_logs, private_registry_skills, team_members, teams, subscriptions, profiles, schema_version CASCADE;
DROP FUNCTION IF EXISTS user_team_ids() CASCADE;
DROP FUNCTION IF EXISTS user_admin_team_ids() CASCADE;
DROP FUNCTION IF EXISTS check_registry_team_entitlement(TEXT) CASCADE;
DROP FUNCTION IF EXISTS release_private_registry_skill_content(TEXT, TEXT, TEXT, TEXT, TEXT) CASCADE;

CREATE TABLE profiles (id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE, email TEXT);
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY, user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  tier TEXT NOT NULL, status TEXT NOT NULL
);
CREATE TABLE teams (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  subscription_id TEXT REFERENCES subscriptions(id) ON DELETE SET NULL
);
CREATE TABLE team_members (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member', UNIQUE (team_id, user_id)
);
-- Matches 001_initial_schema.sql's real column set exactly.
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, event_type TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(), actor TEXT, resource TEXT, action TEXT, result TEXT,
  metadata JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Matches 001_initial_schema.sql:10-13 exactly -- the migration's own schema_version INSERT (117)
-- needs a real target, and T2 asserts on it.
CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE private_registry_skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL, version TEXT NOT NULL, description TEXT, content JSONB NOT NULL,
  content_hash TEXT NOT NULL, deprecated BOOLEAN NOT NULL DEFAULT FALSE,
  published_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approval_status TEXT NOT NULL DEFAULT 'approved', approval_mode TEXT NOT NULL DEFAULT 'auto',
  approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL, approved_at TIMESTAMPTZ,
  review_note TEXT, UNIQUE (team_id, skill_id, version)
);

ALTER TABLE private_registry_skills ENABLE ROW LEVEL SECURITY;
-- Mirrors 20260724000000:110's real baseline grant, so the migration's own REVOKE (step 1) has
-- something to revoke, and (e)'s column-only REVOKE has a table-wide grant to prove ineffective against.
GRANT SELECT ON TABLE private_registry_skills TO authenticated, service_role;

${realTeamHelpers()}

${realAuditLogsPolicy()}

${realPoliciesAndGrants()}

${realEntitlementFunction()}
`
}

// ============================================================================
// Fixtures — one shared dataset, reloaded fresh (DELETE + INSERT) before every test.
// ============================================================================

export function fixtureSql(): string {
  const entSubs = ENTITLEMENT_TEAMS.filter((t) => t.subId !== null)
    .map((t) => `  ('${t.subId}', '${MEMBER}', '${t.tier}', '${t.status}')`)
    .join(',\n')
  const entTeams = ENTITLEMENT_TEAMS.map(
    (t) => `  ('${t.id}', '${t.id}', '${MEMBER}', ${t.subId ? `'${t.subId}'` : 'NULL'})`
  ).join(',\n')
  const entMembers = ENTITLEMENT_TEAMS.map((t) => `  ('${t.id}', '${MEMBER}', 'member')`).join(
    ',\n'
  )
  const entSkills = ENTITLEMENT_TEAMS.map(
    (t) =>
      `  ('${t.id}', '${t.skillId}', '1.0.0', 'entitlement fixture', '{"SKILL.md":"body"}'::jsonb, ` +
      `'hash-${t.id}', false, '${MEMBER}', now(), 'approved')`
  ).join(',\n')

  return `
RESET ROLE;
DELETE FROM audit_logs;
DELETE FROM private_registry_skills;
DELETE FROM team_members;
DELETE FROM subscriptions;
DELETE FROM teams;
DELETE FROM profiles;
DELETE FROM auth.users;

INSERT INTO auth.users (id, email) VALUES
  ('${MEMBER}', 'smi6651-member@example.test'),
  ('${ADMIN}', 'smi6651-admin@example.test'),
  ('${MEMBER2}', 'smi6651-member2@example.test');
INSERT INTO profiles (id, email) VALUES
  ('${MEMBER}', 'smi6651-member@example.test'),
  ('${ADMIN}', 'smi6651-admin@example.test'),
  ('${MEMBER2}', 'smi6651-member2@example.test');

INSERT INTO subscriptions (id, user_id, tier, status) VALUES
  ('smi6651-sub-ent', '${MEMBER}', 'enterprise', 'active'),
  ('smi6651-sub-lapsed', '${MEMBER}', 'enterprise', 'canceled'),
${entSubs};

INSERT INTO teams (id, name, owner_id, subscription_id) VALUES
  ('${TEAM_ENT}', 'Entitled Team', '${MEMBER}', 'smi6651-sub-ent'),
  ('${TEAM_LAPSED}', 'Lapsed Team', '${MEMBER}', 'smi6651-sub-lapsed'),
  ('${TEAM_OTHER}', 'Other Team', '${ADMIN}', NULL),
${entTeams};

-- E4: teams.subscription_id points at a subscriptions row that does not exist. Real prod DDL
-- (011_users_subscriptions.sql) makes this unreachable in steady state (ON DELETE SET NULL nulls
-- it out when the subscription is deleted) -- reached here only via a deliberate, temporary FK
-- bypass, modelling e.g. a delete that raced ahead of the FK action or a pre-FK data import.
SET session_replication_role = replica;
INSERT INTO teams (id, name, owner_id, subscription_id)
  VALUES ('${TEAM_DANGLING}', 'Dangling Sub Team', '${MEMBER}', 'smi6651-sub-does-not-exist');
SET session_replication_role = origin;

INSERT INTO team_members (team_id, user_id, role) VALUES
  ('${TEAM_ENT}', '${MEMBER}', 'member'),
  ('${TEAM_LAPSED}', '${MEMBER}', 'member'),
  ('${TEAM_DANGLING}', '${MEMBER}', 'member'),
  ('${TEAM_ENT}', '${ADMIN}', 'admin'),
  ('${TEAM_OTHER}', '${ADMIN}', 'owner'),
  ('${TEAM_ENT}', '${MEMBER2}', 'member'),
  ('${TEAM_LAPSED}', '${MEMBER2}', 'member'),
${entMembers};

INSERT INTO private_registry_skills
  (team_id, skill_id, version, description, content, content_hash, deprecated,
   published_by, published_at, approval_status)
VALUES
  ('${TEAM_ENT}', 'smi6651/happy', '1.0.0', 'happy path v1',
   '{"SKILL.md":"${BODY_V1}"}'::jsonb, 'smi6651-hash-v1', false,
   '${MEMBER}', now() - interval '2 days', 'approved'),
  ('${TEAM_ENT}', 'smi6651/happy', '2.0.0', 'happy path v2',
   '{"SKILL.md":"${BODY_V2}","scripts/foo.sh":"echo hi"}'::jsonb, 'smi6651-hash-v2', false,
   '${MEMBER}', now() - interval '1 day', 'approved'),
  ('${TEAM_LAPSED}', 'smi6651/lapsed-skill', '1.0.0', 'in a lapsed team',
   '{"SKILL.md":"lapsed body"}'::jsonb, 'smi6651-hash-lapsed', false,
   '${MEMBER}', now(), 'approved'),
  ('${TEAM_ENT}', 'smi6651/pending-skill', '1.0.0', 'still pending',
   '{"SKILL.md":"pending body"}'::jsonb, 'smi6651-hash-pending', false,
   '${MEMBER}', now(), 'pending'),
  ('${TEAM_ENT}', 'smi6651/deprecated-skill', '1.0.0', 'deprecated',
   '{"SKILL.md":"deprecated body"}'::jsonb, 'smi6651-hash-deprecated', true,
   '${MEMBER}', now(), 'approved'),
  ('${TEAM_OTHER}', 'smi6651/other-team-skill', '1.0.0', 'belongs to another team',
   '{"SKILL.md":"other team body"}'::jsonb, 'smi6651-hash-other', false,
   '${ADMIN}', now(), 'approved'),
  ('${TEAM_DANGLING}', 'smi6651/dangling-skill', '1.0.0', 'dangling subscription',
   '{"SKILL.md":"dangling body"}'::jsonb, 'smi6651-hash-dangling', false,
   '${MEMBER}', now(), 'approved'),
  -- V1: 2.0.0 published BEFORE 1.5.0 (out-of-order publish) — omitted version must pick 1.5.0
  -- (most recently PUBLISHED), not 2.0.0 (the higher semver).
  ('${TEAM_ENT}', 'smi6651/versioned', '2.0.0', 'higher semver, published first',
   '{"SKILL.md":"versioned v2.0.0"}'::jsonb, 'smi6651-hash-versioned-2', false,
   '${MEMBER}', now() - interval '2 days', 'approved'),
  ('${TEAM_ENT}', 'smi6651/versioned', '1.5.0', 'lower semver, published last',
   '{"SKILL.md":"versioned v1.5.0"}'::jsonb, 'smi6651-hash-versioned-1', false,
   '${MEMBER}', now() - interval '1 day', 'approved'),
  -- V2/V3: latest-published is deprecated — omitted must fall back to 1.0.0, a pin on 2.0.0 404s.
  ('${TEAM_ENT}', 'smi6651/fallback', '1.0.0', 'non-deprecated, published first',
   '{"SKILL.md":"${BODY_FALLBACK_V1}"}'::jsonb, 'smi6651-hash-fallback-1', false,
   '${MEMBER}', now() - interval '2 days', 'approved'),
  ('${TEAM_ENT}', 'smi6651/fallback', '2.0.0', 'deprecated, published last',
   '{"SKILL.md":"fallback v2.0.0"}'::jsonb, 'smi6651-hash-fallback-2', true,
   '${MEMBER}', now() - interval '1 day', 'approved'),
  -- Finding 1 (GPT-5.6-Sol review): a stored row whose content is a JSON object but carries a
  -- non-string value under a non-SKILL.md key. enforce_private_registry_content_hash()
  -- (20260729000000) validates the object shape and content->>'SKILL.md' specifically, but never
  -- checks any OTHER key's value, so this shape is reachable in real data despite that trigger --
  -- this fixture is not routed through that trigger at all here (the stub schema never installs
  -- it), which is exactly why the RPC's own read-side guard must not assume the write side caught it.
  ('${TEAM_ENT}', 'smi6651/malformed-skill', '1.0.0', 'object content with a non-string value',
   '{"SKILL.md":"ok","x":123}'::jsonb, 'smi6651-hash-malformed', false,
   '${MEMBER}', now(), 'approved'),
${entSkills};
`
}

// ============================================================================
// Query helpers over PsqlSession's `-A -t` (unaligned, tuples-only) output.
// ============================================================================

/** Split `-A -t` stdout into rows of pipe-delimited fields. Empty trailing lines dropped. */
export function rows(stdout: string): string[][] {
  return stdout
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .map((l) => l.split('|'))
}

/** First column of the first row, or null if there were no rows (NULL and 0-rows both render
 *  as nothing under `-A -t`, so callers that need to distinguish them should query a row count
 *  separately). */
export function scalar(stdout: string): string | null {
  const r = rows(stdout)
  return r.length > 0 ? r[0][0] : null
}
