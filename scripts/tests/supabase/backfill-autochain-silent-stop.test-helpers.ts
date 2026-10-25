/**
 * SMI-7167: live-Postgres harness for the backfill autochain silent-stop detector migration
 * (20261025000000): backfill_autochain_silent_stop_candidates() and the detector
 * check_backfill_autochain_silent_stop().
 *
 * CONNECTION (five-var convention, shared with the SMI-7121 suite on purpose: the same throwaway DB):
 * SMI7121_TEST_PGHOST/PORT/USER/PASSWORD/DATABASE. From the worktree's dev container:
 *
 *   ./scripts/worktree-docker.sh exec -- env SMI7121_TEST_PGHOST=host.docker.internal \
 *     SMI7121_TEST_PGPORT=15721 SMI7121_TEST_PGUSER=postgres SMI7121_TEST_PGPASSWORD=testpass \
 *     SMI7121_TEST_PGDATABASE=postgres npx vitest run \
 *     scripts/tests/supabase/backfill-autochain-silent-stop.pg.test.ts
 *
 * RUN ONE live-PG suite at a time against a given database. This suite and the SMI-7121 one both
 * create and drop the same stub schemas, so running them in one vitest invocation (files run in
 * parallel) makes each tear the other's fixtures down; measured 2026-10-25: 7 spurious failures
 * together, 115/115 and 97/97 apart.
 *
 * REAL vs STUBBED. REAL (read verbatim from the repo at run time): the migration in full (so this
 * suite also proves it applies and passes its own $smoke$ block), both functions again via
 * `extractLatestFunction`, and the paired rollback. STUBBED: `audit_logs` (the prod column set, id
 * TEXT), and the Supabase-only schemas `cron`, `vault` and `net` (an http_post that records its
 * arguments and returns a sequence id, plus the `_http_response` table). The `CREATE EXTENSION pg_net`
 * line is the one statement removed, because the stock image has no pg_net; the removal is asserted.
 *
 * Hosted Supabase grants EXECUTE on every new function AND ALL on every new table to
 * anon/authenticated/service_role by default. Both defaults are emulated, otherwise the migration's
 * REVOKEs would have nothing to revoke and the grant tests could not bite.
 *
 * TIME IS NEVER PASSED IN. Each single-session arm seeds and calls inside ONE transaction, so `now()`
 * is the same instant for the seed and for every call, rows are dated relative to it, and every age
 * boundary is exact (the tests use +/- 1 minute around each boundary).
 *
 * @module scripts/tests/supabase/backfill-autochain-silent-stop.test-helpers
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractLatestFunction, type TestConn, type PsqlSession } from './pg-session.ts'

export { PsqlSession, type TestConn } from './pg-session.ts'

export const MIGRATION = '20261025000000_backfill_autochain_silent_stop.sql'
export const ROLLBACK = '20261025000000_backfill_autochain_silent_stop_down.sql'
const LABEL = 'SMI-7167'

export const FNS = {
  candidates: 'backfill_autochain_silent_stop_candidates',
  detector: 'check_backfill_autochain_silent_stop',
} as const
export const ALL_FNS = Object.values(FNS)
export const FN_SIGS = [
  'public.backfill_autochain_silent_stop_candidates()',
  'public.check_backfill_autochain_silent_stop()',
]
export const JOB = 'backfill-autochain-silent-stop-watch'
export const JOB_SCHEDULE = '38 * * * *'

export const EV = {
  prepared: 'indexer_backfill_autochain_dispatch_prepared',
  resolved: 'indexer_backfill_autochain_dispatch_resolved',
  started: 'indexer_backfill_autochain_link_started',
  finished: 'indexer_backfill_autochain_link_finished',
  ack: 'indexer_backfill_autochain_silent_stop_ack',
  checkpoint: 'indexer_backfill_checkpoint',
  alert: 'indexer_backfill_autochain_silent_stop_alert',
  error: 'indexer_backfill_autochain_silent_stop_error',
} as const
export const ALERT_TYPE = {
  A: 'indexer_backfill_autochain_silent_stop',
  B: 'indexer_backfill_autochain_dispatch_ambiguous',
} as const
export const KILL_SWITCH = 'SKILLSMITH_BACKFILL_AUTOCHAIN_SILENT_STOP_DISABLE'
export const SENT = '{"data":{"sent":true}}'
export const DETECT = 'SELECT public.check_backfill_autochain_silent_stop();'

// ============================================================================
// Connection env
// ============================================================================

export function testConnFromEnv(env: NodeJS.ProcessEnv = process.env): TestConn | null {
  const host = env.SMI7121_TEST_PGHOST
  const port = env.SMI7121_TEST_PGPORT
  const user = env.SMI7121_TEST_PGUSER
  const password = env.SMI7121_TEST_PGPASSWORD
  const database = env.SMI7121_TEST_PGDATABASE
  if (!host || !port || !user || !password || !database) return null
  return { host, port, user, password, database }
}

export const noLiveTestPg = !testConnFromEnv()

if (noLiveTestPg) {
  console.warn(
    '[smi7167-backfill-autochain-silent-stop] no live test Postgres configured (SMI7121_TEST_PGHOST/' +
      'PORT/USER/PASSWORD/DATABASE unset), so the live-Postgres suite (.pg.test.ts) will SKIP. The ' +
      'skipped suite is the ONLY coverage that executes the shipped candidates and detector bodies; ' +
      'the PG-free assertions live in the sibling .structural.test.ts.'
  )
}

export function requireTestConn(): TestConn {
  const conn = testConnFromEnv()
  if (!conn) throw new Error('SMI-7167: no live test Postgres configured (SMI7121_TEST_PG*).')
  return conn
}

const readFile = (dir: string, file: string): string =>
  readFileSync(join(process.cwd(), dir, file), 'utf8')

/** The migration without its pg_net line; asserts the line existed so the strip cannot be a no-op. */
export function migrationForHarness(): string {
  const src = readFile('supabase/migrations', MIGRATION)
  const stripped = src.replace(/^CREATE EXTENSION IF NOT EXISTS pg_net[^;]*;/m, '-- (pg_net stub)')
  if (stripped === src)
    throw new Error('the migration no longer contains the pg_net CREATE EXTENSION')
  return stripped
}

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
              AND p.proname IN ('${ALL_FNS.join("', '")}')
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

/** The harness's build: base stubs, the migration (pg_net line stubbed), then the latest bodies. */
export function buildSql(): string {
  return [baseSchemaSql(), migrationForHarness(), latestFunctionsSql()].join('\n')
}

// ============================================================================
// Statement builders
// ============================================================================

export const BASE_URL = 'https://x.example'
export const SERVICE_KEY = 'key-123'

export const q = (s: string): string => `'${s.replace(/'/g, "''")}'`
export const AS = (role: string): string => `SET LOCAL ROLE ${role};`
export const ago = (interval: string): string => `now() - interval ${q(interval)}`

export const vault = (...rows: Array<[string, string]>): string =>
  `INSERT INTO vault.decrypted_secrets VALUES ${rows.map(([n, v]) => `(${q(n)}, ${q(v)})`).join(', ')};`
export const standardSecrets = (): string =>
  vault(
    ['refresh_metadata_functions_base_url', BASE_URL],
    ['refresh_metadata_service_role_key', SERVICE_KEY]
  )

type Meta = Record<string, unknown>

/** One audit_logs row; `meta` is serialised verbatim, so a number stays a JSON number. */
const ledger = (eventType: string, when: string, meta: Meta): string =>
  `INSERT INTO audit_logs (event_type, actor, action, result, metadata, created_at) VALUES ` +
  `(${q(eventType)}, 'gha', 'ledger', 'ok', ${q(JSON.stringify(meta))}::jsonb, ${ago(when)});`

/** dispatch_prepared for (token, attempt). Every id is a JSON string, as the workflow writes it. */
export const preparedRow = (tok: string, att: string, when: string, meta: Meta = {}): string =>
  ledger(EV.prepared, when, {
    dispatch_token: tok,
    link_run_attempt: att,
    link_run_id: '9000',
    supabase_env: 'production',
    ...meta,
  })

/** dispatch_resolved, outcome 'dispatched', naming run `rid` (a string). */
export const dispatchedRow = (rid: unknown, when: string, meta: Meta = {}): string =>
  ledger(EV.resolved, when, {
    outcome: 'dispatched',
    dispatched_run_id: rid,
    dispatch_token: 'ac-9',
    link_run_attempt: '1',
    link_run_id: '9000',
    supabase_env: 'production',
    ...meta,
  })

/** dispatch_resolved, outcome 'not_dispatched', closing (token, attempt). */
export const notDispatchedRow = (tok: string, att: string, when: string, meta: Meta = {}): string =>
  ledger(EV.resolved, when, {
    outcome: 'not_dispatched',
    dispatch_token: tok,
    link_run_attempt: att,
    ...meta,
  })

export const linkStartedRow = (rid: string, when = '1 minute'): string =>
  ledger(EV.started, when, { completed_run_id: rid })

export const linkFinishedRow = (rid: string, when = '1 minute', status = 'success'): string =>
  ledger(EV.finished, when, { completed_run_id: rid, status })

export const ackRow = (arm: string, key: string, when = '1 minute'): string =>
  ledger(EV.ack, when, { arm, key, reason: 'test', acked_by: 'tester' })

/** A backfill checkpoint for run `rid`; dry_run is a JSON boolean. */
export const checkpointRow = (rid: string, when: string, dryRun = false): string =>
  ledger(EV.checkpoint, when, { run_id: rid, dry_run: dryRun })

/** A request id as it lands in metadata: a number is stored as a JSON number, a string as text. */
const ridSql = (rid: string | number): string =>
  typeof rid === 'number' ? `${rid}::bigint` : q(rid)

export interface AlertOpts {
  /** Harvested result: present means the status_code KEY exists (null = harvested transport failure). */
  harvested?: { status: number | null; sent: string | null }
}

/** A prior detector alert for (arm, key). */
export const alertRow = (
  arm: string,
  key: string,
  when: string,
  rid: string | number,
  o: AlertOpts = {}
): string => {
  const h = o.harvested
  const extra = h
    ? `, 'status_code', ${h.status === null ? 'NULL::integer' : h.status}, ` +
      `'sent', ${h.sent === null ? 'NULL::text' : q(h.sent)}`
    : ''
  return (
    `INSERT INTO audit_logs (event_type, actor, action, result, metadata, created_at) VALUES ` +
    `('${EV.alert}', 'pg_cron', 'alert', 'queued', jsonb_build_object('arm', ${q(arm)}, ` +
    `'key', ${q(key)}, 'sub_kind', 'no_link', 'net_request_id', ${ridSql(rid)}${extra}), ${ago(when)});`
  )
}

export const responseRow = (id: number, status: number | null, content?: string | null): string =>
  `INSERT INTO net._http_response (id, status_code, content) VALUES ` +
  `(${id}, ${status === null ? 'NULL' : status}, ${content == null ? 'NULL' : q(content)});`

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

/**
 * The candidates function, one line per row: `c=<arm>|<key>|<sub_kind>|<deadline - now()>`. The
 * deadline is printed relative to the transaction's now(), so it is exact and needs no clock.
 */
export const CANDIDATES =
  "SELECT 'c=' || arm || '|' || key || '|' || sub_kind || '|' || (deadline - now())::text " +
  'FROM public.backfill_autochain_silent_stop_candidates() ORDER BY arm, key;'

/** Expected line for CANDIDATES. */
export const cand = (arm: string, key: string, sub: string, deadlineRel: string): string =>
  `c=${arm}|${key}|${sub}|${deadlineRel}`

/** Shared by the arm modules. */
export interface Ctx {
  ctl: () => PsqlSession
}
