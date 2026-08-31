/**
 * SMI-6318: live-Postgres harness for `purge-schedule-dedup.test.ts`.
 *
 * WHY A LIVE DATABASE RATHER THAN A STRUCTURAL ASSERTION
 * -----------------------------------------------------
 * `supabase/functions/_shared/sso-lifecycle.test.ts` is honest that it can only
 * assert the SHIPPED SQL still *reads* the way the design requires — this repo
 * had no live-Postgres harness when it was written. It does now:
 * `scripts/indexer/smi5879-census.pg.ts` (a `psql` subprocess wrapper) plus the
 * throwaway container `scripts/tests/indexer/repo-url-canonical-trigger.test-helpers.ts`
 * documents. SMI-6318 is a CONCURRENCY-ADJACENT DATA-INTEGRITY fix whose whole
 * claim is behavioural ("a second departure extends the window instead of adding
 * a second, older-timer row"), so it is verified by running the REAL functions
 * against a real Postgres — including a NEGATIVE control that reproduces the bug
 * with the pre-fix code first, so a passing suite cannot be vacuous.
 *
 * Connection: the SMI-5879 suite's own env vars (same ephemeral instance).
 *
 *   docker run -d --name smi5879-census-test-pg -e POSTGRES_PASSWORD=testpass \
 *     -e POSTGRES_DB=postgres -p 15499:5432 postgres:15-alpine
 *   SMI5879_TEST_PGHOST=host.docker.internal SMI5879_TEST_PGPORT=15499 \
 *   SMI5879_TEST_PGUSER=postgres SMI5879_TEST_PGPASSWORD=testpass \
 *   SMI5879_TEST_PGDATABASE=postgres \
 *     npx vitest run scripts/tests/purge-schedule-dedup.test.ts
 *
 * ISOLATION: a dedicated DATABASE, not a schema. The sibling SMI-5879 suites
 * isolate per-schema, which works because their subject functions are
 * `SECURITY INVOKER` / schema-agnostic. The functions here are SECURITY DEFINER
 * with `SET search_path = public, pg_temp` baked into the shipped migration
 * text, so they resolve `public` no matter which schema a test creates fixtures
 * in — a per-schema copy would either need the migration text rewritten (testing
 * a mutated copy, not the shipped file) or would fight the other suites over
 * `public`. A throwaway database gives the real `public` schema with zero
 * cross-file interference.
 *
 * FIXTURE HONESTY: `BASE_FIXTURE_SQL` below reproduces only the objects OTHER
 * migrations own (auth helpers, profiles/teams/team_members/audit_logs/
 * license_keys/user_devices, the two SSO config tables, a `cron` stub). Every
 * object actually UNDER TEST is applied from its REAL shipped file on disk:
 * `20260707000004` verbatim, the three Wave-4 functions extracted from
 * `20260829230000` by dollar-quote tag, and the SMI-6318 migration verbatim.
 * `recompute_user_tier()` is a deliberate no-op stub — `remove_team_member()`
 * only `PERFORM`s it and the tier machinery is not what this suite tests.
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
} from '../indexer/smi5879-census.pg.ts'

const MIGRATIONS_DIR = join(process.cwd(), 'supabase/migrations')
const DEPARTURE_PURGE = '20260707000004_team_member_departure_purge.sql'
const SSO_LIFECYCLE = '20260829230000_sso_member_lifecycle.sql'
const DEDUP_FIX = '20260831130000_purge_schedule_pending_dedup.sql'

/** Dedicated throwaway database — see this file's ISOLATION note. */
export const TEST_DB = 'smi6318_purge_dedup'

/** True when no live test Postgres is configured; every test skips rather than failing. */
export const noLiveTestPg = !testConnParamsFromEnv()

/** "\x00GITCRYPT" — `supabase/migrations/**` is encrypted (`.gitattributes`). */
const GIT_CRYPT_MAGIC = Buffer.from([0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54])

/**
 * Set only by `post-merge-verify.yml`, the one workflow genuinely expected to run on a
 * locked checkout (SMI-4221: a workflow holding `issues: write` must not also hold a
 * decrypt key). Same convention, and same reasoning, as
 * `scripts/tests/private-registry-rls.test.ts` (SMI-5984): a byte-header match alone is
 * NOT proof the lock is intentional. This repo has a documented history of git-crypt
 * filter fragility (SMI-5702/SMI-5861), so a lock detected anywhere else is a REAL
 * failure — silently degrading to "skip the content checks" there would mask exactly the
 * unlock failure this should surface.
 */
const EXPECT_LOCKED_ENV_VAR = 'SKILLSMITH_GIT_CRYPT_EXPECTED_LOCKED'

function isLockedFile(path: string): boolean {
  return readFileSync(path).subarray(0, GIT_CRYPT_MAGIC.length).equals(GIT_CRYPT_MAGIC)
}

/**
 * True when the SMI-6318 migration is git-crypt ciphertext AND this job is one that
 * legitimately runs locked. Callers gate their content assertions on it. A lock WITHOUT
 * the env var is deliberately NOT reported here — `readMigration()` throws for that case.
 */
export function dedupMigrationLocked(): boolean {
  return isLockedFile(join(MIGRATIONS_DIR, DEDUP_FIX)) && process.env[EXPECT_LOCKED_ENV_VAR] === '1'
}

/** Filenames stay plaintext under git-crypt, so existence is checkable in either state. */
export function dedupMigrationPath(): string {
  return join(MIGRATIONS_DIR, DEDUP_FIX)
}

export function readMigration(file: string): string {
  const path = join(MIGRATIONS_DIR, file)
  const raw = readFileSync(path)
  if (raw.subarray(0, GIT_CRYPT_MAGIC.length).equals(GIT_CRYPT_MAGIC)) {
    throw new Error(
      `${path} appears git-crypt-locked, but ${EXPECT_LOCKED_ENV_VAR} isn't set — this ` +
        'checkout is not expected to be locked here. If this is post-merge-verify.yml, set ' +
        `${EXPECT_LOCKED_ENV_VAR}=1 on the job. Otherwise this may mean git-crypt failed to ` +
        'unlock — treat as a real failure, not a lock-state edge case.'
    )
  }
  return raw.toString('utf8')
}

/**
 * Extract ONE complete `CREATE OR REPLACE FUNCTION <name>` statement, including
 * its dollar-quoted body, from a migration's text. Same motivation as
 * `sso-lifecycle.test.ts`'s `fnBody()`: run the REAL shipped definition rather
 * than a hand-copied duplicate that can silently drift from it.
 */
export function extractFunction(sql: string, name: string): string {
  const open = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`)
  if (open === -1) throw new Error(`SMI-6318 harness: ${name}() not found in migration text`)
  const tagMatch = /AS \$([A-Za-z0-9_]*)\$/.exec(sql.slice(open))
  if (!tagMatch) throw new Error(`SMI-6318 harness: no dollar-quote tag after ${name}(`)
  const tag = `$${tagMatch[1]}$`
  const bodyStart = open + tagMatch.index + tagMatch[0].length
  const bodyEnd = sql.indexOf(tag, bodyStart)
  if (bodyEnd === -1) throw new Error(`SMI-6318 harness: unterminated body for ${name}()`)
  const stmtEnd = sql.indexOf(';', bodyEnd + tag.length)
  return sql.slice(open, stmtEnd + 1)
}

/**
 * Objects owned by OTHER migrations, reproduced minimally. Column sets cover
 * exactly what the functions under test read or write; unrelated production
 * columns are deliberately absent so this file cannot drift into pretending to
 * be a schema dump.
 */
const BASE_FIXTURE_SQL = `
DO $roles$
BEGIN
  IF to_regrole('anon') IS NULL THEN CREATE ROLE anon NOLOGIN; END IF;
  IF to_regrole('authenticated') IS NULL THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF to_regrole('service_role') IS NULL THEN CREATE ROLE service_role NOLOGIN; END IF;
END $roles$;

CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE auth.users (
  id                 UUID PRIMARY KEY,
  email              TEXT,
  email_confirmed_at TIMESTAMPTZ DEFAULT now()
);

-- Supabase's own helper, verbatim in behaviour: the request's signed 'sub' claim.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $uid$
  SELECT COALESCE(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid;
$uid$;

CREATE TABLE profiles (
  id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  tier  TEXT NOT NULL DEFAULT 'community',
  role  TEXT NOT NULL DEFAULT 'user'
);

CREATE TABLE teams (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  owner_id UUID REFERENCES profiles(id)
);

CREATE TABLE team_members (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  team_id         TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'member'
                    CHECK (role IN ('owner', 'admin', 'member')),
  invited_by      UUID REFERENCES profiles(id),
  invited_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  joined_at       TIMESTAMPTZ,
  provisioned_via TEXT,
  sso_verified_at TIMESTAMPTZ,
  UNIQUE (team_id, user_id)
);

CREATE TABLE audit_logs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  actor      TEXT,
  resource   TEXT,
  action     TEXT,
  result     TEXT,
  metadata   JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE license_keys (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'active',
  tier       TEXT,
  revoked_at TIMESTAMPTZ,
  metadata   JSONB
);

CREATE TABLE user_devices (
  device_id    UUID PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label        TEXT,
  last_seen_at TIMESTAMPTZ
);

CREATE TABLE team_sso_settings (
  team_id              TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  supabase_provider_id UUID UNIQUE,
  reverify_days        INT NOT NULL DEFAULT 7 CHECK (reverify_days BETWEEN 1 AND 30),
  role_mapping         JSONB NOT NULL DEFAULT '{}'::jsonb,
  status               TEXT NOT NULL DEFAULT 'inactive'
                         CHECK (status IN ('inactive', 'active')),
  configured_by        UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT team_sso_settings_active_requires_provider
    CHECK (status = 'inactive' OR supabase_provider_id IS NOT NULL)
);

CREATE TABLE team_sso_domains (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id            TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  domain             TEXT NOT NULL,
  verification_token TEXT NOT NULL,
  verified_at        TIMESTAMPTZ,
  UNIQUE (team_id, domain)
);

CREATE TABLE schema_version (
  version    INT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Deliberate no-op stub: remove_team_member()/expire_stale_sso_members() only
-- PERFORM it, and the tier machinery is a different mechanism's subject.
CREATE OR REPLACE FUNCTION recompute_user_tier(p_user_id UUID)
RETURNS VOID LANGUAGE plpgsql AS $rct$
BEGIN
  PERFORM 1 WHERE p_user_id IS NOT NULL;
END $rct$;

-- pg_cron stub so 20260707000004's schedule block applies unchanged.
CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE cron.job (jobid BIGSERIAL PRIMARY KEY, jobname TEXT, schedule TEXT, command TEXT);
CREATE OR REPLACE FUNCTION cron.schedule(p_name TEXT, p_sched TEXT, p_cmd TEXT)
RETURNS BIGINT LANGUAGE plpgsql AS $sch$
DECLARE v_id BIGINT;
BEGIN
  INSERT INTO cron.job (jobname, schedule, command) VALUES (p_name, p_sched, p_cmd)
  RETURNING jobid INTO v_id;
  RETURN v_id;
END $sch$;
CREATE OR REPLACE FUNCTION cron.unschedule(p_name TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql AS $uns$
BEGIN
  DELETE FROM cron.job WHERE jobname = p_name;
  RETURN TRUE;
END $uns$;

-- Supabase's platform-level ALTER DEFAULT PRIVILEGES on functions, replicated so the
-- Check-52 leak class this schema keeps hitting is actually REACHABLE here. Without it,
-- the grant-boundary smoke blocks in both migrations would pass vacuously.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
`

/** Connection params for the throwaway database (falls back to the admin DB for DDL). */
export function testDbConn(): PgConnParams {
  const base = testConnParamsFromEnv()
  if (!base) throw new Error('SMI-6318 harness: no live test Postgres configured')
  return { ...base, database: TEST_DB }
}

/**
 * Drop + recreate the throwaway database, install the base fixture, then apply
 * the REAL shipped migrations up to (but NOT including) the SMI-6318 fix.
 * Returns a connection to it. Leaving the fix un-applied is what lets the suite
 * reproduce the bug first.
 */
export async function resetToPreFixState(): Promise<PgConnParams> {
  const admin = testConnParamsFromEnv()
  if (!admin) throw new Error('SMI-6318 harness: no live test Postgres configured')

  await runPsql(admin, `DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE);`)
  await runPsql(admin, `CREATE DATABASE ${TEST_DB};`)

  const conn = testDbConn()
  await runPsql(conn, BASE_FIXTURE_SQL)
  await runPsql(conn, readMigration(DEPARTURE_PURGE))

  // The three Wave-4 functions the sweep path needs, from the REAL file. Order
  // matters: expire_stale_sso_members() references the other two.
  const lifecycle = readMigration(SSO_LIFECYCLE)
  for (const fn of ['sso_reverify_days', 'sso_expiry_eligible', 'expire_stale_sso_members']) {
    await runPsql(conn, extractFunction(lifecycle, fn))
  }
  await runPsql(
    conn,
    `REVOKE ALL ON FUNCTION public.expire_stale_sso_members() FROM PUBLIC;
     REVOKE EXECUTE ON FUNCTION public.expire_stale_sso_members() FROM anon, authenticated;
     GRANT EXECUTE ON FUNCTION public.expire_stale_sso_members() TO service_role;`
  )
  return conn
}

/** Apply the SMI-6318 migration verbatim, including every one of its own smoke blocks. */
export async function applyDedupFix(conn: PgConnParams): Promise<string> {
  const { stderr } = await runPsql(conn, readMigration(DEDUP_FIX))
  return stderr
}

/** Team + member fixtures shared by every case. `sso` teams get working SSO config. */
export async function seedTeams(conn: PgConnParams): Promise<void> {
  await runPsql(
    conn,
    `INSERT INTO auth.users (id, email) VALUES
       ('63180000-0000-0000-0000-0000000000f1', 'owner@example.test'),
       ('63180000-0000-0000-0000-0000000000f2', 'dep@example.test');
     INSERT INTO profiles (id, email, tier) VALUES
       ('63180000-0000-0000-0000-0000000000f1', 'owner@example.test', 'enterprise'),
       ('63180000-0000-0000-0000-0000000000f2', 'dep@example.test',   'community');
     INSERT INTO teams (id, name, owner_id) VALUES
       ('t-plain', 'Plain', '63180000-0000-0000-0000-0000000000f1'),
       ('t-sso',   'SSO',   '63180000-0000-0000-0000-0000000000f1'),
       ('t-sso2',  'SSO 2', '63180000-0000-0000-0000-0000000000f1');
     INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES
       ('t-plain', '63180000-0000-0000-0000-0000000000f1', 'owner', now()),
       ('t-sso',   '63180000-0000-0000-0000-0000000000f1', 'owner', now()),
       ('t-sso2',  '63180000-0000-0000-0000-0000000000f1', 'owner', now());
     INSERT INTO team_sso_settings (team_id, supabase_provider_id, status, reverify_days)
       VALUES ('t-sso',  '63180000-bbbb-0000-0000-0000000000f1', 'active', 7),
              ('t-sso2', '63180000-bbbb-0000-0000-0000000000f2', 'active', 7);
     INSERT INTO team_sso_domains (team_id, domain, verification_token, verified_at)
       VALUES ('t-sso',  'smi6318.example',  'tok', now()),
              ('t-sso2', 'smi6318b.example', 'tok', now());`
  )
}

export const OWNER_ID = '63180000-0000-0000-0000-0000000000f1'
export const DEPARTER_ID = '63180000-0000-0000-0000-0000000000f2'

/** Add the departer to a team, returning the generated team_members.id. */
export async function joinTeam(
  conn: PgConnParams,
  teamId: string,
  opts: { sso?: boolean; staleDays?: number } = {}
): Promise<string> {
  const via = opts.sso ? `'sso'` : 'NULL'
  const stale = opts.sso ? `now() - INTERVAL '${opts.staleDays ?? 30} days'` : 'NULL'
  const id = await queryScalar(
    conn,
    `INSERT INTO team_members (team_id, user_id, role, provisioned_via, sso_verified_at, joined_at)
     VALUES (:'team', :'user', 'member', ${via}, ${stale}, now())
     ON CONFLICT (team_id, user_id) DO UPDATE
       SET provisioned_via = EXCLUDED.provisioned_via,
           sso_verified_at = EXCLUDED.sso_verified_at
     RETURNING id;`,
    { team: teamId, user: DEPARTER_ID }
  )
  if (!id) throw new Error('SMI-6318 harness: team_members insert returned no id')
  return id
}

/** Call the REAL remove_team_member() RPC as the team owner, in the `authenticated` role. */
export async function departViaRpc(conn: PgConnParams, memberId: string): Promise<void> {
  await runPsql(
    conn,
    `BEGIN;
     SELECT set_config('request.jwt.claims',
       json_build_object('sub', :'owner', 'role', 'authenticated')::text, true);
     SET LOCAL ROLE authenticated;
     SELECT remove_team_member(:'member');
     RESET ROLE;
     COMMIT;`,
    { owner: OWNER_ID, member: memberId }
  )
}

/** Call the REAL expire_stale_sso_members() sweep; returns the expired count. */
export async function departViaSweep(conn: PgConnParams): Promise<number> {
  const raw = await queryScalar(conn, 'SELECT expire_stale_sso_members();')
  return Number(raw)
}

export interface PendingRow {
  departedTeamId: string | null
  scheduledPurgeAt: string
}

/** Every PENDING purge row for the departer, newest window first. */
export async function pendingRows(conn: PgConnParams): Promise<PendingRow[]> {
  const rows = await queryRows(
    conn,
    `SELECT departed_team_id, scheduled_purge_at
       FROM team_member_inventory_purge_schedule
      WHERE user_id = :'user' AND purged_at IS NULL AND cancelled_reason IS NULL
      ORDER BY scheduled_purge_at DESC;`,
    { user: DEPARTER_ID }
  )
  return rows.map((r) => ({ departedTeamId: nullable(r[0]), scheduledPurgeAt: r[1] }))
}

/** All purge rows for the departer, including resolved ones: [total, pending, cancelledReasons]. */
export async function rowCensus(
  conn: PgConnParams
): Promise<{ total: number; pending: number; reasons: string[] }> {
  const rows = await queryRows(
    conn,
    `SELECT count(*)::text,
            count(*) FILTER (WHERE purged_at IS NULL AND cancelled_reason IS NULL)::text,
            COALESCE(string_agg(cancelled_reason, ',' ORDER BY cancelled_reason), '')
       FROM team_member_inventory_purge_schedule WHERE user_id = :'user';`,
    { user: DEPARTER_ID }
  )
  const [total, pending, reasons] = rows[0]
  return {
    total: Number(total),
    pending: Number(pending),
    reasons: reasons ? reasons.split(',').filter(Boolean) : [],
  }
}

/** Shift the departer's pending row back in time, simulating an earlier departure. */
export async function backdatePending(conn: PgConnParams, days: number): Promise<void> {
  await runPsql(
    conn,
    `UPDATE team_member_inventory_purge_schedule
        SET scheduled_purge_at = scheduled_purge_at - make_interval(days => ${days}),
            created_at         = created_at - make_interval(days => ${days})
      WHERE user_id = :'user' AND purged_at IS NULL AND cancelled_reason IS NULL AND TRUE;`,
    { user: DEPARTER_ID }
  )
}

/** Days from now() until a row's scheduled_purge_at, as a float. */
export async function daysUntil(conn: PgConnParams, iso: string): Promise<number> {
  const raw = await queryScalar(
    conn,
    `SELECT EXTRACT(EPOCH FROM (:'ts'::timestamptz - now())) / 86400.0;`,
    { ts: iso }
  )
  return Number(raw)
}
