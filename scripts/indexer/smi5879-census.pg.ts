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
import { delay } from './_shared/rate-limit.ts'

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
 * SMI-6015 Wave 3 incident (2026-08-17): a transient DNS/connection blip
 * (`could not translate host name "..." to address`, an intermittent wifi
 * drop mid-multi-hour census run) hit an UNGUARDED `spawnPsql` call inside
 * `resolveDefaultBranches`'s batched write-back (`writeOutcomesBatch` via
 * `flush()`'s `pendingFlushes`) and crashed the whole process with an
 * uncaught rejection — discarding all in-memory progress since the last
 * successful flush. Unlike the GitHub API call path (`resolveOne`'s own
 * retry/circuit-breaker logic), every `psql`-backed DB call in this module
 * had zero tolerance for a purely transient connection failure.
 *
 * GPT-5.6-Sol review finding (High, pre-merge): the original pattern list
 * also matched `server closed the connection unexpectedly` and the two
 * timeout strings — but those can occur AFTER the server already executed
 * (even committed) a statement, with only the client-side ack lost. A blind
 * retry of a non-idempotent write (e.g. `INSERT INTO smi5879_run`, a
 * branch-resolution batch INSERT) after an ambiguous-execution failure could
 * replay it. Narrowed to ONLY failures that are provably PRE-connection —
 * the connection was never successfully established, so no SQL could
 * possibly have reached the server yet. `could not translate host name`
 * (DNS resolution, this incident's exact message) and `connection refused`
 * (TCP-level rejection) are both pre-connection by construction; the same
 * reasoning applies to the other patterns below. A SQL-level `ERROR:` from
 * `ON_ERROR_STOP=1` (a real constraint violation or syntax error) must still
 * fail immediately — retrying a bad statement can't help and would mask a
 * real bug — so patterns are anchored to psql's own client-side connection
 * error prefix (`psql: error: `), not a bare substring search, so a SQL
 * error message that happens to *contain* one of these words (GPT-5.6-Sol
 * review finding, Medium) cannot be misclassified as transient.
 */
const TRANSIENT_CONNECTION_ERROR_PATTERNS: RegExp[] = [
  /^psql: error: .*could not translate host name/im,
  /^psql: error: .*temporary failure in name resolution/im,
  /^psql: error: .*connection refused/im,
  /^psql: error: .*could not connect to server/im,
  /^psql: error: .*network is unreachable/im,
]

/**
 * True when `stderr` looks like a transient, PRE-connection-establishment
 * failure (safe to retry — no SQL could have reached the server yet), not a
 * real SQL error and not an ambiguous post-execution connection loss (see
 * the pattern list's own doc comment for why those are deliberately
 * excluded).
 */
export function isTransientConnectionError(stderr: string): boolean {
  return TRANSIENT_CONNECTION_ERROR_PATTERNS.some((pattern) => pattern.test(stderr))
}

/** Bounded retry budget for a transient connection failure (initial attempt + this many retries). */
export const TRANSIENT_RETRY_MAX_ATTEMPTS = 3
/** Backoff between retry attempts (ms) — short, since this recovers from a blip, not a rate limit. */
const TRANSIENT_RETRY_BACKOFF_MS = [1000, 2000]

/**
 * Thrown by {@link spawnPsqlOnce} on a non-zero exit. Carries the RAW stderr
 * separately from the formatted `message` (which prefixes it with
 * `SMI-5879: psql exited N: `) so {@link isTransientConnectionError} can
 * classify the actual psql output — anchored to psql's own client-side
 * error-line prefix — without needing to parse it back out of the formatted
 * message text.
 */
class PsqlExitError extends Error {
  readonly rawStderr: string
  constructor(code: number | null, rawStderr: string) {
    super(`SMI-5879: psql exited ${code}: ${rawStderr.trim() || '(no stderr)'}`)
    this.name = 'PsqlExitError'
    this.rawStderr = rawStderr
  }
}

/**
 * SMI-6015 post-merge retro (2026-08-18): the census pipeline spawns tens of
 * thousands of `psql` subprocesses over a multi-hour run (population load,
 * branch resolution, batched writes). Node's `ChildProcess` `'error'` event
 * — distinct from a non-zero exit, {@link PsqlExitError}'s job — fires when
 * `spawn()` itself fails, and at this volume a transient OS-level resource
 * ceiling (`EMFILE`/`ENFILE`: too many open file descriptors; `EAGAIN`:
 * `fork()` temporarily refused; `ENOMEM`: temporary memory pressure) is a
 * realistic failure mode, not just a hypothetical one — nothing here retries
 * it. `ENOENT` (missing binary) and `EACCES` (permission denied) are
 * deliberately excluded: both are permanent misconfiguration, not transient,
 * and retrying either can only delay a failure that will not resolve itself.
 */
const TRANSIENT_SPAWN_ERROR_CODES: ReadonlySet<string> = new Set([
  'EAGAIN',
  'EMFILE',
  'ENFILE',
  'ENOMEM',
])

/**
 * Thrown by {@link spawnPsqlOnce} when `spawn()` itself fails (the process
 * never started at all) — distinct from {@link PsqlExitError}, which is a
 * process that started and exited non-zero. Carries the underlying
 * `NodeJS.ErrnoException.code` (e.g. `EMFILE`) separately from `message` so
 * the retry wrapper can classify it without re-parsing free text.
 */
class PsqlSpawnError extends Error {
  readonly code: string | undefined
  constructor(message: string, code: string | undefined) {
    super(message)
    this.name = 'PsqlSpawnError'
    this.code = code
  }
}

/** True when a {@link PsqlSpawnError}'s code is a transient OS-resource ceiling — see that class's doc comment. */
export function isTransientSpawnErrorCode(code: string | undefined): boolean {
  return code !== undefined && TRANSIENT_SPAWN_ERROR_CODES.has(code)
}

/**
 * Spawn `psql` against `conn`, feed `sql` via stdin, and resolve with
 * stdout/stderr. Rejects (with stderr — which carries any `RAISE EXCEPTION`
 * message the SQL triggered) on a non-zero exit. Credentials go via the child's
 * environment only, never argv, never logged.
 */
function spawnPsqlOnce(conn: PgConnParams, extraArgs: string[], sql: string): Promise<PsqlOutcome> {
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
    child.on('error', (err: NodeJS.ErrnoException) =>
      reject(new PsqlSpawnError(`SMI-5879: failed to spawn psql: ${err.message}`, err.code))
    )
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new PsqlExitError(code, stderr))
        return
      }
      resolve({ stdout, stderr })
    })
    child.stdin.write(sql)
    child.stdin.end()
  })
}

/**
 * Retry wrapper around {@link spawnPsqlOnce}: retries up to
 * {@link TRANSIENT_RETRY_MAX_ATTEMPTS} attempts total, with a short backoff
 * between them, for two distinct transient conditions — a PRE-connection
 * failure (see {@link isTransientConnectionError}) or an OS-level resource
 * ceiling on `spawn()` itself (see {@link isTransientSpawnErrorCode}). Any
 * other failure (a real SQL error, an ambiguous post-execution connection
 * loss, a permanent spawn failure like a missing binary) is NOT retried and
 * rejects on the first attempt, same as before this fix.
 */
async function spawnPsql(
  conn: PgConnParams,
  extraArgs: string[],
  sql: string
): Promise<PsqlOutcome> {
  let lastError: Error | undefined
  for (let attempt = 1; attempt <= TRANSIENT_RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await spawnPsqlOnce(conn, extraArgs, sql)
    } catch (err) {
      const error = err as Error
      const isTransient =
        error instanceof PsqlExitError
          ? isTransientConnectionError(error.rawStderr)
          : error instanceof PsqlSpawnError
            ? isTransientSpawnErrorCode(error.code)
            : false
      if (!isTransient || attempt === TRANSIENT_RETRY_MAX_ATTEMPTS) {
        throw error
      }
      lastError = error
      console.error(
        `[smi5879-census.pg] transient ${error instanceof PsqlSpawnError ? 'spawn' : 'connection'} error ` +
          `(attempt ${attempt}/${TRANSIENT_RETRY_MAX_ATTEMPTS}), retrying: ${error.message}`
      )
      await delay(TRANSIENT_RETRY_BACKOFF_MS[attempt - 1] ?? TRANSIENT_RETRY_BACKOFF_MS.at(-1))
    }
  }
  // Unreachable — the loop above always either returns or throws — but keeps
  // the function's return type honest without a non-null assertion.
  throw lastError ?? new Error('SMI-5879: spawnPsql retry loop exited without a result')
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
