/**
 * SMI-6362 — shared fixtures/parsers for `search-metrics-analytics-rls.test.ts`.
 *
 * Split out purely to keep the test file under the 500-line CI gate (CLAUDE.md § CI Health
 * Requirements), following the `foo.helpers.ts` convention already used by
 * `scripts/tests/docker-entrypoint-tier-b-seed.helpers.ts` and siblings.
 *
 * Two unrelated halves live here:
 *
 *  1. STATIC migration parsing — a git-crypt-aware loader plus small, deliberately dumb
 *     extractors for a function's header (everything between `CREATE OR REPLACE FUNCTION`
 *     and its `AS $tag$` body) and for the REVOKE/GRANT statements naming a given
 *     signature. These back T-RLS-1..4/6/7 and T-GRANT-1/2, which assert against the
 *     shipped migration text and need no database.
 *
 *  2. LIVE-POSTGRES fixtures — connection env plumbing and the minimal schema the
 *     T-COVERAGE / T-RLS-5 / T-RET-1 suites build, reusing `./supabase/pg-session.ts`'s
 *     `PsqlSession` + `extractLatestFunction` (SMI-6321/SMI-6345 convention). The
 *     function bodies and the RLS policy are EXTRACTED VERBATIM from the shipped
 *     migrations at run time, never transcribed — so editing a migration changes what
 *     these suites execute rather than leaving them passing against a stale copy.
 *
 * @module scripts/tests/search-metrics-analytics-rls.helpers
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  extractFunction,
  extractLatestFunction,
  extractStatement,
  type TestConn,
} from './supabase/pg-session.ts'

// ============================================================================
// Migration files under assertion
// ============================================================================

export const MIGRATIONS_DIR = 'supabase/migrations'

/** SMI-6362 Wave 1 File A — the five analytics RPCs, resolve_telemetry_identity, grants. */
export const WIRING_MIGRATION = '20260905060000_cloud_usage_analytics_wiring.sql'
/** SMI-4968 — creates search_metrics and the PARENT search_metrics_team_scoped_read policy. */
export const PARENT_TABLE_MIGRATION = '20260519000003_search_metrics_partitioned_table.sql'
/** SMI-5202 — per-partition RLS + policy, and the cleanup_search_metrics() that keeps making them. */
export const PARTITION_RLS_MIGRATION = '20260526000001_search_metrics_partition_rls.sql'
/** SMI-4968 — the original cleanup_search_metrics() with the v_part_end <= v_cutoff boundary. */
export const RETENTION_MIGRATION = '20260519000004_search_metrics_retention_cron.sql'
/** 071 — user_team_ids(), the SECURITY DEFINER helper the RLS policy resolves teams through. */
export const TEAM_HELPERS_MIGRATION = '071_team_workspaces.sql'

// ============================================================================
// git-crypt-aware loading (same contract as scripts/tests/private-registry-rls.test.ts)
// ============================================================================

// "\x00GITCRYPT" — the 9-byte magic header git-crypt writes ahead of ciphertext.
const GIT_CRYPT_MAGIC = Buffer.from([0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54])

/** Set only by post-merge-verify.yml, the one workflow expected to run locked (SMI-5984). */
export const EXPECT_LOCKED_ENV_VAR = 'SKILLSMITH_GIT_CRYPT_EXPECTED_LOCKED'

export interface MigrationText {
  path: string
  /** Verbatim file contents. */
  raw: string
  /** `raw` with every whitespace run collapsed to one space — for substring assertions. */
  flat: string
}

export type LoadedMigrations =
  | { locked: true }
  | {
      locked: false
      wiring: MigrationText
      parentTable: MigrationText
      partitionRls: MigrationText
      retention: MigrationText
    }

function loadOne(file: string, dir: string): MigrationText | 'locked' {
  const path = join(dir, file)
  const buf = readFileSync(path) // throws on a genuinely missing file — NOT treated as locked
  if (buf.subarray(0, GIT_CRYPT_MAGIC.length).equals(GIT_CRYPT_MAGIC)) {
    if (process.env[EXPECT_LOCKED_ENV_VAR] !== '1') {
      throw new Error(
        `${path} appears git-crypt-locked, but ${EXPECT_LOCKED_ENV_VAR} isn't set — this ` +
          'checkout is not expected to be locked here. If this is post-merge-verify.yml, set ' +
          `${EXPECT_LOCKED_ENV_VAR}=1 on the job. Otherwise git-crypt likely failed to unlock ` +
          '(SMI-5702/SMI-5861 filter fragility) — treat as a real failure, not a lock edge case.'
      )
    }
    return 'locked'
  }
  const raw = buf.toString('utf8')
  return { path, raw, flat: raw.replace(/\s+/g, ' ') }
}

/**
 * Load every migration this suite asserts against. All four live under the same
 * `supabase/migrations/**` git-crypt scope, so they lock and unlock together; one locked
 * file means the whole content half of this suite has to stand down (existence-only), as
 * `private-registry-rls.test.ts` does.
 */
export function loadMigrations(dir: string = MIGRATIONS_DIR): LoadedMigrations {
  const wiring = loadOne(WIRING_MIGRATION, dir)
  const parentTable = loadOne(PARENT_TABLE_MIGRATION, dir)
  const partitionRls = loadOne(PARTITION_RLS_MIGRATION, dir)
  const retention = loadOne(RETENTION_MIGRATION, dir)
  if (
    wiring === 'locked' ||
    parentTable === 'locked' ||
    partitionRls === 'locked' ||
    retention === 'locked'
  ) {
    return { locked: true }
  }
  return { locked: false, wiring, parentTable, partitionRls, retention }
}

// ============================================================================
// Static SQL extractors
// ============================================================================

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Return the whitespace-collapsed HEADER of a function definition: everything from
 * `CREATE OR REPLACE FUNCTION <qualifiedName>(` up to (not including) the `AS $tag$` that
 * opens the body. That is exactly the region carrying `SECURITY INVOKER`/`SECURITY
 * DEFINER` and `SET search_path`, and excluding the body keeps a comment inside the body
 * that merely *mentions* "SECURITY DEFINER" from satisfying a header assertion — the
 * wiring migration's bodies contain several such comments.
 */
export function functionHeader(raw: string, qualifiedName: string): string {
  const start = new RegExp(`CREATE OR REPLACE FUNCTION\\s+${escapeRe(qualifiedName)}\\s*\\(`).exec(
    raw
  )
  if (!start) throw new Error(`No CREATE OR REPLACE FUNCTION ${qualifiedName}(...) found`)
  const after = raw.slice(start.index)
  const asIdx = after.search(/\bAS\s+\$[A-Za-z0-9_]*\$/)
  if (asIdx === -1) throw new Error(`Could not find the body delimiter for ${qualifiedName}`)
  return after.slice(0, asIdx).replace(/\s+/g, ' ').trim()
}

export interface GrantFacts {
  /** Roles named in `REVOKE ... ON FUNCTION <sig> FROM <roles>` (lowercased). */
  revokedFrom: string[]
  /** Roles named in `GRANT EXECUTE ON FUNCTION <sig> TO <roles>` (lowercased). */
  grantedTo: string[]
}

/** Collect every REVOKE/GRANT in `raw` naming the exact function signature `sig`. */
export function grantFactsFor(raw: string, sig: string): GrantFacts {
  const flat = raw.replace(/\s+/g, ' ')
  const collect = (verb: 'REVOKE' | 'GRANT', prep: 'FROM' | 'TO'): string[] => {
    const re = new RegExp(
      `${verb}\\s+(?:ALL|EXECUTE)\\s+ON\\s+FUNCTION\\s+${escapeRe(sig)}\\s+${prep}\\s+([^;]+);`,
      'gi'
    )
    const roles: string[] = []
    for (const m of flat.matchAll(re)) {
      for (const r of m[1].split(',')) roles.push(r.trim().toLowerCase())
    }
    return roles
  }
  return { revokedFrom: collect('REVOKE', 'FROM'), grantedTo: collect('GRANT', 'TO') }
}

/** The five analytics RPCs, with the security mode each is REQUIRED to keep (D-2c). */
export const ANALYTICS_RPCS: ReadonlyArray<{
  name: string
  sig: string
  security: 'INVOKER' | 'DEFINER'
}> = [
  // [unqualified name, argument list, required security mode]. The four skill/tool RPCs
  // MUST stay INVOKER so search_metrics_team_scoped_read remains the authorization
  // boundary rather than p_team_id (D-2c). analytics_team_reporting_coverage is one of
  // the two legitimately-DEFINER functions: membership comes from auth.uid(), never from
  // p_team_id, and it returns aggregate counts only (D-2e).
  ['analytics_skill_top', 'TEXT, INT', 'INVOKER'],
  ['analytics_skill_stale', 'TEXT, INT, INT', 'INVOKER'],
  ['analytics_skill_cooccurrence', 'TEXT, INT', 'INVOKER'],
  ['analytics_tool_usage', 'TEXT, INT', 'INVOKER'],
  ['analytics_team_reporting_coverage', 'TEXT', 'DEFINER'],
].map(([fn, args, security]) => ({
  name: `public.${fn}`,
  sig: `public.${fn}(${args})`,
  security: security as 'INVOKER' | 'DEFINER',
}))

/** D-2f: the other legitimately-DEFINER function, and the only service_role-only one. */
export const RESOLVE_IDENTITY_SIG = 'public.resolve_telemetry_identity(UUID, TEXT)'

/** The exact USING predicate `search_metrics_team_scoped_read` must keep (D-2b consequence 1). */
export const POLICY_PREDICATE_PARENT =
  "USING ( actor = auth.uid()::TEXT OR metadata->>'team_id' IN (SELECT public.user_team_ids()) )"

// ============================================================================
// AC-9 coverage matrix (plan § Acceptance criteria, AC-9 — all 11 rows)
// ============================================================================

export interface CoverageCase {
  id: string
  totalSeats: number
  reporting: number
  optedOut: number
  undecided: number
  expectedLevel: 'full' | 'aggregate' | 'qualitative'
  /** NULL only at `full`; every suppressed level carries a diagnostic reason. */
  expectedReason: string | null
}

export const K_ANONYMITY_FLOOR = 5

// AC-9's grid verbatim, as [totalSeats, reporting, optedOut, undecided, level]. The
// expected suppression_reason is DERIVED from the same ladder the SQL implements rather
// than hand-typed per row, so a row cannot claim a level and a reason that disagree —
// and 'full' is the only level the SQL leaves the reason NULL for.
const AC9_GRID: ReadonlyArray<[number, number, number, number, CoverageCase['expectedLevel']]> = [
  [4, 4, 0, 0, 'qualitative'],
  [4, 3, 1, 0, 'qualitative'],
  [4, 0, 4, 0, 'qualitative'],
  [5, 5, 0, 0, 'qualitative'],
  [5, 4, 1, 0, 'qualitative'],
  [5, 1, 4, 0, 'qualitative'],
  [5, 0, 5, 0, 'qualitative'],
  [6, 5, 1, 0, 'qualitative'],
  [6, 1, 5, 0, 'qualitative'],
  [10, 5, 5, 0, 'full'],
  [10, 5, 1, 4, 'aggregate'],
]

export const AC9_MATRIX: CoverageCase[] = AC9_GRID.map(
  ([totalSeats, reporting, optedOut, undecided, expectedLevel], i) => ({
    id: `T-COVERAGE-${i + 1}`,
    totalSeats,
    reporting,
    optedOut,
    undecided,
    expectedLevel,
    expectedReason:
      expectedLevel === 'full'
        ? null
        : expectedLevel === 'aggregate'
          ? 'split_bucket_too_small'
          : optedOut + undecided < K_ANONYMITY_FLOOR
            ? 'small_sensitive_bucket'
            : 'small_complement',
  })
)

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
    '[smi6362-analytics-rls] SKIPPED (live-SQL half only): no test Postgres configured ' +
      '(SMI6362_TEST_PGHOST/PORT/USER/PASSWORD/DATABASE unset). The static migration-text ' +
      'assertions still ran. The skipped half is the ONLY coverage that executes the shipped ' +
      'analytics_team_reporting_coverage() suppression ladder and the shipped ' +
      'search_metrics_team_scoped_read policy — a mocked test cannot prove either. Not covered ' +
      'by CI (same tracked gap as SMI-5946). Stand one up:\n' +
      '  docker run -d --name smi6362-analytics-test-pg -e POSTGRES_PASSWORD=testpass \\\n' +
      '    -e POSTGRES_DB=postgres -p 15636:5432 postgres:15-alpine\n' +
      '  SMI6362_TEST_PGHOST=host.docker.internal SMI6362_TEST_PGPORT=15636 \\\n' +
      '  SMI6362_TEST_PGUSER=postgres SMI6362_TEST_PGPASSWORD=testpass \\\n' +
      '  SMI6362_TEST_PGDATABASE=postgres \\\n' +
      '    npx vitest run --config vitest.config.root-tests.ts ' +
      'scripts/tests/search-metrics-analytics-rls.test.ts'
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
 * The pin is guarded rather than trusted: {@link migrationsRedefiningUserTeamIds} lets a
 * test fail loudly if a migration after 071 ever genuinely redefines the function, so
 * this can never silently drift into exercising a stale body.
 */
export function userTeamIdsSql(): string {
  return extractFunction(TEAM_HELPERS_MIGRATION, 'user_team_ids', 'SMI-6362')
}

/**
 * Migrations that redefine `user_team_ids` in EXECUTABLE SQL (comment lines excluded).
 * Used to prove {@link userTeamIdsSql}'s pin to 071 is still the shipped definition.
 */
export function migrationsRedefiningUserTeamIds(dir: string = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => {
      const body = readFileSync(join(dir, f), 'utf8')
      if (body.includes('\u0000')) return false // git-crypt ciphertext, not readable SQL
      return body
        .split('\n')
        .some(
          (l) =>
            !l.trimStart().startsWith('--') &&
            l.includes('CREATE OR REPLACE FUNCTION user_team_ids')
        )
    })
}

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
