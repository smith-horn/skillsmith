/**
 * Raw-Postgres session helper for smi5879-census.ts (SMI-5879 Wave 3 item 1)
 * @module scripts/indexer/smi5879-census.pg
 *
 * The design doc (8.3.5.2.3/8.3.5.2.4) requires multi-statement, explicit
 * `BEGIN`/`COMMIT` transactions with `SELECT ... FOR UPDATE` row locks (the
 * population load and the seal). PostgREST — and therefore `@supabase/supabase-js`,
 * every existing DB-access path in this codebase — auto-commits each REST call and
 * has no session-scoped transaction concept, so it categorically cannot express
 * this.
 *
 * JUDGMENT CALL (flagged per task instructions — no existing helper actually
 * covers this): the obvious alternative, the Node `pg` client library, is not an
 * installed dependency anywhere in this repo — `scripts/run-sql.ts` imports it,
 * but `pg`/`@types/pg` appear nowhere in `package.json` or `package-lock.json`, so
 * that file cannot actually run today. Installing a new dependency was also
 * impractical here: a worktree's `node_modules` is bind-mounted **read-only** from
 * the main checkout (`docker-compose.override.yml`, SMI-4689/5560/5626/5650), so
 * `npm install` inside this worktree's container cannot write it.
 *
 * Instead this module shells out to `psql` (already installed in the dev image —
 * confirmed via `which psql` inside this worktree's own container; it is what
 * `scripts/pooler-psql.sh` / `scripts/pooler-psql-session.sh` already wrap for
 * exactly this kind of long-running, transaction-wrapped bulk write per
 * CLAUDE.md). This is closer to the codebase's *actual* existing convention for
 * "run raw multi-statement SQL against Postgres" than a currently-nonfunctional
 * `pg` import would have been, and it needs zero new dependencies. Values are
 * passed via `psql -v name=value` and referenced in SQL text as `:'name'`, which
 * psql quotes as a proper SQL string literal (embedded quotes/backslashes
 * escaped) — verified live against a throwaway Postgres instance before relying
 * on it. This is injection-safe without any manual escaping in this module.
 *
 * `poolerSessionConnParams()` mirrors `pooler-psql-session.sh` (session pooler,
 * port 5432 — the long-running-maintenance pooler per CLAUDE.md, not the
 * transaction pooler) exactly: same host, same `postgres.${SUPABASE_PROJECT_REF}`
 * user, same database. It reads `SUPABASE_PROJECT_REF` / `SUPABASE_DB_PASSWORD`
 * directly rather than shelling out to that script, because the script's own
 * implementation is `docker exec -i skillsmith-dev-1 psql ...` — an unnecessary
 * nested-Docker layer when this module already runs *inside* a container that has
 * `psql` on its own PATH, and it hardcodes `skillsmith-dev-1` (the main checkout's
 * container name), which would silently work but is the wrong-container footgun
 * CLAUDE.md's SMI-5559 entry warns about for exactly this shape of invocation.
 */

import { spawn } from 'node:child_process'

/** Connection parameters for a `psql` subprocess (never logged — passed via env only). */
export interface PgConnParams {
  host: string
  port: number
  user: string
  password: string
  database: string
  /**
   * Optional `search_path` override, applied per-connection via `PGOPTIONS`
   * (never as a `SET` statement prepended to `sql` — that would consume the
   * first slot of a multi-statement transaction script). Production
   * (`poolerSessionConnParams`) never sets this; it exists so
   * `scripts/tests/indexer/smi5879-census.*.test.ts` can each target their OWN
   * schema on the shared ephemeral test Postgres, avoiding a `DROP SCHEMA
   * public CASCADE` race when multiple test files run concurrently (vitest's
   * default file-level parallelism) against the same instance.
   */
  searchPath?: string
}

/**
 * Session-pooler connection parameters (port 5432), matching
 * `scripts/pooler-psql-session.sh` exactly. Used by the production CLI path for
 * the long-running population load. Throws with an actionable message if the
 * required env vars are absent — callers should run under `varlock run --`.
 */
export function poolerSessionConnParams(env: NodeJS.ProcessEnv = process.env): PgConnParams {
  const projectRef = env.SUPABASE_PROJECT_REF
  const password = env.SUPABASE_DB_PASSWORD
  if (!projectRef) {
    throw new Error(
      'SMI-5879: SUPABASE_PROJECT_REF is not set. Run via `varlock run -- npx tsx scripts/indexer/smi5879-census.ts ...`.'
    )
  }
  if (!password) {
    throw new Error(
      'SMI-5879: SUPABASE_DB_PASSWORD is not set. Run via `varlock run -- npx tsx scripts/indexer/smi5879-census.ts ...`.'
    )
  }
  return {
    host: 'aws-1-us-east-1.pooler.supabase.com',
    port: 5432,
    user: `postgres.${projectRef}`,
    password,
    database: 'postgres',
  }
}

/**
 * Test/rehearsal connection parameters for a **local, ephemeral** Postgres
 * instance — never the pooler, never staging/prod. Reads
 * `SMI5879_TEST_PGHOST`/`SMI5879_TEST_PGPORT`/`SMI5879_TEST_PGUSER`/
 * `SMI5879_TEST_PGPASSWORD`/`SMI5879_TEST_PGDATABASE`. See
 * `scripts/tests/indexer/smi5879-census.test.ts`'s header for how to stand one up
 * (this repo has no existing live-Postgres test harness — see that file's header
 * for the gap this documents, flagged in the implementation report).
 */
export function testConnParamsFromEnv(env: NodeJS.ProcessEnv = process.env): PgConnParams | null {
  const host = env.SMI5879_TEST_PGHOST
  const port = env.SMI5879_TEST_PGPORT
  const user = env.SMI5879_TEST_PGUSER
  const password = env.SMI5879_TEST_PGPASSWORD
  const database = env.SMI5879_TEST_PGDATABASE
  if (!host || !port || !user || !password || !database) return null
  const parsedPort = Number(port)
  if (!Number.isFinite(parsedPort)) return null
  return { host, port: parsedPort, user, password, database }
}

/** Field separator for unaligned tuple output (`-A -F`). Never appears in our data. */
const FIELD_SEP = '\x1f'

/** Sentinel psql prints in place of SQL NULL (`-P null=`). Callers use {@link nullable}. */
export const SMI5879_NULL_MARKER = '__SMI5879_NULL__'

/** Convert a raw cell from {@link queryRows} to `string | null`. */
export function nullable(raw: string): string | null {
  return raw === SMI5879_NULL_MARKER ? null : raw
}

export interface PsqlOutcome {
  stdout: string
  stderr: string
}

/**
 * Spawn `psql` against `conn`, feed `sql` via stdin, and resolve with
 * stdout/stderr. Rejects (with stderr — which carries any `RAISE EXCEPTION`
 * message the SQL triggered) on a non-zero exit. Credentials go via the child's
 * environment only, never argv, never logged.
 */
function spawnPsql(conn: PgConnParams, extraArgs: string[], sql: string): Promise<PsqlOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'psql',
      ['--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-X', '-q', ...extraArgs],
      {
        env: {
          ...process.env,
          PGHOST: conn.host,
          PGPORT: String(conn.port),
          PGUSER: conn.user,
          PGPASSWORD: conn.password,
          PGDATABASE: conn.database,
          ...(conn.searchPath ? { PGOPTIONS: `-c search_path=${conn.searchPath}` } : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    child.on('error', (err) => reject(new Error(`SMI-5879: failed to spawn psql: ${err.message}`)))
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`SMI-5879: psql exited ${code}: ${stderr.trim() || '(no stderr)'}`))
        return
      }
      resolve({ stdout, stderr })
    })
    child.stdin.write(sql)
    child.stdin.end()
  })
}

/** Build `-v key=value` argv pairs for psql's `:'key'` quoted-literal substitution. */
function varArgs(vars: Record<string, string>): string[] {
  const out: string[] = []
  for (const [key, value] of Object.entries(vars)) {
    out.push('-v', `${key}=${value}`)
  }
  return out
}

/**
 * Run `sql` (which may reference `-v` variables as `:'name'`) with no structured
 * result parsing — used for multi-statement DDL/transaction scripts (population
 * load, seal) whose output is not consumed programmatically.
 */
export async function runPsql(
  conn: PgConnParams,
  sql: string,
  vars: Record<string, string> = {}
): Promise<PsqlOutcome> {
  return spawnPsql(conn, varArgs(vars), sql)
}

/**
 * Run `sql` and parse the result as rows of raw string cells (unaligned tuples,
 * `\x1f`-separated, SQL NULL rendered as {@link SMI5879_NULL_MARKER}). Only the
 * LAST statement's result set is meaningfully parseable this way if `sql`
 * contains multiple `SELECT`s — callers needing one result set should issue one
 * query per call.
 */
export async function queryRows(
  conn: PgConnParams,
  sql: string,
  vars: Record<string, string> = {}
): Promise<string[][]> {
  const { stdout } = await spawnPsql(
    conn,
    ['-t', '-A', '-F', FIELD_SEP, '-P', `null=${SMI5879_NULL_MARKER}`, ...varArgs(vars)],
    sql
  )
  return stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.split(FIELD_SEP))
}

/** Convenience: run a single-scalar query and return the raw cell (or null). */
export async function queryScalar(
  conn: PgConnParams,
  sql: string,
  vars: Record<string, string> = {}
): Promise<string | null> {
  const rows = await queryRows(conn, sql, vars)
  if (rows.length === 0 || rows[0].length === 0) return null
  return nullable(rows[0][0])
}
