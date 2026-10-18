/**
 * SMI-7142: live-Postgres harness for the backfill autochain resume migration (20261017000000):
 * invoke_backfill_autochain_resume() and the extended stale-marker watcher
 * check_backfill_autochain_markers().
 *
 * CONNECTION (five-var convention): SMI7142_TEST_PGHOST/PORT/USER/PASSWORD/DATABASE. From the
 * worktree's dev container, against a throwaway Postgres reachable as `host.docker.internal`:
 *
 *   ./scripts/worktree-docker.sh exec -- env SMI7142_TEST_PGHOST=host.docker.internal \
 *     SMI7142_TEST_PGPORT=15721 SMI7142_TEST_PGUSER=postgres SMI7142_TEST_PGPASSWORD=testpass \
 *     SMI7142_TEST_PGDATABASE=postgres npx vitest run \
 *     scripts/tests/supabase/backfill-autochain-resume.pg.test.ts
 *
 * REAL vs STUBBED. REAL (read verbatim from the repo at run time): BOTH migrations (20261016000000
 * first, because the new migration's smoke asserts its marker-watch job, then 20261017000000; so the
 * suite also proves each applies and passes its own $smoke$ block), both functions again via
 * `extractLatestFunction` (so a later migration redefining one is the body under test), and the
 * paired rollback. STUBBED: `audit_logs` (the prod column set, id TEXT as in 001_initial_schema), and
 * the Supabase-only schemas `cron`, `vault` and `net` (an http_post that records its arguments and
 * returns a sequence id, plus the `_http_response` table). The `CREATE EXTENSION pg_net` line is the
 * one statement removed from each migration, because the stock image has no pg_net; the removal is
 * asserted.
 *
 * Hosted Supabase grants EXECUTE on every new function AND ALL on every new table to
 * anon/authenticated/service_role by default. Both defaults are emulated, otherwise the migration's
 * REVOKEs would have nothing to revoke and the grant tests could not bite.
 *
 * TIME IS NEVER PASSED IN. Each single-session arm seeds and calls inside ONE transaction, so `now()`
 * is the same instant for the seed and for every call, and every age boundary is exact.
 *
 * Deliberately imports neither the SMI-7121 nor the SMI-7114 helpers: each emits its own skip warning
 * at import time, keyed to a different env namespace.
 *
 * @module scripts/tests/supabase/backfill-autochain-resume.test-helpers
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractLatestFunction, type TestConn, type PsqlSession } from './pg-session.ts'

export { PsqlSession, type TestConn } from './pg-session.ts'

export const PRIOR_MIGRATION = '20261016000000_backfill_autochain_markers.sql'
export const MIGRATION = '20261017000000_backfill_autochain_resume_pg_cron.sql'
export const ROLLBACK = '20261017000000_backfill_autochain_resume_pg_cron_down.sql'
const LABEL = 'SMI-7142'

export const FNS = {
  dispatcher: 'invoke_backfill_autochain_resume',
  watcher: 'check_backfill_autochain_markers',
} as const
export const ALL_FNS = Object.values(FNS)
export const FN_SIGS = [
  'public.invoke_backfill_autochain_resume()',
  'public.check_backfill_autochain_markers()',
]
export const JOB = 'backfill-autochain-resume'
export const JOB_SCHEDULE = '3,23,43 1,4,9,10,15,16,21,22 * * *'
export const WATCH_JOB = 'backfill-autochain-marker-watch'

export const MARKER = 'indexer_backfill_autochain_deferred'
export const ALERT = 'indexer_backfill_autochain_marker_alert'
export const WATCH_ERROR = 'indexer_backfill_autochain_watch_error'
export const DISPATCH = 'indexer_backfill_autochain_resume_dispatch'
export const RESUME_ERROR = 'indexer_backfill_autochain_resume_error'
export const PAT_SECRET = 'backfill_autochain_dispatch_pat'
export const RESUME_KILL = 'SKILLSMITH_BACKFILL_AUTOCHAIN_RESUME_DISABLE'
export const WATCH_KILL = 'SKILLSMITH_BACKFILL_AUTOCHAIN_WATCH_DISABLE'
export const PAT = 'github_pat_TESTONLY_not_a_real_token'
export const SENT = '{"data":{"sent":true}}'
export const RESUME = 'SELECT public.invoke_backfill_autochain_resume();'
export const WATCH = 'SELECT public.check_backfill_autochain_markers();'
export const DISPATCH_URL =
  'https://api.github.com/repos/smith-horn/skillsmith/actions/workflows/indexer-backfill-autochain.yml/dispatches'

// ============================================================================
// Connection env
// ============================================================================

export function testConnFromEnv(env: NodeJS.ProcessEnv = process.env): TestConn | null {
  const host = env.SMI7142_TEST_PGHOST
  const port = env.SMI7142_TEST_PGPORT
  const user = env.SMI7142_TEST_PGUSER
  const password = env.SMI7142_TEST_PGPASSWORD
  const database = env.SMI7142_TEST_PGDATABASE
  if (!host || !port || !user || !password || !database) return null
  return { host, port, user, password, database }
}

export const noLiveTestPg = !testConnFromEnv()

if (noLiveTestPg) {
  console.warn(
    '[smi7142-backfill-autochain-resume] no live test Postgres configured (SMI7142_TEST_PGHOST/' +
      'PORT/USER/PASSWORD/DATABASE unset), so the live-Postgres suite (.pg.test.ts) will SKIP. The ' +
      'skipped suite is the ONLY coverage that executes the shipped dispatcher and watcher bodies; ' +
      'the PG-free assertions live in the sibling .structural.test.ts.'
  )
}

export function requireTestConn(): TestConn {
  const conn = testConnFromEnv()
  if (!conn) throw new Error('SMI-7142: no live test Postgres configured (SMI7142_TEST_PG*).')
  return conn
}

const readFile = (dir: string, file: string): string =>
  readFileSync(join(process.cwd(), dir, file), 'utf8')

/** A migration without its pg_net line; asserts the line existed so the strip cannot be a no-op. */
function withoutPgNet(file: string): string {
  const src = readFile('supabase/migrations', file)
  const stripped = src.replace(/^CREATE EXTENSION IF NOT EXISTS pg_net[^;]*;/m, '-- (pg_net stub)')
  if (stripped === src) throw new Error(`${file} no longer contains the pg_net CREATE EXTENSION`)
  return stripped
}
export const migrationForHarness = (): string => withoutPgNet(MIGRATION)
export const priorMigrationForHarness = (): string => withoutPgNet(PRIOR_MIGRATION)
export const rollbackSql = (): string => readFile('supabase/rollbacks', ROLLBACK)

// ============================================================================
// Schema
// ============================================================================

export function baseSchemaSql(): string {
  return `
RESET ROLE;
SET TIME ZONE 'UTC';
DO $roles$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $roles$;

DROP SCHEMA IF EXISTS cron CASCADE;
DROP SCHEMA IF EXISTS vault CASCADE;
DROP SCHEMA IF EXISTS net CASCADE;
DROP SCHEMA IF EXISTS extensions CASCADE;
DROP TABLE IF EXISTS audit_logs CASCADE;
DO $drop$ DECLARE r RECORD; BEGIN
  FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname IN ('${ALL_FNS.join("', '")}', 'backfill_autochain_marker_transition')
  LOOP EXECUTE 'DROP FUNCTION ' || r.sig || ' CASCADE'; END LOOP;
END $drop$;

-- The prod audit_logs column set; id is TEXT (001_initial_schema.sql).
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, event_type TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(), actor TEXT, resource TEXT, action TEXT, result TEXT,
  metadata JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hosted Supabase defaults, both kinds.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
GRANT ALL ON audit_logs TO anon, authenticated, service_role;

CREATE SCHEMA extensions;
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid SERIAL PRIMARY KEY, jobname TEXT UNIQUE, schedule TEXT, command TEXT,
  username TEXT DEFAULT current_user, active BOOLEAN DEFAULT true);
CREATE FUNCTION cron.schedule(job_name TEXT, schedule TEXT, command TEXT) RETURNS BIGINT
  LANGUAGE sql AS $s$ INSERT INTO cron.job (jobname, schedule, command)
    VALUES (job_name, schedule, command) RETURNING jobid::bigint $s$;
CREATE FUNCTION cron.unschedule(job_name TEXT) RETURNS BOOLEAN
  LANGUAGE sql AS $u$ DELETE FROM cron.job WHERE jobname = job_name RETURNING true $u$;
CREATE SCHEMA vault;
CREATE TABLE vault.decrypted_secrets (name TEXT, decrypted_secret TEXT);
CREATE SCHEMA net;
CREATE SEQUENCE net.req_seq;
CREATE TABLE net.calls (id BIGINT, url TEXT, body JSONB, params JSONB, headers JSONB,
  timeout_milliseconds INTEGER);
-- Same parameter names as pg_net's net.http_post, so the migration's named-argument call binds.
CREATE FUNCTION net.http_post(url TEXT, body JSONB DEFAULT '{}'::jsonb,
  params JSONB DEFAULT '{}'::jsonb,
  headers JSONB DEFAULT '{"Content-Type": "application/json"}'::jsonb,
  timeout_milliseconds INTEGER DEFAULT 5000) RETURNS BIGINT
  LANGUAGE sql AS $h$ INSERT INTO net.calls
    VALUES (nextval('net.req_seq'), url, body, params, headers, timeout_milliseconds)
    RETURNING id $h$;
CREATE TABLE net._http_response (id BIGINT, status_code INTEGER, content_type TEXT, headers JSONB,
  content TEXT, timed_out BOOLEAN, error_msg TEXT, created TIMESTAMPTZ NOT NULL DEFAULT now());
`
}

/** Both functions again from the LATEST migration defining each (CREATE OR REPLACE keeps ACLs). */
export function latestFunctionsSql(): string {
  return ALL_FNS.map((f) => extractLatestFunction(`public.${f}`, LABEL)).join('\n\n')
}

export function fixtureSql(): string {
  return `
RESET ROLE;
SET TIME ZONE 'UTC';
DELETE FROM audit_logs;
DELETE FROM vault.decrypted_secrets;
DELETE FROM net.calls;
DELETE FROM net._http_response;
`
}

/** The harness's build: base stubs, both migrations (pg_net line stubbed), then the latest bodies. */
export function buildSql(): string {
  return [
    baseSchemaSql(),
    priorMigrationForHarness(),
    migrationForHarness(),
    latestFunctionsSql(),
  ].join('\n')
}

// ============================================================================
// Statement builders
// ============================================================================

export const BASE_URL = 'https://x.example'
export const SERVICE_KEY = 'key-123'

export const q = (s: string): string => `'${s.replace(/'/g, "''")}'`
export const AS = (role: string): string => `SET LOCAL ROLE ${role};`
export const ago = (interval: string): string => `now() - interval ${q(interval)}`
/** A timestamp expression as the text the autochain stores (an ISO-like string). */
export const tsText = (expr: string): string => `(${expr})::text`

export const vault = (...rows: Array<[string, string]>): string =>
  `INSERT INTO vault.decrypted_secrets VALUES ${rows.map(([n, v]) => `(${q(n)}, ${q(v)})`).join(', ')};`
/** The dispatcher's only secret. */
export const patSecret = (value: string = PAT): string => vault([PAT_SECRET, value])
/** The watcher's alert credentials (the refresh dead-man's). */
export const standardSecrets = (): string =>
  vault(
    ['refresh_metadata_functions_base_url', BASE_URL],
    ['refresh_metadata_service_role_key', SERVICE_KEY]
  )

export interface MarkerOpts {
  /** State; default 'open'. */
  state?: string
  /** How long ago created_at is; default '1 hour'. */
  created?: string
  /** supabase_env; default 'staging'. A null omits the key. */
  env?: string | null
  /** Extra metadata keys whose VALUES ARE RAW SQL EXPRESSIONS (use `q()` / `tsText()`). */
  fields?: Record<string, string>
}

/** A marker row with a fixed id. Every metadata value is built in SQL so `now()` stays one instant. */
export const marker = (id: string, o: MarkerOpts = {}): string => {
  const pairs: Array<[string, string]> = [
    ['completed_run_id', q(`run-${id}`)],
    ['completed_run_attempt', '1'],
    ['path_prefix', q('')],
    ['state', q(o.state ?? 'open')],
  ]
  if (o.env !== null) pairs.push(['supabase_env', q(o.env ?? 'staging')])
  for (const [k, v] of Object.entries(o.fields ?? {})) pairs.push([k, v])
  const obj = pairs.map(([k, v]) => `${q(k)}, ${v}`).join(', ')
  return (
    `INSERT INTO audit_logs (id, event_type, actor, action, result, resource, metadata, created_at) ` +
    `VALUES (${q(id)}, '${MARKER}', 'gha', 'defer', 'deferred', ${q(`run-${id}`)}, ` +
    `jsonb_build_object(${obj}), ${ago(o.created ?? '1 hour')});`
  )
}

/** An open marker whose window opens `delta` from now ('-1 minute' = passed, '1 hour' = future). */
export const openAt = (id: string, delta: string, o: Omit<MarkerOpts, 'state'> = {}): string =>
  marker(id, {
    ...o,
    fields: { next_window_utc: tsText(`now() + interval ${q(delta)}`), ...o.fields },
  })

/** A consumed, undispatched marker consumed `age` ago. */
export const consumedAgo = (id: string, age: string, o: Omit<MarkerOpts, 'state'> = {}): string =>
  marker(id, {
    ...o,
    state: 'consumed',
    fields: { consumed_at: tsText(ago(age)), ...o.fields },
  })

/** A dispatcher or watcher row with a fixed id and a metadata object given as SQL. */
export const auditRow = (
  eventType: string,
  when: string,
  metadataSql: string,
  id?: string
): string =>
  `INSERT INTO audit_logs (${id ? 'id, ' : ''}event_type, actor, action, result, metadata, created_at) ` +
  `VALUES (${id ? `${q(id)}, ` : ''}${q(eventType)}, 'pg_cron', 'x', 'queued', ${metadataSql}, ${ago(when)});`

export interface ResponseOpts {
  content?: string | null
  error?: string | null
  timedOut?: boolean
}
export const responseRow = (id: number, status: number | null, o: ResponseOpts = {}): string =>
  `INSERT INTO net._http_response (id, status_code, content, error_msg, timed_out) VALUES ` +
  `(${id}, ${status === null ? 'NULL' : status}, ${o.content == null ? 'NULL' : q(o.content)}, ` +
  `${o.error == null ? 'NULL' : q(o.error)}, ${o.timedOut ? 'true' : 'false'});`

// ============================================================================
// Run + read helpers
// ============================================================================

/** Run statements in ONE transaction that is always rolled back. Throws on any SQL ERROR. */
export async function inTxn(
  ctl: PsqlSession,
  stmts: string[]
): Promise<{ lines: string[]; stderr: string }> {
  const r = await inTxnRaw(ctl, stmts)
  if (/ERROR/.test(r.stderr))
    throw new Error(`unexpected SQL error:\n${r.stderr}\n${stmts.join('\n')}`)
  return r
}

/** Same, but errors are returned for the caller to assert on. */
export async function inTxnRaw(
  ctl: PsqlSession,
  stmts: string[]
): Promise<{ lines: string[]; stderr: string }> {
  const res = await ctl.send(`BEGIN;\n${stmts.join('\n')}\nROLLBACK;`)
  return { lines: res.stdout.split('\n').filter((l) => l.length > 0), stderr: res.stderr }
}

export function sqlstate(res: { stderr: string }): string | null {
  const m = /ERROR:\s+([0-9A-Z]{5}):/.exec(res.stderr)
  return m ? m[1] : null
}

export async function scalarQuery(ctl: PsqlSession, sql: string): Promise<string> {
  const res = await ctl.send(sql)
  const line = res.stdout.split('\n').find((l) => l.length > 0)
  if (line === undefined) throw new Error(`no scalar returned for: ${sql}\nstderr: ${res.stderr}`)
  return line
}

export const count = (label: string, from: string): string =>
  `SELECT '${label}=' || count(*) FROM ${from};`

export const lines = (r: { stdout: string }): string[] =>
  r.stdout.split('\n').filter((l) => l.length > 0)

/** Counts every arm summarises: HTTP calls, dispatch rows, error rows. */
export const posts = count('posts', 'net.calls')
export const dispatches = count('dispatches', `audit_logs WHERE event_type = '${DISPATCH}'`)
export const resumeErrors = count('errors', `audit_logs WHERE event_type = '${RESUME_ERROR}'`)
export const SUMMARY = [posts, dispatches, resumeErrors]

/** Shared by the arm modules. */
export interface Ctx {
  ctl: () => PsqlSession
}
