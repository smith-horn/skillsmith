/**
 * SMI-5930 Wave 1 Step 4: shared setup/fixture harness for
 * `skill-name-change-trigger.test.ts`, split out to keep the test file
 * itself under the 500-line gate (`scripts/check-file-length.mjs`).
 *
 * This reuses `scripts/indexer/smi5879-census.pg.ts` — a generic
 * shell-out-to-`psql` harness (the name is SMI-5879-scoped, the
 * implementation is not: `runPsql`/`queryRows`/`queryScalar`/
 * `testConnParamsFromEnv`/`PgConnParams` have no SMI-5879-specific logic).
 * Per `scripts/tests/indexer/smi5879-census.test-helpers.ts`'s own header,
 * this repo has NO other live-Postgres test harness
 * (`scripts/tests/private-registry-rls.test.ts` documents the same gap), so
 * reusing this module — rather than inventing a second one — is this
 * repo's actual existing convention for "run raw multi-statement SQL
 * against Postgres."
 *
 * Connection: five env vars, never the pooler, never staging/prod:
 *   SMI5879_TEST_PGHOST / SMI5879_TEST_PGPORT / SMI5879_TEST_PGUSER /
 *   SMI5879_TEST_PGPASSWORD / SMI5879_TEST_PGDATABASE
 * (Reusing the SMI-5879 suite's own env var names rather than minting a
 * parallel SMI-5930-prefixed set — both suites can point at the SAME
 * ephemeral Postgres instance safely, since each test file works in its
 * own schema; see resetSchema() below.) Standup:
 *
 *   docker run -d --name smi5879-census-test-pg -e POSTGRES_PASSWORD=testpass \
 *     -e POSTGRES_DB=postgres -p 15499:5432 postgres:15-alpine
 *   SMI5879_TEST_PGHOST=host.docker.internal SMI5879_TEST_PGPORT=15499 \
 *   SMI5879_TEST_PGUSER=postgres SMI5879_TEST_PGPASSWORD=testpass \
 *   SMI5879_TEST_PGDATABASE=postgres npx vitest run scripts/tests/indexer/skill-name-change-trigger.test.ts
 *
 * `host.docker.internal` because this suite runs INSIDE the worktree's own
 * dev container (no docker-in-docker), so a sibling Postgres container must
 * be provisioned from the HOST and reached via the Docker Desktop host
 * gateway.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  runPsql,
  queryRows,
  queryScalar,
  testConnParamsFromEnv,
  type PgConnParams,
} from '../../indexer/smi5879-census.pg.ts'

const MIGRATION_PATH = join(
  process.cwd(),
  'supabase/migrations/20260811000000_skill_name_change_rekey_trigger.sql'
)

export const prePushNoLiveTestPg = !testConnParamsFromEnv()

/**
 * Idempotent, race-safe `anon`/`authenticated` role creation — needed because
 * the shipped migration's `REVOKE EXECUTE ON FUNCTION rekey_skill_name_dependents()
 * FROM anon, authenticated;` (audit:standards Check 52 / SMI-5526 fix; see the
 * migration's "Deviation 3" header note) fails with "role does not exist" on a
 * bare ephemeral Postgres, which has neither role. Roles are cluster-global
 * (not per-schema), so if this suite ever runs alongside another live-Postgres
 * test file against the SAME instance, a plain existence-check-then-CREATE
 * would race. Mirrors `smi5879-census.test-helpers.ts`'s own `CREATE_ROLES_SQL`
 * (identical advisory-lock shape, confirmed live there to be necessary — a
 * first attempt without the lock hit `duplicate key value violates unique
 * constraint "pg_authid_rolname_index"` under concurrent test files) — not
 * re-exported from that file, so duplicated here rather than introducing a
 * cross-suite import for a few lines of setup SQL.
 */
const CREATE_ROLES_SQL = `
DO $$
DECLARE
  v_lock_key bigint := hashtext('smi5930_rekey_trigger_create_roles');
BEGIN
  PERFORM pg_advisory_lock(v_lock_key);
  BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
      CREATE ROLE anon NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
      CREATE ROLE authenticated NOLOGIN;
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
 * Minimal fixtures for the three tables `rekey_skill_name_dependents()`
 * touches — only the columns/constraints relevant to its own logic, not a
 * verbatim copy of the shipped tables (which carry `auth.users`/
 * `team_workspaces` foreign keys that don't exist on a bare ephemeral
 * Postgres instance). Column names, NOT NULL-ness, and the `skill_id`/
 * `source_key` CHECK shapes match the real migrations
 * (071_team_workspaces.sql:129-135,
 * 20260726000000_skill_update_drift_detection.sql:218-233) exactly, since
 * those are what the trigger's own predicates depend on.
 */
const CREATE_FIXTURES_SQL = `
CREATE TABLE skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author TEXT NOT NULL,
  name TEXT NOT NULL,
  content_hash TEXT
);

CREATE TABLE workspace_skills (
  workspace_id UUID NOT NULL,
  skill_id     TEXT NOT NULL CHECK (skill_id ~ '^[^/]+/[^/]+$'),
  added_by     UUID,
  added_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, skill_id)
);

CREATE TABLE skill_update_notifications_sent (
  user_id            UUID NOT NULL,
  source_key         TEXT NOT NULL
                       CHECK (char_length(source_key) <= 128
                              AND (source_key = 'public' OR source_key LIKE 'team:%')),
  skill_id           TEXT NOT NULL
                       CHECK (char_length(skill_id) > 0 AND char_length(skill_id) <= 255),
  last_notified_hash TEXT NOT NULL
                       CHECK (char_length(last_notified_hash) > 0
                              AND char_length(last_notified_hash) <= 128),
  last_notified_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, source_key, skill_id)
);
`

/**
 * Full reset, scoped to `schemaName` rather than `public` — vitest's
 * default file-level parallelism means a shared `public` schema would race
 * against sibling test files' own `DROP SCHEMA ... CASCADE` calls
 * (confirmed live by `smi5879-census.test-helpers.ts`'s `resetSchema` doc
 * comment for the identical shape of race). Applies the REAL shipped
 * migration file from disk (not a hand-copied duplicate) plus the minimal
 * fixtures above.
 *
 * The migration text's one functional `SET search_path = public, pg_temp`
 * (on the SECURITY DEFINER function — see the migration's own "Deviation 2"
 * header note for why it's SECURITY DEFINER at all) is mechanically
 * substituted to `schemaName` so the function resolves `workspace_skills`/
 * `skill_update_notifications_sent` inside THIS test's schema at trigger-fire
 * time, not the real `public` schema (a SECURITY DEFINER function's
 * `SET search_path` is pinned at EXECUTION time, independent of the caller's
 * session search_path — without this substitution the trigger would throw
 * "relation does not exist" the moment it actually fires). This mirrors
 * `smi5879-census.test-helpers.ts:233`'s identical substitution for its own
 * `SET search_path = pg_catalog, public`-pinned functions.
 */
export async function resetSchema(conn: PgConnParams, schemaName: string): Promise<PgConnParams> {
  await runPsql(conn, CREATE_ROLES_SQL)
  await runPsql(
    conn,
    `DROP SCHEMA IF EXISTS "${schemaName}" CASCADE; CREATE SCHEMA "${schemaName}";`
  )
  const scoped: PgConnParams = { ...conn, searchPath: `${schemaName},public` }
  await runPsql(scoped, CREATE_FIXTURES_SQL)
  const migrationSql = readFileSync(MIGRATION_PATH, 'utf8').replace(/\bpublic\b/g, schemaName)
  await runPsql(scoped, migrationSql)
  return scoped
}

/** Insert a `skills` fixture row; returns its generated id. */
export async function insertSkill(
  conn: PgConnParams,
  author: string,
  name: string
): Promise<string> {
  const id = await queryScalar(
    conn,
    `INSERT INTO skills (author, name) VALUES (:'author', :'name') RETURNING id::text;`,
    { author, name }
  )
  if (!id) throw new Error('SMI-5930 test: skills fixture insert returned no id')
  return id
}

/** Insert a `workspace_skills` fixture row. */
export async function insertWorkspaceSkill(
  conn: PgConnParams,
  params: { workspaceId: string; skillId: string; addedBy?: string; addedAt?: string }
): Promise<void> {
  const { workspaceId, skillId, addedBy = randomUUID(), addedAt = '2020-01-01T00:00:00Z' } = params
  await runPsql(
    conn,
    `INSERT INTO workspace_skills (workspace_id, skill_id, added_by, added_at)
     VALUES (:'workspace_id'::uuid, :'skill_id', :'added_by'::uuid, :'added_at'::timestamptz);`,
    { workspace_id: workspaceId, skill_id: skillId, added_by: addedBy, added_at: addedAt }
  )
}

/** Insert a `skill_update_notifications_sent` fixture row. */
export async function insertNotification(
  conn: PgConnParams,
  params: {
    userId: string
    sourceKey?: string
    skillId: string
    lastNotifiedHash?: string
    lastNotifiedAt?: string
  }
): Promise<void> {
  const {
    userId,
    sourceKey = 'public',
    skillId,
    lastNotifiedHash = 'hash-' + randomUUID(),
    lastNotifiedAt = '2020-01-01T00:00:00Z',
  } = params
  await runPsql(
    conn,
    `INSERT INTO skill_update_notifications_sent
       (user_id, source_key, skill_id, last_notified_hash, last_notified_at)
     VALUES (:'user_id'::uuid, :'source_key', :'skill_id', :'last_notified_hash', :'last_notified_at'::timestamptz);`,
    {
      user_id: userId,
      source_key: sourceKey,
      skill_id: skillId,
      last_notified_hash: lastNotifiedHash,
      last_notified_at: lastNotifiedAt,
    }
  )
}

/** Row shape returned by {@link fetchWorkspaceSkill}. */
export interface WorkspaceSkillRow {
  addedBy: string
  addedAtEpoch: string
}

/** Fetch a `workspace_skills` row's identity-preserving columns, or null if absent. */
export async function fetchWorkspaceSkill(
  conn: PgConnParams,
  workspaceId: string,
  skillId: string
): Promise<WorkspaceSkillRow | null> {
  const rows = await queryRows(
    conn,
    `SELECT added_by::text, extract(epoch from added_at)::bigint::text
       FROM workspace_skills WHERE workspace_id = :'workspace_id'::uuid AND skill_id = :'skill_id';`,
    { workspace_id: workspaceId, skill_id: skillId }
  )
  if (rows.length === 0) return null
  return { addedBy: rows[0][0], addedAtEpoch: rows[0][1] }
}

/** Row shape returned by {@link fetchNotification}. */
export interface NotificationRow {
  lastNotifiedHash: string
  lastNotifiedAtEpoch: string
}

/** Fetch a `skill_update_notifications_sent` row's identity-preserving columns, or null if absent. */
export async function fetchNotification(
  conn: PgConnParams,
  userId: string,
  sourceKey: string,
  skillId: string
): Promise<NotificationRow | null> {
  const rows = await queryRows(
    conn,
    `SELECT last_notified_hash, extract(epoch from last_notified_at)::bigint::text
       FROM skill_update_notifications_sent
      WHERE user_id = :'user_id'::uuid AND source_key = :'source_key' AND skill_id = :'skill_id';`,
    { user_id: userId, source_key: sourceKey, skill_id: skillId }
  )
  if (rows.length === 0) return null
  return { lastNotifiedHash: rows[0][0], lastNotifiedAtEpoch: rows[0][1] }
}

/**
 * Run `sql` wrapped in `EXPLAIN (ANALYZE, TIMING OFF, SUMMARY OFF)` and return
 * whether the trigger actually fired. EXPLAIN ANALYZE genuinely executes the
 * statement (this IS the real UPDATE, not a dry run) and Postgres reports a
 * `Trigger trg_rekey_skill_name_dependents: ...` line in its output for
 * EVERY trigger that fired — and OMITS the line entirely for a trigger whose
 * `WHEN` clause evaluated false, since a WHEN-skipped trigger is never
 * queued to run at all. This is more robust than `pg_stat_user_functions`
 * (which needs `track_functions` toggled server- or session-side before the
 * statement runs) and doesn't require adding a test-only call counter to the
 * shipped trigger function — it's a direct, mechanism-level answer to "did
 * this specific trigger fire," independent of any GUC.
 */
export async function updateAndDidTriggerFire(
  conn: PgConnParams,
  updateSql: string,
  vars: Record<string, string>
): Promise<boolean> {
  const { stdout } = await runPsql(
    conn,
    `EXPLAIN (ANALYZE, TIMING OFF, SUMMARY OFF) ${updateSql}`,
    vars
  )
  return /Trigger trg_rekey_skill_name_dependents:/.test(stdout)
}

export type { PgConnParams }
