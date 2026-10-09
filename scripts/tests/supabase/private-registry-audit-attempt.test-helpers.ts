/**
 * SMI-6114 / SMI-6669 (ADR-178): live-Postgres harness for
 * `record_private_registry_audit_attempt()` and `registry_audit_volume_over_threshold()`
 * (migration 20261008000000).
 *
 * CONNECTION (five-var convention): SMI6114_TEST_PGHOST/PORT/USER/PASSWORD/DATABASE. From the
 * worktree's dev container, against a throwaway Postgres reachable as `host.docker.internal`:
 *
 *   ./scripts/worktree-docker.sh exec -- env SMI6114_TEST_PGHOST=host.docker.internal \
 *     SMI6114_TEST_PGPORT=15614 SMI6114_TEST_PGUSER=postgres SMI6114_TEST_PGPASSWORD=testpass \
 *     SMI6114_TEST_PGDATABASE=postgres npx vitest run scripts/tests/supabase/private-registry-audit-attempt
 *
 * REAL vs STUBBED. REAL (read verbatim from the repo at run time): THE ENTIRE NEW MIGRATION
 * (`migrationSql()`, so this suite also proves it applies and passes its own smoke block) and the
 * trigger function `audit_private_registry_skills_change()` (20260913000000) with its
 * `trg_prs_audit` trigger statement, which the monitor arm drives with a real INSERT. STUBBED:
 * `auth.uid()`/`auth.role()` (they read `request.jwt.claims` the way GoTrue's do, so "no sub claim"
 * is expressible); `teams` / `team_members` / `private_registry_skills` (minimal tables carrying the
 * columns the functions read, `teams.skill_namespace` NOT NULL UNIQUE as 20260727000000 makes it);
 * `audit_logs` / `schema_version` (001_initial_schema.sql's column sets). The stub also issues
 * `ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ... TO anon`, which hosted Supabase does implicitly:
 * without it `REVOKE ... FROM anon` would be a no-op and its red-test could not bite.
 *
 * @module scripts/tests/supabase/private-registry-audit-attempt.test-helpers
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractFunction, extractStatement, type TestConn, type PsqlSession } from './pg-session.ts'
import { readMigrationText } from '../lib/migration-text-guards.ts'

export { PsqlSession, type TestConn } from './pg-session.ts'

export const NEW_MIGRATION = '20261008000000_private_registry_audit_attempt_rpc.sql'
const TRIGGER_MIGRATION = '20260913000000_private_registry_audit_trigger.sql'
const TEAM_MIGRATION = '071_team_workspaces.sql'
const AUDIT_RLS_MIGRATION = '20260420020000_audit_logs_team_rls.sql'
const LABEL = 'SMI-6114'

// ============================================================================
// Connection env
// ============================================================================

export function testConnFromEnv(env: NodeJS.ProcessEnv = process.env): TestConn | null {
  const host = env.SMI6114_TEST_PGHOST
  const port = env.SMI6114_TEST_PGPORT
  const user = env.SMI6114_TEST_PGUSER
  const password = env.SMI6114_TEST_PGPASSWORD
  const database = env.SMI6114_TEST_PGDATABASE
  if (!host || !port || !user || !password || !database) return null
  return { host, port, user, password, database }
}

export const noLiveTestPg = !testConnFromEnv()

if (noLiveTestPg) {
  console.warn(
    '[smi6114-audit-attempt] no live test Postgres configured (SMI6114_TEST_PGHOST/PORT/USER/' +
      'PASSWORD/DATABASE unset), so the live-Postgres half of this suite (.pg.test.ts) will SKIP. ' +
      'The PG-free assertions live in the sibling .structural.test.ts, which has no Postgres gate. ' +
      'The skipped half is the ONLY coverage that executes the shipped function bodies.'
  )
}

export function requireTestConn(): TestConn {
  const conn = testConnFromEnv()
  if (!conn) throw new Error('SMI-6114: no live test Postgres configured (SMI6114_TEST_PG*).')
  return conn
}

export function migrationSql(): string {
  return readFileSync(join(process.cwd(), 'supabase/migrations', NEW_MIGRATION), 'utf8')
}

/** True when the migration is git-crypt ciphertext AND that was declared expected. */
export function migrationTextLocked(): boolean {
  return readMigrationText(NEW_MIGRATION) === null
}

// ============================================================================
// Fixture identities
// ============================================================================

export const U_MEMBER = '61140000-0000-0000-0000-000000000001' // member of TEAM_A
export const U_PEER = '61140000-0000-0000-0000-000000000002' // second member of TEAM_A
export const U_OUTSIDER = '61140000-0000-0000-0000-000000000003' // member of TEAM_B only
export const U_LONER = '61140000-0000-0000-0000-000000000004' // member of no team
export const U_ACTOR_A = '61140000-0000-0000-0000-00000000000a' // monitor: 201 client rows
export const U_ACTOR_B = '61140000-0000-0000-0000-00000000000b' // monitor: 5 client + trigger rows
export const TEAM_A = 'smi6114-team-a'
export const TEAM_B = 'smi6114-team-b'
export const NS_A = 'nsa6114'
export const NS_B = 'nsb6114'
/** Real approved skills, one per team, so a non-member / other-namespace call names something real. */
export const SKILL_A = `${NS_A}/real-skill`
export const SKILL_B = `${NS_B}/real-skill`

// ============================================================================
// Declarative expectation tables (never derived from the TypeScript audit module)
// ============================================================================

/** 28 accepted pairings: 5 mutations x 3 non-success (15) + list/get/namespace x 4 (12) + 1. */
export const ACCEPTED: ReadonlyArray<{ op: string; results: readonly string[] }> = [
  { op: 'publish', results: ['denied', 'not_found', 'error'] },
  { op: 'deprecate', results: ['denied', 'not_found', 'error'] },
  { op: 'undeprecate', results: ['denied', 'not_found', 'error'] },
  { op: 'approve', results: ['denied', 'not_found', 'error'] },
  { op: 'reject', results: ['denied', 'not_found', 'error'] },
  { op: 'list', results: ['success', 'denied', 'not_found', 'error'] },
  { op: 'get', results: ['success', 'denied', 'not_found', 'error'] },
  { op: 'namespace', results: ['success', 'denied', 'not_found', 'error'] },
  { op: 'content_read', results: ['error'] },
]
/** 8 refused (22023): 5 mutation+success, 3 non-error content_read. */
export const REFUSED: ReadonlyArray<readonly [string, string]> = [
  ['publish', 'success'],
  ['deprecate', 'success'],
  ['undeprecate', 'success'],
  ['approve', 'success'],
  ['reject', 'success'],
  ['content_read', 'success'],
  ['content_read', 'denied'],
  ['content_read', 'not_found'],
]
export const ALL_OPERATIONS: readonly string[] = ACCEPTED.map((a) => a.op)
/** list and namespace are called with a NULL p_skill_id; every other operation names a skill. */
export const TAKES_SKILL = (op: string): boolean => op !== 'list' && op !== 'namespace'

/** Exact metadata key set the RPC writes (20 keys). `team_id` is deliberately absent. */
export const EXPECTED_KEYS: readonly string[] = [
  'actor_user_id',
  'audit_source',
  'audit_writer',
  'auth_path',
  'auth_role',
  'content_hash',
  'db_session_user',
  'detail',
  'file_count',
  'license_key_fingerprint',
  'member_visible',
  'published_by_available',
  'registry_team_id',
  'requested_content_hash',
  'requested_skill_id',
  'requested_team_id',
  'requested_version',
  'skill_id',
  'transport',
  'version',
]
export const EXPECTED_ARGNAMES: readonly string[] = [
  'p_operation',
  'p_result',
  'p_skill_id',
  'p_version',
  'p_detail',
  'p_file_count',
  'p_content_hash',
  'p_team_id',
  'p_license_key_fingerprint',
  'p_auth_role',
]

// ============================================================================
// Schema + fixtures
// ============================================================================

export function claims(uid: string | null): string {
  const body = uid === null ? '{"role":"authenticated"}' : `{"sub":"${uid}","role":"authenticated"}`
  return `SELECT set_config('request.jwt.claims', '${body}', false);`
}

export function baseSchemaSql(): string {
  const fn = extractFunction(TRIGGER_MIGRATION, 'audit_private_registry_skills_change', LABEL)
  return `
RESET ROLE;
SET TIME ZONE 'UTC';
DO $roles$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $roles$;

DROP SCHEMA IF EXISTS auth CASCADE;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $au$
  SELECT nullif((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'), '')::uuid;
$au$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $ar$
  SELECT nullif((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'), '');
$ar$;

DROP TABLE IF EXISTS audit_logs, private_registry_skills, team_members, teams, schema_version CASCADE;
DROP FUNCTION IF EXISTS audit_private_registry_skills_change() CASCADE;
DROP FUNCTION IF EXISTS user_team_ids() CASCADE;
DROP FUNCTION IF EXISTS public.record_private_registry_audit_attempt(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT) CASCADE;
DROP FUNCTION IF EXISTS public.registry_audit_volume_over_threshold(INTEGER, TIMESTAMPTZ) CASCADE;

CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, skill_namespace TEXT NOT NULL UNIQUE);
CREATE TABLE team_members (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id UUID NOT NULL, role TEXT NOT NULL DEFAULT 'member', UNIQUE (team_id, user_id)
);
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, event_type TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(), actor TEXT, resource TEXT, action TEXT, result TEXT,
  metadata JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE private_registry_skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL CHECK (skill_id ~ '^[^/]+/[^/]+$'), version TEXT NOT NULL,
  description TEXT, content JSONB NOT NULL, content_hash TEXT NOT NULL,
  deprecated BOOLEAN NOT NULL DEFAULT FALSE, published_by UUID,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approval_status TEXT NOT NULL DEFAULT 'approved', approval_mode TEXT NOT NULL DEFAULT 'auto',
  approved_by UUID, approved_at TIMESTAMPTZ, review_note TEXT, UNIQUE (team_id, skill_id, version)
);

-- Hosted Supabase grants EXECUTE on every new public function to anon/authenticated/service_role
-- by default; without this the migration's REVOKE ... FROM anon would have nothing to revoke.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

${fn}

-- REAL user_team_ids() (071) and the REAL audit_logs_team_scoped_read policy (20260420020000), with
-- RLS enabled on the stub audit_logs. authenticated needs table SELECT first (hosted Supabase's
-- default privileges give it); RLS then does the filtering this suite's visibility arm measures.
${realTeamHelper()}
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON TABLE audit_logs TO authenticated;
${extractStatement(AUDIT_RLS_MIGRATION, /CREATE POLICY audit_logs_team_scoped_read/, LABEL)}
`
}

function realTeamHelper(): string {
  return [
    extractFunction(TEAM_MIGRATION, 'user_team_ids', LABEL),
    extractStatement(TEAM_MIGRATION, /GRANT EXECUTE ON FUNCTION user_team_ids\(\)/, LABEL),
  ].join('\n\n')
}

/** The REAL `CREATE OR REPLACE TRIGGER trg_prs_audit` statement (row-level; not the TRUNCATE one). */
export function realAuditTriggerSql(): string {
  return extractStatement(
    TRIGGER_MIGRATION,
    /CREATE OR REPLACE TRIGGER trg_prs_audit\s+AFTER INSERT/,
    LABEL
  )
}

export function fixtureSql(): string {
  return `
RESET ROLE;
SET TIME ZONE 'UTC';
DROP TRIGGER IF EXISTS trg_prs_audit ON private_registry_skills;
DELETE FROM private_registry_skills;
DELETE FROM team_members;
DELETE FROM teams;
DELETE FROM audit_logs;
INSERT INTO teams (id, name, skill_namespace) VALUES
  ('${TEAM_A}', 'Team A', '${NS_A}'), ('${TEAM_B}', 'Team B', '${NS_B}');
INSERT INTO team_members (team_id, user_id, role) VALUES
  ('${TEAM_A}', '${U_MEMBER}', 'member'), ('${TEAM_A}', '${U_PEER}', 'admin'),
  ('${TEAM_B}', '${U_OUTSIDER}', 'member');
INSERT INTO private_registry_skills (team_id, skill_id, version, content, content_hash) VALUES
  ('${TEAM_A}', '${SKILL_A}', '1.0.0', '{"SKILL.md":"a"}'::jsonb, 'hash-a'),
  ('${TEAM_B}', '${SKILL_B}', '1.0.0', '{"SKILL.md":"b"}'::jsonb, 'hash-b');
DELETE FROM audit_logs;
`
}

// ============================================================================
// Call + read helpers
// ============================================================================

export type Arg = string | number | null | undefined
export interface AttemptArgs {
  operation?: Arg
  result?: Arg
  skillId?: Arg
  version?: Arg
  detail?: Arg
  fileCount?: Arg
  contentHash?: Arg
  teamId?: Arg
  fingerprint?: Arg
  authRole?: Arg
}
const PARAM: Record<keyof AttemptArgs, string> = {
  operation: 'p_operation',
  result: 'p_result',
  skillId: 'p_skill_id',
  version: 'p_version',
  detail: 'p_detail',
  fileCount: 'p_file_count',
  contentHash: 'p_content_hash',
  teamId: 'p_team_id',
  fingerprint: 'p_license_key_fingerprint',
  authRole: 'p_auth_role',
}

export function lit(v: Arg): string {
  if (v === null || v === undefined) return 'NULL'
  return typeof v === 'number' ? String(v) : `'${v.replace(/'/g, "''")}'`
}

/** `undefined` omits the parameter (uses its DEFAULT); `null` passes an explicit NULL. */
export function attemptSql(a: AttemptArgs): string {
  const parts = (Object.keys(PARAM) as Array<keyof AttemptArgs>)
    .filter((k) => a[k] !== undefined)
    .map((k) => `${PARAM[k]} => ${lit(a[k])}${k === 'fileCount' ? '::integer' : ''}`)
  return `SELECT public.record_private_registry_audit_attempt(${parts.join(', ')});`
}

export async function callAs(
  ctl: PsqlSession,
  role: 'authenticated' | 'anon' | 'service_role',
  uid: string | null,
  sql: string
): Promise<{ stdout: string; stderr: string }> {
  await ctl.send(`SET ROLE ${role};`)
  try {
    await ctl.send(claims(uid))
    return await ctl.send(sql)
  } finally {
    await ctl.send('RESET ROLE;')
  }
}

export const attempt = (ctl: PsqlSession, uid: string | null, a: AttemptArgs) =>
  callAs(ctl, 'authenticated', uid, attemptSql(a))

export interface Snapshot {
  n: number
  eventType: string
  actor: string
  resource: string
  action: string
  result: string
  noTeamIdKey: boolean
  jsonNullSkillId: boolean
  jsonNullVersion: boolean
  jsonNullContentHash: boolean
  hasRequestedSkillId: boolean
  hasRequestedVersion: boolean
  hasRequestedContentHash: boolean
  hasRequestedTeamId: boolean
  hasAuditSource: boolean
  keys: string[]
  md: Record<string, unknown>
}

/** One row (plus the matching-row count) selected by `where`, with the presence/absence flags
 *  computed BY POSTGRES (`?`, `->` = 'null'::jsonb) in the same query that selects the row, so an
 *  absence flag can never come from an empty result. Null when nothing matched. */
export async function snapshot(ctl: PsqlSession, where: string): Promise<Snapshot | null> {
  const k = (key: string) => `al.metadata ? '${key}'`
  const jn = (key: string) => `(al.metadata ? '${key}' AND al.metadata->'${key}' = 'null'::jsonb)`
  const res = await ctl.send(`SELECT jsonb_build_object(
    'n', (SELECT count(*) FROM audit_logs al WHERE ${where}),
    'eventType', al.event_type, 'actor', al.actor, 'resource', al.resource,
    'action', al.action, 'result', al.result,
    'noTeamIdKey', NOT (${k('team_id')}),
    'jsonNullSkillId', ${jn('skill_id')}, 'jsonNullVersion', ${jn('version')},
    'jsonNullContentHash', ${jn('content_hash')},
    'hasRequestedSkillId', ${k('requested_skill_id')}, 'hasRequestedVersion', ${k('requested_version')},
    'hasRequestedContentHash', ${k('requested_content_hash')},
    'hasRequestedTeamId', ${k('requested_team_id')}, 'hasAuditSource', ${k('audit_source')},
    'keys', (SELECT jsonb_agg(x ORDER BY x) FROM jsonb_object_keys(al.metadata) x),
    'md', al.metadata)
  FROM audit_logs al WHERE ${where} ORDER BY al.created_at LIMIT 1;`)
  if (res.stderr.includes('ERROR')) throw new Error(`snapshot failed:\n${res.stderr}`)
  const line = res.stdout.split('\n').find((l) => l.startsWith('{'))
  return line ? (JSON.parse(line) as Snapshot) : null
}

/** Shared by the arm modules: the control session plus rebuild/reload of the schema. */
export interface Ctx {
  ctl: () => PsqlSession
  /** Rebuild base schema + the given migration text, then reload fixtures. */
  rebuild: (migrationText: string, opts?: { expectSelfSmokeFailure?: RegExp }) => Promise<void>
}

export const byDetail = (detail: string) => `al.metadata->>'detail' = '${detail}'`

export function sqlstate(res: { stderr: string }): string | null {
  const m = /ERROR:\s+([0-9A-Z]{5}):/.exec(res.stderr)
  return m ? m[1] : null
}
export function scalar(stdout: string): string | null {
  const l = stdout.split('\n').find((x) => x.trim().length > 0)
  return l === undefined ? null : l.trim()
}
