/**
 * SMI-6362 — live-Postgres harness for `search-metrics-analytics-rls.pg.test.ts`.
 *
 * Connection env plumbing plus the minimal schema the T-COVERAGE / T-RLS-5 / T-RET-1
 * suites build, reusing `./supabase/pg-session.ts`'s `PsqlSession` + `extractLatestFunction`
 * (SMI-6321/SMI-6345 convention). The function bodies and the RLS policy are EXTRACTED
 * VERBATIM from the shipped migrations at run time, never transcribed — so editing a
 * migration changes what these suites execute rather than leaving them passing against a
 * stale copy.
 *
 * Kept apart from `./search-metrics-analytics-rls.helpers.ts` because importing this module
 * warns when no test Postgres is configured, which is noise for the static migration-text
 * suite that never queries one (SMI-6690).
 *
 * @module scripts/tests/search-metrics-analytics-rls.pg-helpers
 */

import {
  extractFunction,
  extractLatestFunction,
  extractStatement,
  type TestConn,
} from './supabase/pg-session.ts'
import {
  PARENT_TABLE_MIGRATION,
  TEAM_HELPERS_MIGRATION,
  type CoverageCase,
} from './search-metrics-analytics-rls.helpers.ts'

// ============================================================================
// Live-Postgres harness (SMI-6321/SMI-6345 five-env-var convention)
// ============================================================================

export type { TestConn }

export function testConnFromEnv(env: NodeJS.ProcessEnv = process.env): TestConn | null {
  const host = env.SMI6362_TEST_PGHOST
  const port = env.SMI6362_TEST_PGPORT
  const user = env.SMI6362_TEST_PGUSER
  const password = env.SMI6362_TEST_PGPASSWORD
  const database = env.SMI6362_TEST_PGDATABASE
  if (!host || !port || !user || !password || !database) return null
  return { host, port, user, password, database }
}

export const noLiveTestPg = !testConnFromEnv()

if (noLiveTestPg) {
  console.warn(
    '[smi6362-analytics-rls] SKIPPED (live-SQL suite): no test Postgres configured ' +
      '(SMI6362_TEST_PGHOST/PORT/USER/PASSWORD/DATABASE unset). The static migration-text ' +
      'assertions in search-metrics-analytics-rls.test.ts are a separate suite and still ' +
      'ran. This suite is the ONLY coverage that executes the shipped ' +
      'analytics_team_reporting_coverage() suppression ladder and the shipped ' +
      'search_metrics_team_scoped_read policy — a mocked test cannot prove either. Not covered ' +
      'by CI (same tracked gap as SMI-5946). Stand one up:\n' +
      '  docker run -d --rm --name smi6362-analytics-test-pg -e POSTGRES_PASSWORD=testpass \\\n' +
      '    -e POSTGRES_DB=postgres -p 15636:5432 postgres:15-alpine\n' +
      '  # Tear down with `docker stop smi6362-analytics-test-pg` (--rm also removes its data volume, SMI-6619)\n' +
      '  SMI6362_TEST_PGHOST=host.docker.internal SMI6362_TEST_PGPORT=15636 \\\n' +
      '  SMI6362_TEST_PGUSER=postgres SMI6362_TEST_PGPASSWORD=testpass \\\n' +
      '  SMI6362_TEST_PGDATABASE=postgres \\\n' +
      '    npx vitest run --config vitest.config.root-tests.ts ' +
      'scripts/tests/search-metrics-analytics-rls.pg.test.ts'
  )
}

export function requireTestConn(): TestConn {
  const conn = testConnFromEnv()
  if (!conn) {
    throw new Error(
      'SMI-6362: no live test Postgres configured. Set SMI6362_TEST_PGHOST/PORT/USER/PASSWORD/' +
        'DATABASE — see this file for a docker run one-liner.'
    )
  }
  return conn
}

/** Deterministic per-(case, member) uuid so a failure names the seat that produced it. */
export function fixtureUserId(caseIdx: number, memberIdx: number): string {
  return `63620000-0000-0000-0000-${String(caseIdx * 100 + memberIdx).padStart(12, '0')}`
}

/**
 * `user_team_ids()`, PINNED to 071 rather than resolved by `extractLatestFunction`.
 *
 * WHY THE PIN (and why it is safe). `extractLatestFunction` picks the lexically-last
 * migration whose text contains `CREATE OR REPLACE FUNCTION <name>` — it does not mask
 * SQL comments when doing so. `074_user_team_ids_consolidation.sql` sorts after 071 and
 * contains that exact phrase inside its documented, NOT-auto-applied rollback block
 * (`-- CREATE OR REPLACE FUNCTION user_team_ids(uid UUID)`), so the resolver returns a
 * commented-out body that is not executable SQL. 074 only DROPs the superseded
 * `user_team_ids(UUID)` overload; the no-args form 071 defines is still the shipped one.
 *
 * The pin is guarded rather than trusted: `migrationsRedefiningUserTeamIds` in
 * `./search-metrics-analytics-rls.helpers.ts` lets a test fail loudly if a migration after
 * 071 ever genuinely redefines the function, so this can never silently drift into
 * exercising a stale body.
 */
export function userTeamIdsSql(): string {
  return extractFunction(TEAM_HELPERS_MIGRATION, 'user_team_ids', 'SMI-6362')
}

/**
 * Minimal schema + the SHIPPED bodies/policy, extracted at run time.
 *
 * Hand-written stand-ins, and why each is unavoidable:
 *  - `auth.uid()` — the real one reads a signed GoTrue JWT claim and cannot be driven from
 *    a psql session at all. The stand-in reads a session GUC so a test can impersonate a
 *    caller; nothing under test depends on *how* the uid arrives, only on the fact that
 *    membership and the RLS predicate both resolve through it.
 *  - the four tables — their real definitions are spread across dozens of interdependent
 *    migrations. Only the columns the functions/policy actually read are modelled.
 * Everything that matters (`user_team_ids()`, `analytics_team_reporting_coverage()`, the
 * `search_metrics_team_scoped_read` policy) is extracted verbatim from the migrations.
 */
export function schemaSql(): string {
  return `
-- Roles first: the shipped RLS policy below declares "TO authenticated" directly in its
-- own CREATE POLICY syntax, which Postgres resolves at CREATE time, not at query time.
-- Creating the role after the policy statement fails the whole schema build on a genuinely
-- fresh database with "role authenticated does not exist" -- caught by re-running this
-- suite against a brand-new container rather than one already warmed up from a prior
-- iteration, where the role would already exist and silently mask the ordering bug.
DO $roles$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END $roles$;

DROP SCHEMA IF EXISTS auth CASCADE;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id UUID PRIMARY KEY, email TEXT);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $au$
  SELECT NULLIF(current_setting('smi6362.uid', true), '')::uuid;
$au$;

DROP TABLE IF EXISTS search_metrics CASCADE;
DROP TABLE IF EXISTS user_telemetry_preferences CASCADE;
DROP TABLE IF EXISTS team_members CASCADE;

CREATE TABLE team_members (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  team_id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  UNIQUE (team_id, user_id)
);
CREATE TABLE user_telemetry_preferences (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  consent_decided_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE search_metrics (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  actor TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

${userTeamIdsSql()}

${extractLatestFunction('public.analytics_team_reporting_coverage', 'SMI-6362')}

-- The SHIPPED parent-table policy, verbatim (T-RLS-5 executes it, never a transcription).
-- Depends on the authenticated role created above.
ALTER TABLE search_metrics ENABLE ROW LEVEL SECURITY;
${extractStatement(PARENT_TABLE_MIGRATION, /CREATE POLICY search_metrics_team_scoped_read/, 'SMI-6362')}

GRANT USAGE ON SCHEMA public, auth TO authenticated;
GRANT SELECT ON search_metrics TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_team_ids() TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
`
}

/** Seed one AC-9 matrix row as its own team, with its own users. Returns the team id. */
export function seedCoverageCaseSql(
  c: CoverageCase,
  caseIdx: number
): { teamId: string; sql: string } {
  const teamId = `smi6362-${c.id.toLowerCase()}`
  const rows: string[] = []
  let m = 0
  const add = (enabled: boolean, decided: boolean): void => {
    const uid = fixtureUserId(caseIdx, m++)
    rows.push(
      `INSERT INTO auth.users (id) VALUES ('${uid}');`,
      `INSERT INTO team_members (team_id, user_id) VALUES ('${teamId}', '${uid}');`,
      `INSERT INTO user_telemetry_preferences (user_id, enabled, consent_decided_at) ` +
        `VALUES ('${uid}', ${enabled}, ${decided ? 'now()' : 'NULL'});`
    )
  }
  for (let i = 0; i < c.reporting; i++) add(true, true) // enabled + decided
  for (let i = 0; i < c.optedOut; i++) add(false, true) // disabled + decided
  for (let i = 0; i < c.undecided; i++) add(false, false) // never decided
  return { teamId, sql: rows.join('\n') }
}

/**
 * Read one coverage row with NULLs made textually unambiguous. `psql -A -t` renders both
 * NULL and the empty string as an empty field, and the whole point of AC-9's additional
 * assertions is NULL-vs-0 — so every column is coalesced to a literal sentinel instead.
 */
export const COVERAGE_NULL_SENTINEL = '<null>'

export function coverageQuery(teamId: string): string {
  const cols = [
    'coverage_level',
    'suppression_reason',
    'total_seats::text',
    'reporting_seats::text',
    'non_reporting_seats::text',
    'opted_out_seats::text',
    'undecided_seats::text',
    'active_actors_in_window::text',
    'suppressed::text',
  ]
    .map((c) => `coalesce(${c}, '${COVERAGE_NULL_SENTINEL}')`)
    .join(', ')
  return `SELECT ${cols} FROM public.analytics_team_reporting_coverage('${teamId}');`
}

export interface CoverageRow {
  coverageLevel: string
  suppressionReason: string
  totalSeats: string
  reportingSeats: string
  nonReportingSeats: string
  optedOutSeats: string
  undecidedSeats: string
  activeActors: string
  suppressed: string
}

export function parseCoverageRow(stdout: string): CoverageRow | null {
  const line = stdout.trim()
  if (line === '') return null // zero rows — the non-member case
  const f = line.split('|')
  return {
    coverageLevel: f[0],
    suppressionReason: f[1],
    totalSeats: f[2],
    reportingSeats: f[3],
    nonReportingSeats: f[4],
    optedOutSeats: f[5],
    undecidedSeats: f[6],
    activeActors: f[7],
    suppressed: f[8],
  }
}
