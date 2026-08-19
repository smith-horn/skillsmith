/**
 * SMI-5898 Wave 2 Step 1: shared setup/fixture harness for
 * `repo-url-canonical-trigger.test.ts`, split out to keep the test file
 * itself under the 500-line gate (`scripts/check-file-length.mjs`).
 *
 * Reuses `scripts/indexer/smi5879-census.pg.ts` — the same
 * shell-out-to-`psql` harness `skill-name-change-trigger.test-helpers.ts`
 * uses for `trg_rekey_skill_name_dependents` — this repo's one existing
 * convention for "run raw multi-statement SQL against Postgres."
 *
 * Connection: reuses the SMI-5879 suite's own env var names (both suites
 * can point at the SAME ephemeral Postgres instance safely — each test file
 * works in its own schema, see resetSchema() below):
 *   SMI5879_TEST_PGHOST / SMI5879_TEST_PGPORT / SMI5879_TEST_PGUSER /
 *   SMI5879_TEST_PGPASSWORD / SMI5879_TEST_PGDATABASE
 *
 *   docker run -d --name smi5879-census-test-pg -e POSTGRES_PASSWORD=testpass \
 *     -e POSTGRES_DB=postgres -p 15499:5432 postgres:15-alpine
 *   SMI5879_TEST_PGHOST=host.docker.internal SMI5879_TEST_PGPORT=15499 \
 *   SMI5879_TEST_PGUSER=postgres SMI5879_TEST_PGPASSWORD=testpass \
 *   SMI5879_TEST_PGDATABASE=postgres npx vitest run scripts/tests/indexer/repo-url-canonical-trigger.test.ts
 *
 * `host.docker.internal` because this suite runs INSIDE the worktree's own
 * dev container — a sibling Postgres container must be reached via the
 * Docker Desktop host gateway.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  runPsql,
  queryRows,
  queryScalar,
  nullable,
  testConnParamsFromEnv,
  type PgConnParams,
} from '../../indexer/smi5879-census.pg.ts'

const MIGRATION_PATH = join(
  process.cwd(),
  'supabase/migrations/20260819000000_smi5898_repo_url_canonical.sql'
)

export const prePushNoLiveTestPg = !testConnParamsFromEnv()

/**
 * Minimal `skills` fixture — only `id` + the two columns the trigger under
 * test reads/writes, not a verbatim copy of the shipped table (which carries
 * many NOT NULL columns unrelated to this trigger's own logic).
 */
const CREATE_FIXTURES_SQL = `
CREATE TABLE skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_url TEXT
);
`

/**
 * Full reset, scoped to `schemaName` rather than `public` — vitest's default
 * file-level parallelism means a shared `public` schema would race against
 * sibling test files' own `DROP SCHEMA ... CASCADE` calls (same rationale as
 * `skill-name-change-trigger.test-helpers.ts:resetSchema`). Applies the REAL
 * shipped migration file from disk, not a hand-copied duplicate.
 *
 * Unlike the SMI-5930 rekey trigger, this migration's function is plain
 * SECURITY INVOKER (no `SET search_path` to substitute) — it only reads/
 * writes NEW, never queries another table — so no schema-name substitution
 * is needed for the migration text itself.
 */
export async function resetSchema(conn: PgConnParams, schemaName: string): Promise<PgConnParams> {
  await runPsql(
    conn,
    `DROP SCHEMA IF EXISTS "${schemaName}" CASCADE; CREATE SCHEMA "${schemaName}";`
  )
  const scoped: PgConnParams = { ...conn, searchPath: `${schemaName},public` }
  await runPsql(scoped, CREATE_FIXTURES_SQL)
  const migrationSql = readFileSync(MIGRATION_PATH, 'utf8')
  await runPsql(scoped, migrationSql)
  return scoped
}

/**
 * `-v key=value` psql substitution has no direct way to represent SQL NULL
 * (it always quotes as a string literal via `:'key'`) — so a null `repoUrl`
 * uses a literal `NULL` in the SQL text instead of a bound variable, rather
 * than trying to shoehorn it through {@link queryRows}'s string-keyed `vars`.
 */
function repoUrlValueExpr(repoUrl: string | null): { expr: string; vars: Record<string, string> } {
  return repoUrl === null
    ? { expr: 'NULL', vars: {} }
    : { expr: ":'repo_url'", vars: { repo_url: repoUrl } }
}

/** Insert a `skills` fixture row via INSERT (fires the BEFORE INSERT trigger); returns id + canonical. */
export async function insertSkill(
  conn: PgConnParams,
  repoUrl: string | null
): Promise<{ id: string; canonical: string | null }> {
  const { expr, vars } = repoUrlValueExpr(repoUrl)
  const rows = await queryRows(
    conn,
    `INSERT INTO skills (repo_url) VALUES (${expr}) RETURNING id::text, repo_url_canonical;`,
    vars
  )
  if (rows.length === 0) throw new Error('SMI-5898 test: skills fixture insert returned no row')
  return { id: rows[0][0], canonical: nullable(rows[0][1]) }
}

/** UPDATE an existing row's repo_url (fires the BEFORE UPDATE trigger); returns the new canonical. */
export async function updateSkillRepoUrl(
  conn: PgConnParams,
  id: string,
  repoUrl: string | null
): Promise<string | null> {
  const { expr, vars } = repoUrlValueExpr(repoUrl)
  const value = await queryScalar(
    conn,
    `UPDATE skills SET repo_url = ${expr} WHERE id = :'id'::uuid RETURNING repo_url_canonical;`,
    { ...vars, id }
  )
  return value
}

export type { PgConnParams }
