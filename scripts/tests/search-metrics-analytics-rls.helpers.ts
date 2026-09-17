/**
 * SMI-6362 — static migration-text fixtures for `search-metrics-analytics-rls.test.ts`.
 *
 * Split out to keep the test file under the 500-line pre-commit gate (CLAUDE.md § CI Health
 * Requirements), following the `foo.helpers.ts` convention already used by
 * `scripts/tests/docker-entrypoint-tier-b-seed.helpers.ts` and siblings.
 *
 * Scope: a git-crypt-aware loader, plus small and deliberately dumb extractors for a
 * function's header (everything between `CREATE OR REPLACE FUNCTION` and its `AS $tag$`
 * body) and for the REVOKE/GRANT statements naming a given signature. These back
 * T-RLS-1..4/6/7 and T-GRANT-1/2, which assert against the shipped migration text and need
 * no database. The AC-9 coverage matrix lives here too: both suites read it, and it touches
 * no database.
 *
 * The live-Postgres harness is a separate module, `./search-metrics-analytics-rls.pg-helpers.ts`.
 * Keep it that way: it warns at import time about an unconfigured test Postgres, which is
 * noise for the static suite that never queries one (SMI-6690).
 *
 * @module scripts/tests/search-metrics-analytics-rls.helpers
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readMigrationText } from './lib/migration-text-guards.ts'

// ============================================================================
// Migration files under assertion
// ============================================================================

const MIGRATIONS_DIR = 'supabase/migrations'

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
// git-crypt-aware loading
// ============================================================================

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

/**
 * The three-way SMI-5984 lock contract comes from `readMigrationText`, never a local
 * NUL-byte test: an undeclared lock must throw rather than read as a clean scan over
 * unreadable files. A genuinely missing file still throws ENOENT from there and is NOT
 * treated as locked.
 */
function loadOne(file: string, dir: string): MigrationText | 'locked' {
  const raw = readMigrationText(file, dir)
  if (raw === null) return 'locked'
  return { path: join(dir, file), raw, flat: raw.replace(/\s+/g, ' ') }
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

/**
 * Migrations that redefine `user_team_ids` in EXECUTABLE SQL (comment lines excluded).
 * Proves the pin in `./search-metrics-analytics-rls.pg-helpers.ts`'s `userTeamIdsSql()` is
 * still the shipped definition — see that function's own comment for why 071 is pinned.
 */
export function migrationsRedefiningUserTeamIds(dir: string = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => {
      // Must go through the SMI-5984 primitive, never a bare NUL-byte test: it throws on an
      // UNDECLARED lock instead of reporting a clean scan over unreadable files (SMI-6690 F6).
      const body = readMigrationText(f, dir)
      if (body === null) return false
      return body
        .split('\n')
        .some(
          (l) =>
            !l.trimStart().startsWith('--') &&
            l.includes('CREATE OR REPLACE FUNCTION user_team_ids')
        )
    })
}

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
