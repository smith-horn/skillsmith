/**
 * SMI-6345 Wave 1 Step 4: live-Postgres harness for the per-device lock protocol
 * (ADR-144 §9) and the SMI-6353 provenance regression.
 *
 * WHY THIS EXISTS AT ALL. Every property under test here is invisible to a single
 * session. `SELECT ... FOR UPDATE` and a plain `SELECT` return the identical value, in
 * the identical shape, to a session with no competitor — which is exactly how
 * reconcile_device_inventory() shipped for months holding only an INCIDENTAL lock that
 * nothing documented and nothing tested. Proving the protocol requires TWO REAL,
 * SIMULTANEOUS Postgres sessions with a controlled interleaving.
 *
 * CONNECTION. Same five-env-var convention, and the same deliberate refusal to touch
 * the pooler or any shared environment, as the sibling SMI-6321 harness:
 *
 *   SMI6345_TEST_PGHOST / SMI6345_TEST_PGPORT / SMI6345_TEST_PGUSER /
 *   SMI6345_TEST_PGPASSWORD / SMI6345_TEST_PGDATABASE
 *
 * Stand one up and run the suite:
 *
 *   docker run -d --name smi6345-devicelock-test-pg -e POSTGRES_PASSWORD=testpass \
 *     -e POSTGRES_DB=postgres -p 15645:5432 postgres:15-alpine
 *   SMI6345_TEST_PGHOST=host.docker.internal SMI6345_TEST_PGPORT=15645 \
 *   SMI6345_TEST_PGUSER=postgres SMI6345_TEST_PGPASSWORD=testpass \
 *   SMI6345_TEST_PGDATABASE=postgres \
 *     npx vitest run scripts/tests/supabase/inventory-device-lock.pg.test.ts
 *
 * `host.docker.internal` because the suite runs INSIDE the worktree's own dev container,
 * which has no docker CLI, so the sibling Postgres is provisioned from the host and
 * reached through the Docker Desktop gateway.
 *
 * NO CI COVERAGE YET, STATED PLAINLY. CI provisions no Postgres service and sets none of
 * these vars, so this suite skips there — loudly, never silently (see
 * {@link noLiveTestPg}). Same known, tracked gap SMI-5946 already covers for the smi5879
 * and SMI-6321 suites; this is a third consumer of that gap, not a new one.
 *
 * SCHEMA. Minimal by hand, REAL where it matters:
 *   - The three function bodies (resolve_inventory_sync_consent,
 *     reconcile_device_inventory, purge_user_inventory) are EXTRACTED VERBATIM from the
 *     shipped migrations at run time, latest-definition-wins. A body that stops taking
 *     the lock, or that stops threading author/license/repository, fails these tests
 *     rather than quietly passing against a stale copy.
 *   - The identity columns and the identity audit table are likewise EXTRACTED from
 *     20260901140000, so their CHECK constraints under test are the shipped ones.
 *   - Table definitions for user_devices / device_skills mirror
 *     20260626000001_user_inventory.sql (+ 20260629000001's provenance columns) by hand,
 *     because their real definitions are entangled with RLS, grants and a read RPC that
 *     none of these tests exercise. The PK and the composite FK — the two structures the
 *     lock's fail-closed behaviour actually depends on — are reproduced exactly.
 *
 * auth.uid(). Reproduced faithfully (GUC-driven, both arms, exactly as GoTrue defines
 * it) so each psql session can act as a different user. 20260707000003's header records
 * that this codebase does not fake auth.uid() inside MIGRATIONS — that constraint is
 * about apply-time smoke blocks, where a GUC trick would be unreviewable machinery in
 * production DDL. Here it is the whole point: two sessions must be two different callers.
 *
 * @module scripts/tests/supabase/inventory-device-lock.test-helpers
 */

import {
  PsqlSession,
  extractLatestFunction,
  extractStatement,
  type TestConn,
} from './pg-session.ts'

export { PsqlSession, type TestConn } from './pg-session.ts'

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(() => r(), ms))

const LABEL = 'SMI-6345'

/** The migration this wave adds the identity columns + audit table in. */
export const IDENTITY_MIGRATION = '20260901140000_device_skills_identity_columns.sql'

export function testConnFromEnv(env: NodeJS.ProcessEnv = process.env): TestConn | null {
  const host = env.SMI6345_TEST_PGHOST
  const port = env.SMI6345_TEST_PGPORT
  const user = env.SMI6345_TEST_PGUSER
  const password = env.SMI6345_TEST_PGPASSWORD
  const database = env.SMI6345_TEST_PGDATABASE
  if (!host || !port || !user || !password || !database) return null
  return { host, port, user, password, database }
}

export const noLiveTestPg = !testConnFromEnv()

if (noLiveTestPg) {
  console.warn(
    '[smi6345-device-lock] SKIPPED: no live test Postgres configured ' +
      '(SMI6345_TEST_PGHOST/PORT/USER/PASSWORD/DATABASE unset). This suite is the ONLY ' +
      'coverage that can distinguish reconcile_device_inventory holding the ADR-144 §9 ' +
      'per-device lock from it holding nothing — a single-session test cannot. Not covered ' +
      'by CI either (see SMI-5946). Run the docker one-liner in this file to exercise it.'
  )
}

export function requireTestConn(): TestConn {
  const conn = testConnFromEnv()
  if (!conn) {
    throw new Error(
      'SMI-6345: no live test Postgres configured. Set SMI6345_TEST_PGHOST/PORT/USER/' +
        'PASSWORD/DATABASE — see this file for a docker run one-liner.'
    )
  }
  return conn
}

export const OWNER = '63450000-0000-0000-0000-000000000001'
export const OTHER_USER = '63450000-0000-0000-0000-000000000002'
export const DEVICE = '6345dddd-0000-0000-0000-000000000001'
/** Never inserted by the fixture — the "unknown device, first push" cases (C-4) mint it. */
export const NEW_DEVICE = '6345dddd-0000-0000-0000-0000000000f1'

/**
 * Read-only assertions run from the control session. Kept here rather than in the suite
 * so the suite stays about interleavings; `scalar()` throws on a failed control query
 * rather than returning a misleading empty string, because a silently-broken assertion
 * query would make every expectation below it pass for the wrong reason.
 */
export class InventoryProbe {
  constructor(private readonly ctl: PsqlSession) {}

  /** Present/absent state of one device, as ordered `skill_id:t|f` pairs. */
  async skillState(deviceId = DEVICE): Promise<string> {
    return this.scalar(
      `SELECT string_agg(skill_id || ':' || CASE WHEN present THEN 't' ELSE 'f' END,
                         ',' ORDER BY skill_id)
         FROM device_skills WHERE device_id = '${deviceId}';`
    )
  }

  async scalar(sql: string): Promise<string> {
    const { stdout, stderr } = await this.ctl.send(sql)
    if (/ERROR/.test(stderr)) throw new Error(`control query failed:\n${sql}\n${stderr}`)
    return stdout
  }

  /** Snapshot every row's last_seen_at so monotonicity can be asserted, not assumed. */
  async snapshotLastSeen(): Promise<void> {
    await this.ctl.send(
      `DROP TABLE IF EXISTS ls_snapshot;
       CREATE TEMP TABLE ls_snapshot AS
         SELECT device_id, harness, skill_id, last_seen_at FROM device_skills;`
    )
  }

  /** How many rows moved BACKWARDS in last_seen_at since the snapshot. Must be zero. */
  async lastSeenRegressions(): Promise<string> {
    return this.scalar(
      `SELECT count(*) FROM device_skills ds
         JOIN ls_snapshot s
           ON s.device_id = ds.device_id AND s.harness = ds.harness AND s.skill_id = ds.skill_id
        WHERE ds.last_seen_at < s.last_seen_at;`
    )
  }
}

export interface SkillRow {
  harness?: string
  skill_id: string
  version?: string | null
  source?: string | null
  author?: string | null
  license?: string | null
  repository?: string | null
  content_hash?: string | null
  pinned_version?: string | null
  update_policy?: string | null
}

/** Build the `reconcile_device_inventory(p_device, p_skills)` call for one push. */
export function reconcileSql(deviceId: string, skills: SkillRow[], label = 'box'): string {
  const payload = skills.map((s) => ({
    harness: s.harness ?? 'claude-code',
    skill_id: s.skill_id,
    version: s.version ?? '1.0.0',
    source: s.source ?? null,
    author: s.author ?? null,
    license: s.license ?? null,
    repository: s.repository ?? null,
    content_hash: s.content_hash ?? null,
    pinned_version: s.pinned_version ?? null,
    update_policy: s.update_policy ?? null,
  }))
  const device = JSON.stringify({ device_id: deviceId, label })
  return (
    `SELECT reconcile_device_inventory('${device}'::jsonb, ` +
    `'${JSON.stringify(payload)}'::jsonb);`
  )
}

/**
 * Make this session act as `userId`. Mirrors what PostgREST does per request; the
 * reproduced auth.uid() below reads it.
 */
export function asUser(userId: string): string {
  return `SELECT set_config('request.jwt.claims', '{"sub":"${userId}"}', false);`
}

/**
 * Minimal schema + the REAL function bodies and the REAL identity DDL.
 *
 * Note the deliberate omission of RLS and grants: every session here connects as the
 * table owner, so policies would not be exercised anyway, and the properties under test
 * (lock strength, FK fail-closed behaviour, set-reconciliation, constraint enforcement)
 * are all RLS-independent. The owner-scoping these functions actually rely on is their
 * explicit `auth.uid()` predicate, which IS exercised.
 */
export function schemaSql(): string {
  return `
DROP SCHEMA IF EXISTS auth CASCADE;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id UUID PRIMARY KEY, email TEXT);

-- Faithful reproduction of GoTrue's auth.uid(), both arms, so each psql session can act
-- as a different authenticated caller.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $auid$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.sub', true), ''),
    (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid;
$auid$;

DROP TABLE IF EXISTS device_skills_identity_audit CASCADE;
DROP TABLE IF EXISTS device_skills CASCADE;
DROP TABLE IF EXISTS user_devices CASCADE;
DROP TABLE IF EXISTS user_telemetry_preferences CASCADE;
DROP TABLE IF EXISTS audit_logs CASCADE;
DROP TABLE IF EXISTS profiles CASCADE;

CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  tier TEXT NOT NULL DEFAULT 'community',
  role TEXT NOT NULL DEFAULT 'user',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_telemetry_preferences (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  inventory_sync_enabled BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE audit_logs (
  id BIGSERIAL PRIMARY KEY, event_type TEXT, actor TEXT, resource TEXT, action TEXT,
  result TEXT, metadata JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Mirrors 20260626000001_user_inventory.sql. The UNIQUE (device_id, user_id) is what the
-- device_skills composite FK targets, and is load-bearing for the fail-closed behaviour
-- the lock provides.
CREATE TABLE user_devices (
  device_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label            TEXT,
  hostname_display TEXT,
  hostname_hash    TEXT,
  platform         TEXT,
  arch             TEXT,
  cli_version      TEXT,
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_devices_id_user_key UNIQUE (device_id, user_id)
);

-- Mirrors 20260626000001 (+ 20260629000001's three self-asserted provenance columns).
-- device_skills is the ONLY table referencing user_devices — the fact that makes
-- FOR UPDATE the right lock strength here (ADR-144 §9), and the reason a concurrent
-- device_skills INSERT is what the lock fails closed against.
CREATE TABLE device_skills (
  user_id        UUID NOT NULL,
  device_id      UUID NOT NULL,
  harness        TEXT NOT NULL CHECK (char_length(harness) > 0 AND char_length(harness) <= 32),
  skill_id       TEXT NOT NULL CHECK (char_length(skill_id) > 0 AND char_length(skill_id) <= 255),
  version        TEXT,
  source         TEXT,
  content_hash   TEXT,
  pinned_version TEXT,
  update_policy  TEXT CHECK (update_policy IS NULL OR update_policy IN ('auto', 'manual', 'never')),
  author         TEXT CHECK (author IS NULL OR char_length(author) <= 200),
  license        TEXT CHECK (license IS NULL OR char_length(license) <= 64),
  repository     TEXT CHECK (repository IS NULL OR char_length(repository) <= 512),
  present        BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (device_id, harness, skill_id),
  CONSTRAINT device_skills_device_owner_fk
    FOREIGN KEY (device_id, user_id) REFERENCES user_devices (device_id, user_id) ON DELETE CASCADE
);

-- The SHIPPED identity DDL, extracted rather than transcribed, so a migration that
-- tightens or loosens one of these CHECKs changes what these tests execute.
${extractStatement(IDENTITY_MIGRATION, /ALTER TABLE device_skills\b/, LABEL)}

${extractStatement(IDENTITY_MIGRATION, /CREATE TABLE IF NOT EXISTS device_skills_identity_audit\b/, LABEL)}

${extractLatestFunction('resolve_inventory_sync_consent', LABEL)}

${extractLatestFunction('reconcile_device_inventory', LABEL)}

${extractLatestFunction('purge_user_inventory', LABEL)}
`
}

/**
 * Baseline state for every test: two consenting users, one device owned by OWNER
 * carrying two skills — one of them already holding a resolved identity, so any test
 * can assert that a reconcile does NOT clobber identity columns (ADR-144 §4 rule 2's
 * stickiness, which Wave 2's whole demotion design depends on).
 */
export function fixtureSql(): string {
  return `
DELETE FROM device_skills_identity_audit;
DELETE FROM device_skills;
DELETE FROM user_devices;
DELETE FROM user_telemetry_preferences;
DELETE FROM audit_logs;
DELETE FROM profiles;
DELETE FROM auth.users;

INSERT INTO auth.users (id, email) VALUES
  ('${OWNER}', 'smi6345-owner@example.test'),
  ('${OTHER_USER}', 'smi6345-other@example.test');
INSERT INTO profiles (id, email, tier, role) VALUES
  ('${OWNER}', 'smi6345-owner@example.test', 'community', 'user'),
  ('${OTHER_USER}', 'smi6345-other@example.test', 'community', 'user');
INSERT INTO user_telemetry_preferences (user_id, inventory_sync_enabled) VALUES
  ('${OWNER}', TRUE), ('${OTHER_USER}', TRUE);

INSERT INTO user_devices (device_id, user_id, label, last_seen_at)
VALUES ('${DEVICE}', '${OWNER}', 'fixture-box', now());

INSERT INTO device_skills
  (user_id, device_id, harness, skill_id, version, present, last_seen_at,
   canonical_skill_id, identity_evidence, identity_resolved_at, evidence_protocol)
VALUES
  ('${OWNER}', '${DEVICE}', 'claude-code', 'alpha', '1.0.0', TRUE, now(),
   NULL, 'unresolved', NULL, NULL),
  ('${OWNER}', '${DEVICE}', 'claude-code', 'beta', '1.0.0', TRUE, now(),
   'acme/beta', 'manifest', now(), 1);
`
}
