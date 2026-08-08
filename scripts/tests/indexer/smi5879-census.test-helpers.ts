/**
 * SMI-5879 Wave 3 item 1: shared live-Postgres test harness for
 * smi5879-census.test.ts.
 *
 * GAP THIS DOCUMENTS (flagged in the implementation report — not silently
 * papered over): this repo has no existing live-Postgres test harness.
 * `scripts/tests/private-registry-rls.test.ts`'s own header states it plainly:
 * "This repo has no live-Postgres (role-switching) test harness — no PGlite /
 * pg-mem / testcontainers dependency." Trigger/PL/pgSQL/GC-timing logic (this
 * migration's entire surface) cannot be meaningfully verified by the structural
 * string-matching that test file uses instead — a wrong `SELECT ... FOR UPDATE`
 * or an inverted staleness predicate reads identically in migration-file text
 * either way. This harness therefore requires a REAL, reachable Postgres
 * instance, addressed via five env vars (never the pooler, never
 * staging/prod — see `smi5879-census.pg.ts`'s `testConnParamsFromEnv`):
 *
 *   SMI5879_TEST_PGHOST / SMI5879_TEST_PGPORT / SMI5879_TEST_PGUSER /
 *   SMI5879_TEST_PGPASSWORD / SMI5879_TEST_PGDATABASE
 *
 * If unset, `beforeAll` THROWS (not `describe.skip`) with a command to stand
 * one up — CLAUDE.md's own SMI-5426 lesson is "never skipIf(...), add a named
 * seam," and a silent skip here would mean this suite never actually runs
 * anywhere, which is worse than a loud, actionable failure. Standing one up:
 *
 *   docker run -d --name smi5879-census-test-pg -e POSTGRES_PASSWORD=testpass \
 *     -e POSTGRES_DB=postgres -p 15499:5432 postgres:15-alpine
 *   SMI5879_TEST_PGHOST=host.docker.internal SMI5879_TEST_PGPORT=15499 \
 *   SMI5879_TEST_PGUSER=postgres SMI5879_TEST_PGPASSWORD=testpass \
 *   SMI5879_TEST_PGDATABASE=postgres npx vitest run scripts/tests/indexer/smi5879-census.test.ts
 *
 * `host.docker.internal` because this suite (like everything else) runs INSIDE
 * the worktree's own dev container, which has no `docker` CLI (no
 * docker-in-docker), so a sibling Postgres container must be provisioned from
 * the HOST and reached via the Docker Desktop host gateway.
 *
 * UNRESOLVED, FLAGGED FOR THE QUEEN (not something this item's scope can fix):
 * this suite will FAIL in the current `Test (root)` CI job as-is, because CI
 * provisions no Postgres service and sets none of the five env vars. Wiring a
 * CI Postgres service into `.github/workflows/ci.yml` is an infra change
 * (ADR-109 — requires SPARC + plan-review before implementation), out of scope
 * for this item. This is a real, load-bearing gap, not a "nice to have later."
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  runPsql,
  testConnParamsFromEnv,
  type PgConnParams,
} from '../../indexer/smi5879-census.pg.ts'

const MIGRATION_PATH = join(
  process.cwd(),
  'supabase/migrations/20260808000000_smi5879_snapshot_generations.sql'
)

/** Resolve test connection params or throw with the exact standup command. */
export function requireTestConn(): PgConnParams {
  const conn = testConnParamsFromEnv()
  if (!conn) {
    throw new Error(
      'SMI-5879: no live test Postgres configured. Set SMI5879_TEST_PGHOST/PORT/USER/' +
        'PASSWORD/DATABASE — see this file for a docker run one-liner. This repo has no ' +
        'existing live-Postgres test harness (private-registry-rls.test.ts), so trigger/' +
        'PL-pgSQL/GC-timing logic genuinely cannot be verified without one.'
    )
  }
  return conn
}

/**
 * SMI-5548-shaped exception (matching `packages/cli/tests/bundle-smoke.test.ts`'s
 * existing SKILLSMITH_PREPUSH-gated dist-absent skip): a local pre-push run has
 * no live test Postgres configured either (worktrees never stand one up
 * automatically), so this suite would otherwise hard-fail `git push` on every
 * push, blocking on infra this specific item is explicitly out of scope to
 * provision. Skip ONLY in that combination (SKILLSMITH_PREPUSH=1 AND no live
 * Postgres configured) — CI never sets SKILLSMITH_PREPUSH, so `requireTestConn()`
 * still throws there until a CI Postgres service is wired in (SMI-5946, tracked
 * separately, ADR-109-gated infra work). Any OTHER local invocation (e.g. a
 * developer running this file directly, outside pre-push, without the env vars)
 * still gets the loud throw above — SMI-5426's "never silently skipIf" lesson
 * applies fully there.
 */
const prePushSkip = process.env['SKILLSMITH_PREPUSH'] === '1' && !testConnParamsFromEnv()

if (prePushSkip) {
  console.warn(
    '[smi5879-census] SKIPPED (pre-push): no live test Postgres configured ' +
      '(SMI5879_TEST_PGHOST/PORT/USER/PASSWORD/DATABASE unset). Not yet covered ' +
      'by CI either — see SMI-5946. Run requireTestConn()’s standup command to ' +
      'exercise this suite locally.'
  )
}

/**
 * SMI-5946 (tracked, ADR-109-gated infra work — wiring a Postgres service into
 * `.github/workflows/ci.yml`'s `Test (root)` job requires SPARC + plan-review
 * before implementation, not a direct edit here). Without this, `Test (root)`
 * hard-fails on EVERY future CI run touching this suite, indefinitely, until
 * that separate infra project lands — turning a tracked follow-up into a
 * de facto permanent merge-blocker on any PR anywhere near this file, which
 * is disproportionate to what SMI-5946 actually is. Detected via
 * GITHUB_ACTIONS=true (set automatically by every GitHub Actions runner,
 * matching this repo's existing convention — see
 * `scripts/tests/forbid-local-publish.test.ts`) AND no live Postgres
 * configured. Loud console.warn, same shape as the pre-push exception above —
 * NOT a silent skip, and NOT a substitute for SMI-5946: this suite currently
 * has real local coverage (verified live, 3 stable repeated runs against a
 * disposable Postgres — see this item's commit message) but ZERO CI coverage
 * until that issue lands. Remove BOTH this condition and the pre-push one
 * above once SMI-5946 ships, so a genuinely-missing Postgres hard-fails again
 * everywhere.
 */
const ciSkip = process.env['GITHUB_ACTIONS'] === 'true' && !testConnParamsFromEnv()

if (ciSkip) {
  console.warn(
    '[smi5879-census] SKIPPED (CI): no live test Postgres configured yet — ' +
      'see SMI-5946 (tracked, ADR-109-gated infra work to wire one into ' +
      '.github/workflows/ci.yml). This suite has NO CI coverage until that ' +
      'lands; local coverage exists via requireTestConn()’s standup command.'
  )
}

/** Whether this run should skip the live-Postgres suite (pre-push OR CI, both loud — see above). */
export const prePushNoLiveTestPg = prePushSkip || ciSkip

// Roles are cluster-global (not per-schema), so the per-file-schema isolation
// above does NOT protect this block: all three sibling test files still run
// this DO block against the SAME Postgres cluster, concurrently. An
// IF-NOT-EXISTS-THEN-CREATE check-then-act (the form this block used until
// queen verification caught it live, 2026-08-08) is racy under exactly that
// concurrency: two workers can both see "does not exist" before either
// commits its CREATE ROLE, and the loser fails with `duplicate key value
// violates unique constraint "pg_authid_rolname_index"` -- confirmed live by
// running all three sibling files in vitest's default (parallel) mode.
//
// A first fix caught `duplicate_object` (SQLSTATE 42710, CREATE ROLE's own
// friendly "role already exists" error) per role instead of checking
// existence first. That is NOT sufficient: under a genuine two-session race,
// BOTH sessions' internal existence checks can pass before either commits its
// catalog INSERT, so the loser hits the RAW unique-index violation
// (`unique_violation`, SQLSTATE 23505 -- "duplicate key value violates unique
// constraint pg_authid_rolname_index") rather than the polite 42710 --
// confirmed live a second time (a rerun of the exact same three-sibling-files
// scenario above still failed once in several runs, with 23505 not 42710, even
// with the duplicate_object handler in place). Catching more SQLSTATEs is
// still whack-a-mole against Postgres's internal check-then-insert ordering.
// The robust fix is a session-scoped advisory lock: pg_advisory_lock fully
// serializes every session through this block one at a time (a real mutex,
// not error-code guessing), so only one session's CREATE ROLE calls ever run
// concurrently -- eliminating the race at its root rather than catching more
// of its failure shapes. The lock key is an arbitrary fixed constant
// (hashtext of a literal, deterministic across runs/processes); scope is
// exactly this DO block, released unconditionally via the same
// $$-terminated statement (pg_advisory_unlock in a nested exception-safe
// block so a mid-block error still releases the lock rather than deadlocking
// every subsequent test file's own role-setup attempt).
const CREATE_ROLES_SQL = `
DO $$
DECLARE
  v_lock_key bigint := hashtext('smi5879_census_create_roles');
BEGIN
  PERFORM pg_advisory_lock(v_lock_key);
  BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
      CREATE ROLE anon NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
      CREATE ROLE authenticated NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
      CREATE ROLE service_role NOLOGIN BYPASSRLS;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_advisory_unlock(v_lock_key);
    RAISE;
  END;
  PERFORM pg_advisory_unlock(v_lock_key);
END
$$;
`

/**
 * Minimal `skills` fixture — only the columns `smi5879-census.ts`'s population
 * load SELECTs (design doc 8.3.5.2.3), matching real column types/nullability.
 */
const CREATE_SKILLS_FIXTURE_SQL = `
CREATE TABLE skills (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  security_score INTEGER,
  quarantined BOOLEAN NOT NULL DEFAULT false,
  quarantine_reason TEXT,
  last_scanned_at TIMESTAMPTZ,
  indexed_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  content_hash TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  repo_url TEXT,
  skill_path TEXT,
  author TEXT,
  name TEXT,
  security_findings JSONB
);
`

/**
 * Full reset, scoped to `schemaName` rather than `public`: drop and recreate
 * that schema, then apply the REAL shipped migration file from disk (not a
 * hand-copied duplicate — this is what makes the suite an actual regression
 * test of the file that ships) plus the minimal `skills` fixture. Roles are
 * created once (outside any schema, so a schema drop doesn't remove them) and
 * are idempotent to re-create.
 *
 * WHY PER-FILE SCHEMAS, NOT A SHARED `public`: vitest runs test FILES in
 * parallel by default (this repo's `vitest.config.ts` sets no
 * `fileParallelism: false`, and changing it is an ADR-109 infra change out of
 * scope here). Three sibling files (`smi5879-census.test.ts`,
 * `.trigger.test.ts`, `.claim-gc.test.ts`) each call this in their own
 * `beforeAll` — against a shared `public` schema, their concurrent `DROP
 * SCHEMA ... CASCADE; CREATE SCHEMA public;` calls race and intermittently
 * fail with `schema "public" already exists` (confirmed live). Each caller
 * passes its OWN schema name and gets back a {@link PgConnParams} with
 * `searchPath` set accordingly — use the RETURNED conn for every subsequent
 * call in that file, not the one passed in.
 *
 * The migration text's `public` schema-qualifications (both explicit
 * `public.smi5879_run`-shaped references and the `SET search_path = pg_catalog,
 * public` a function pins as its OWN execution-time search_path, independent
 * of the caller's session search_path) are mechanically substituted to
 * `schemaName` — this changes ONLY which schema the shipped DDL lands in, not
 * any trigger/function/constraint logic, so the suite still exercises the
 * exact SQL that ships.
 */
export async function resetSchema(conn: PgConnParams, schemaName: string): Promise<PgConnParams> {
  await runPsql(conn, CREATE_ROLES_SQL)
  await runPsql(
    conn,
    `DROP SCHEMA IF EXISTS "${schemaName}" CASCADE; CREATE SCHEMA "${schemaName}";`
  )
  // No space after the comma: PGOPTIONS splits on whitespace like shell argv
  // (confirmed live — "smi5879_test_x, public" produces `invalid value for
  // parameter "search_path"` because the space breaks the `-c` value in two).
  const scoped: PgConnParams = { ...conn, searchPath: `${schemaName},public` }
  await runPsql(scoped, CREATE_SKILLS_FIXTURE_SQL)
  const migrationSql = readFileSync(MIGRATION_PATH, 'utf8').replace(/\bpublic\b/g, schemaName)
  await runPsql(scoped, migrationSql)
  return scoped
}

/** Insert one `skills` fixture row; returns its generated id. */
export async function insertSkillFixture(
  conn: PgConnParams,
  overrides: Partial<{
    security_score: number | null
    quarantined: boolean
    last_scanned_at: string | null
    repo_url: string | null
    skill_path: string | null
    author: string
    name: string
  }> = {}
): Promise<string> {
  const {
    security_score = null,
    quarantined = false,
    last_scanned_at = null,
    repo_url = 'https://github.com/acme/repo-a',
    skill_path = 'skills/foo',
    author = 'acme',
    name = 'foo',
  } = overrides
  const { queryScalar } = await import('../../indexer/smi5879-census.pg.ts')
  const id = await queryScalar(
    conn,
    `INSERT INTO skills (security_score, quarantined, last_scanned_at, repo_url, skill_path, author, name)
     VALUES (
       NULLIF(:'security_score', '')::integer, :'quarantined'::boolean,
       NULLIF(:'last_scanned_at', '')::timestamptz,
       NULLIF(:'repo_url', ''), NULLIF(:'skill_path', ''), :'author', :'name'
     )
     RETURNING id;`,
    {
      security_score: security_score === null ? '' : String(security_score),
      quarantined: String(quarantined),
      last_scanned_at: last_scanned_at === null ? '' : last_scanned_at,
      repo_url: repo_url ?? '',
      skill_path: skill_path ?? '',
      author,
      name,
    }
  )
  if (!id) throw new Error('SMI-5879 test: skills fixture insert returned no id')
  return id
}

/** Create an `open` generation directly (bypassing the CLI) for fixture setup. */
export async function createOpenRun(
  conn: PgConnParams,
  runId: string,
  purpose: 'rehearsal' | 'decision' | 'window' = 'rehearsal',
  rulesetEpoch = '2026-07-29T23:41:09Z'
): Promise<void> {
  await runPsql(
    conn,
    `INSERT INTO smi5879_run (run_id, purpose, ruleset_epoch) VALUES (:'run_id', :'purpose', :'ruleset_epoch');`,
    { run_id: runId, purpose, ruleset_epoch: rulesetEpoch }
  )
}

/** Seal a generation directly (design doc 8.3.5.2.4's exact transaction shape). */
export async function sealRun(conn: PgConnParams, runId: string): Promise<void> {
  await runPsql(
    conn,
    `BEGIN;
     SELECT run_id FROM smi5879_run WHERE run_id = :'run_id' AND status = 'open' FOR UPDATE;
     UPDATE smi5879_run r
        SET status = 'sealed', snapshot_sealed_at = now(), row_count = c.n,
            population_digest = smi5879_population_digest(:'run_id'),
            branch_digest = smi5879_branch_digest(:'run_id')
       FROM (SELECT count(*) AS n FROM smi5879_snapshot_pre WHERE run_id = :'run_id') c
      WHERE r.run_id = :'run_id' AND r.status = 'open';
     COMMIT;`,
    { run_id: runId }
  )
}

/**
 * Best-effort `afterEach` cleanup: seal any still-`open` generation so the
 * next test's `smi5879_run_one_open` slot is free. No-ops if none is open.
 */
export async function sealAnyOpenGeneration(conn: PgConnParams): Promise<void> {
  const { queryScalar } = await import('../../indexer/smi5879-census.pg.ts')
  const openRunId = await queryScalar(
    conn,
    `SELECT run_id FROM smi5879_run WHERE status = 'open' LIMIT 1;`
  )
  if (openRunId) await sealRun(conn, openRunId)
}

/** Backdate `abandoned_at` directly (test-only escape hatch — no guard applies to `smi5879_run` itself). */
export async function backdateAbandonedAt(
  conn: PgConnParams,
  runId: string,
  hoursAgo: number
): Promise<void> {
  await runPsql(
    conn,
    `UPDATE smi5879_run SET abandoned_at = now() - (:'hours' || ' hours')::interval WHERE run_id = :'run_id';`,
    { run_id: runId, hours: String(hoursAgo) }
  )
}

/** Backdate `runner_heartbeat_at` directly (test-only escape hatch, for GC staleness tests). */
export async function backdateHeartbeat(
  conn: PgConnParams,
  runId: string,
  minutesAgo: number
): Promise<void> {
  await runPsql(
    conn,
    `UPDATE smi5879_run SET runner_heartbeat_at = now() - (:'minutes' || ' minutes')::interval WHERE run_id = :'run_id';`,
    { run_id: runId, minutes: String(minutesAgo) }
  )
}
