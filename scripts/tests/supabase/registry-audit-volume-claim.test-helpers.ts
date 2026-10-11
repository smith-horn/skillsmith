/**
 * SMI-7050 (ADR-178 property 5): live-Postgres harness for the registry-audit volume monitor's
 * claim protocol (migration 20261010000000) and its dispatcher (20261010000001).
 *
 * CONNECTION (five-var convention): SMI7050_TEST_PGHOST/PORT/USER/PASSWORD/DATABASE. From the
 * worktree's dev container, against a throwaway Postgres reachable as `host.docker.internal`:
 *
 *   docker run -d --rm --name smi7050-pg-test -e POSTGRES_PASSWORD=testpass \
 *     -e POSTGRES_DB=postgres -p 15730:5432 postgres:17.6
 *   ./scripts/worktree-docker.sh exec -- env SMI7050_TEST_PGHOST=host.docker.internal \
 *     SMI7050_TEST_PGPORT=15730 SMI7050_TEST_PGUSER=postgres SMI7050_TEST_PGPASSWORD=testpass \
 *     SMI7050_TEST_PGDATABASE=postgres npx vitest run scripts/tests/supabase/registry-audit-volume-claim
 *
 * REAL vs STUBBED. REAL (read verbatim from the repo at run time): migrations A and B in full
 * (so this suite also proves they apply and pass their own smoke blocks), the six state functions
 * again via `extractLatestFunction` (so a later migration redefining one is the body under test,
 * not a stale copy), and the SMI-6114 predicate. STUBBED: `audit_logs` / `schema_version` (the
 * columns the predicate and the migrations touch), and the Supabase-only schemas `cron`, `vault`
 * and `net` (a job table, a secrets table, an http_post that records its arguments). The
 * `CREATE EXTENSION pg_net` line of migration B is the one statement removed, because the stock
 * image has no pg_net; the removal is asserted to have happened.
 *
 * Hosted Supabase grants EXECUTE on every new function AND ALL on every new table to
 * anon/authenticated/service_role by default. Both defaults are emulated: without them the
 * migrations' REVOKEs would have nothing to revoke and their tests could not bite (D14).
 *
 * TIME IS NEVER PASSED IN (R3-1). Each arm seeds and calls inside ONE transaction, so `now()` is
 * the same instant for the seed and for every function call and the 24h boundary is exact.
 *
 * @module scripts/tests/supabase/registry-audit-volume-claim.test-helpers
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractLatestFunction, type TestConn, type PsqlSession } from './pg-session.ts'

export { PsqlSession, type TestConn } from './pg-session.ts'

export const MIG_A = '20261010000000_registry_audit_volume_alert_state.sql'
export const MIG_B = '20261010000001_registry_audit_volume_monitor_pg_cron.sql'
const LABEL = 'SMI-7050'

export const STATE_FNS = [
  'claim_registry_audit_volume_alerts',
  'settle_registry_audit_volume_alerts',
  'count_stale_registry_audit_volume_claims',
  'clear_registry_audit_volume_alerts',
  'claim_registry_audit_volume_health',
  'settle_registry_audit_volume_health',
] as const

// ============================================================================
// Connection env
// ============================================================================

export function testConnFromEnv(env: NodeJS.ProcessEnv = process.env): TestConn | null {
  const host = env.SMI7050_TEST_PGHOST
  const port = env.SMI7050_TEST_PGPORT
  const user = env.SMI7050_TEST_PGUSER
  const password = env.SMI7050_TEST_PGPASSWORD
  const database = env.SMI7050_TEST_PGDATABASE
  if (!host || !port || !user || !password || !database) return null
  return { host, port, user, password, database }
}

export const noLiveTestPg = !testConnFromEnv()

if (noLiveTestPg) {
  console.warn(
    '[smi7050-volume-claim] no live test Postgres configured (SMI7050_TEST_PGHOST/PORT/USER/' +
      'PASSWORD/DATABASE unset), so the live-Postgres half of this suite (.pg.test.ts) will SKIP. ' +
      'The PG-free assertions live in the sibling .structural.test.ts. The skipped half is the ' +
      'ONLY coverage that executes the shipped claim/settle/clear bodies.'
  )
}

export function requireTestConn(): TestConn {
  const conn = testConnFromEnv()
  if (!conn) throw new Error('SMI-7050: no live test Postgres configured (SMI7050_TEST_PG*).')
  return conn
}

export const readMigration = (file: string): string =>
  readFileSync(join(process.cwd(), 'supabase/migrations', file), 'utf8')

/** Migration B without its pg_net line; asserts the line existed so the strip cannot be a no-op. */
export function migrationBForHarness(): string {
  const src = readMigration(MIG_B)
  const stripped = src.replace(/^CREATE EXTENSION IF NOT EXISTS pg_net[^;]*;/m, '-- (pg_net stub)')
  if (stripped === src)
    throw new Error('migration B no longer contains the pg_net CREATE EXTENSION')
  return stripped
}

// ============================================================================
// Schema
// ============================================================================

export function baseSchemaSql(): string {
  const predicate = extractLatestFunction('public.registry_audit_volume_over_threshold', LABEL)
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
DROP TABLE IF EXISTS audit_logs, schema_version,
  registry_audit_volume_alert_state, registry_audit_volume_monitor_health CASCADE;
DO $drop$ DECLARE r RECORD; BEGIN
  FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname IN ('registry_audit_volume_over_threshold',
                                'invoke_registry_audit_volume_monitor',
                                '${STATE_FNS.join("', '")}')
  LOOP EXECUTE 'DROP FUNCTION ' || r.sig || ' CASCADE'; END LOOP;
END $drop$;

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, event_type TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(), actor TEXT, resource TEXT, action TEXT, result TEXT,
  metadata JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

-- Hosted Supabase defaults, both kinds (D14: the table default is the one the harness used to omit).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

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
CREATE TABLE net.calls (url TEXT, headers JSONB, body JSONB);
CREATE FUNCTION net.http_post(url TEXT, headers JSONB, body JSONB) RETURNS BIGINT
  LANGUAGE sql AS $h$ INSERT INTO net.calls VALUES (url, headers, body) RETURNING 1::bigint $h$;

${predicate}
`
}

/** The six state functions again from the LATEST migration defining each (CREATE OR REPLACE keeps ACLs). */
export function latestStateFunctionsSql(): string {
  return STATE_FNS.map((f) => extractLatestFunction(`public.${f}`, LABEL)).join('\n\n')
}

export function fixtureSql(): string {
  return `
RESET ROLE;
SET TIME ZONE 'UTC';
DELETE FROM registry_audit_volume_alert_state;
DELETE FROM audit_logs;
DELETE FROM vault.decrypted_secrets;
DELETE FROM net.calls;
UPDATE registry_audit_volume_monitor_health
   SET last_alerted_at = NULL, last_outcome = NULL, claim_token = NULL, claimed_at = NULL;
`
}

/** The harness's build: base stubs, migration A, latest bodies, migration B (pg_net line stubbed). */
export function buildSql(migrationA: string = readMigration(MIG_A)): string {
  return [baseSchemaSql(), migrationA, latestStateFunctionsSql(), migrationBForHarness()].join('\n')
}

// ============================================================================
// Call + read helpers
// ============================================================================

export const A = 'user:A'
export const B = 'user:B'
export const TOK1 = '00000000-0000-0000-0000-000000000001'
export const TOK2 = '00000000-0000-0000-0000-000000000002'
export const TOK3 = '00000000-0000-0000-0000-000000000003'
export const BUCKET = '2026-10-10T10:00:00Z'

export const q = (s: string): string => `'${s.replace(/'/g, "''")}'`

/** An offenders array: one valid element per actor. */
export const offenders = (...actors: string[]): string =>
  JSON.stringify(actors.map((actor) => ({ actor, bucket: BUCKET, cnt: 201 })))

export const claim = (offs: string, tok: string): string =>
  `SELECT 'claim=' || coalesce(string_agg(c, ',' ORDER BY c), '') ` +
  `FROM public.claim_registry_audit_volume_alerts(${q(offs)}::jsonb, ${q(tok)}::uuid) AS c;`

export const settle = (tok: string, outcome: string): string =>
  `SELECT 'settle=' || public.settle_registry_audit_volume_alerts(${q(tok)}::uuid, ${q(outcome)});`

export const healthClaim = (kind: string, tok: string): string =>
  `SELECT 'hclaim=' || public.claim_registry_audit_volume_health(${q(kind)}, ${q(tok)}::uuid);`

export const healthSettle = (kind: string, tok: string, outcome: string): string =>
  `SELECT 'hsettle=' || public.settle_registry_audit_volume_health(${q(kind)}, ${q(tok)}::uuid, ${q(outcome)});`

/** `ago` is a SQL interval literal body, e.g. "24 hours 1 microsecond". */
export const seedAlerted = (actor: string, ago: string): string =>
  `UPDATE registry_audit_volume_alert_state SET last_alerted_at = now() - interval ${q(ago)} WHERE actor = ${q(actor)};`
export const seedClaimed = (actor: string, ago: string): string =>
  `UPDATE registry_audit_volume_alert_state SET claimed_at = now() - interval ${q(ago)} WHERE actor = ${q(actor)};`
export const seedHealthAlerted = (kind: string, ago: string): string =>
  `UPDATE registry_audit_volume_monitor_health SET last_alerted_at = now() - interval ${q(ago)} WHERE kind = ${q(kind)};`

/** One labelled line describing a state row, computed by Postgres in the same transaction. */
export const rowState = (actor: string): string =>
  `SELECT 'row[${actor}]=' || coalesce((SELECT 'token=' || coalesce(claim_token::text, 'null') ` +
  `|| ',alerted=' || (last_alerted_at IS NOT NULL) || ',outcome=' || coalesce(last_outcome, 'null') ` +
  `FROM registry_audit_volume_alert_state WHERE actor = ${q(actor)}), 'absent');`

/** Run statements in ONE transaction that is always rolled back. Returns Postgres's output lines. */
export async function inTxn(
  ctl: PsqlSession,
  stmts: string[]
): Promise<{ lines: string[]; stderr: string }> {
  const res = await ctl.send(`BEGIN;\n${stmts.join('\n')}\nROLLBACK;`)
  return { lines: res.stdout.split('\n').filter((l) => l.length > 0), stderr: res.stderr }
}

/** Same, but the statements are expected to RAISE; the txn is rolled back either way. */
export async function inTxnExpectingError(
  ctl: PsqlSession,
  stmts: string[]
): Promise<{ state: string | null; stderr: string }> {
  const res = await ctl.send(`BEGIN;\n${stmts.join('\n')}\nROLLBACK;`)
  return { state: sqlstate(res), stderr: res.stderr }
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

/** Shared by the arm modules. */
export interface Ctx {
  ctl: () => PsqlSession
  /** A second and third independent session, for the interleaving arms. */
  s1: () => PsqlSession
  s2: () => PsqlSession
}
