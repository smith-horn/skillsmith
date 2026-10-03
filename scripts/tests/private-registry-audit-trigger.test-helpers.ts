/**
 * SMI-6114: setup/fixture harness for `private-registry-audit-trigger.test.ts`, split out to keep
 * that file under the 500-line gate.
 *
 * Reuses `scripts/indexer/smi5879-census.pg.ts` (the repo's one live-Postgres harness — see
 * `scripts/tests/indexer/skill-name-change-trigger.test-helpers.ts` for why) and the same five
 * connection env vars, so it can share an ephemeral instance with those suites. Each run works in
 * its own schema. Standup (from the HOST; the suite runs inside the worktree's dev container):
 *
 *   docker run -d --rm --name smi6114-audit-test-pg -e POSTGRES_PASSWORD=testpass \
 *     -p 15614:5432 postgres:15-alpine
 *   ./scripts/worktree-docker.sh exec -- env SMI5879_TEST_PGHOST=host.docker.internal \
 *     SMI5879_TEST_PGPORT=15614 SMI5879_TEST_PGUSER=postgres SMI5879_TEST_PGPASSWORD=testpass \
 *     SMI5879_TEST_PGDATABASE=postgres \
 *     npx vitest run --config vitest.config.root-tests.ts scripts/tests/private-registry-audit-trigger.test.ts
 *
 * `public.ecr.aws/supabase/postgres:17.6.1.159` also works and is closer to prod: its `postgres`
 * role is non-superuser with BYPASSRLS (like prod), and it already ships the Supabase roles and
 * `auth.uid()`/`auth.role()`, which the fixture below then leaves alone.
 *
 * The fixtures copy the prod shapes that the trigger's behaviour depends on (verified read-only on
 * prod 2026-09-13): audit_logs' columns, RLS enabled with no INSERT policy, and the table-wide
 * grants to anon/authenticated/service_role; private_registry_skills' 15 columns, RLS enabled, and
 * the column-scoped INSERT/UPDATE grants from 20260729000000. They deliberately omit the three
 * BEFORE triggers and the FKs (auth.users/teams do not exist here), which the trigger under test
 * does not read.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  queryRows,
  runPsql,
  testConnParamsFromEnv,
  type PgConnParams,
} from '../indexer/smi5879-census.pg.ts'

export const MIGRATION_PATH = join(
  process.cwd(),
  'supabase/migrations/20260913000000_private_registry_audit_trigger.sql'
)

export const noLiveTestPg = !testConnParamsFromEnv()

/**
 * Roles and `auth` helpers, created only where absent, under a TRANSACTION-scoped advisory lock
 * (roles are cluster-global, and this file's two SMI-6114 suites run in parallel against one
 * instance). Transaction-scoped, not session-scoped: a session lock released inside the DO block
 * frees the waiter before this transaction's CREATE ROLE commits, so the waiter still sees no role
 * and collides on pg_authid_rolname_index (observed on PG 15 with both suites running). The `auth`
 * function bodies are copied from prod's `pg_get_functiondef` output (read 2026-09-13).
 */
const CREATE_ROLES_AND_AUTH_SQL = `
DO $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('smi6114_audit_trigger_roles_auth'));
  BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
      CREATE ROLE anon NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
      CREATE ROLE authenticated NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
      CREATE ROLE service_role NOLOGIN BYPASSRLS;
    END IF;
    IF NOT pg_has_role(current_user, 'authenticated', 'MEMBER') THEN
      EXECUTE format('GRANT authenticated TO %I', current_user);
    END IF;
    IF NOT pg_has_role(current_user, 'service_role', 'MEMBER') THEN
      EXECUTE format('GRANT service_role TO %I', current_user);
    END IF;
    CREATE SCHEMA IF NOT EXISTS auth;
    IF to_regprocedure('auth.uid()') IS NULL THEN
      EXECUTE $f$CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $b$
        select coalesce(
          nullif(current_setting('request.jwt.claim.sub', true), ''),
          (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
        )::uuid $b$ $f$;
    END IF;
    IF to_regprocedure('auth.role()') IS NULL THEN
      EXECUTE $f$CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $b$
        select coalesce(
          nullif(current_setting('request.jwt.claim.role', true), ''),
          (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
        )::text $b$ $f$;
    END IF;
    -- Supabase images already grant these, and their non-superuser postgres holds no grant
    -- option on the platform-owned auth schema, so only grant where missing.
    IF NOT has_schema_privilege('authenticated', 'auth', 'USAGE')
       OR NOT has_schema_privilege('service_role', 'auth', 'USAGE') THEN
      GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
    END IF;
    IF NOT has_function_privilege('authenticated', 'auth.uid()', 'EXECUTE')
       OR NOT has_function_privilege('service_role', 'auth.role()', 'EXECUTE') THEN
      GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO anon, authenticated, service_role;
    END IF;
  END;
END
$$;
`

function fixturesSql(schema: string): string {
  return `
GRANT USAGE ON SCHEMA "${schema}" TO anon, authenticated, service_role;

CREATE TABLE audit_logs (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  event_type TEXT NOT NULL,
  timestamp  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor      TEXT,
  resource   TEXT,
  action     TEXT,
  result     TEXT,
  metadata   JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_logs_fixture_read ON audit_logs FOR SELECT TO authenticated USING (false);
GRANT ALL ON TABLE audit_logs TO anon, authenticated, service_role;

CREATE TABLE private_registry_skills (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id         TEXT NOT NULL,
  skill_id        TEXT NOT NULL,
  version         TEXT NOT NULL,
  description     TEXT,
  content         JSONB NOT NULL,
  content_hash    TEXT NOT NULL DEFAULT 'fixture-hash',
  deprecated      BOOLEAN NOT NULL DEFAULT FALSE,
  published_by    UUID DEFAULT auth.uid(),
  published_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approval_status TEXT NOT NULL DEFAULT 'pending',
  approval_mode   TEXT NOT NULL DEFAULT 'review',
  approved_by     UUID,
  approved_at     TIMESTAMPTZ,
  review_note     TEXT,
  UNIQUE (team_id, skill_id, version)
);
ALTER TABLE private_registry_skills ENABLE ROW LEVEL SECURITY;
CREATE POLICY prs_fixture_authenticated ON private_registry_skills
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
GRANT ALL ON TABLE private_registry_skills TO service_role;
REVOKE ALL ON TABLE private_registry_skills FROM anon, authenticated;
GRANT SELECT ON TABLE private_registry_skills TO authenticated;
GRANT INSERT (team_id, skill_id, version, description, content)
  ON TABLE private_registry_skills TO authenticated;
GRANT UPDATE (deprecated) ON TABLE private_registry_skills TO authenticated;

CREATE TABLE schema_version (version INT PRIMARY KEY);
`
}

/**
 * Fresh schema + fixtures + the REAL migration file from disk. `public` in the migration text is
 * rewritten to the test schema (the same substitution the SMI-5930 suite uses) so the SECURITY
 * DEFINER function's pinned search_path resolves this schema's audit_logs at fire time.
 */
export async function resetSchema(conn: PgConnParams, schema: string): Promise<PgConnParams> {
  await runPsql(conn, CREATE_ROLES_AND_AUTH_SQL)
  await runPsql(conn, `DROP SCHEMA IF EXISTS "${schema}" CASCADE; CREATE SCHEMA "${schema}";`)
  const scoped: PgConnParams = { ...conn, searchPath: `${schema}` }
  await runPsql(scoped, fixturesSql(schema))
  const migration = readFileSync(MIGRATION_PATH, 'utf8').replace(/\bpublic\b/g, schema)
  await runPsql(scoped, migration)
  return scoped
}

export interface Caller {
  /** JWT claims PostgREST would set, or null for a direct SQL session with none. */
  claims: { sub?: string; role: string } | null
  /** SET LOCAL ROLE for the statement, or null to stay the connecting (owner) role. */
  role: 'authenticated' | 'service_role' | null
}

/** Run `sql` in one transaction the way PostgREST would for `caller`. Rejects on SQL error. */
export async function runAs(
  conn: PgConnParams,
  caller: Caller,
  sql: string,
  vars: Record<string, string> = {}
): Promise<void> {
  const claims = caller.claims ? JSON.stringify(caller.claims) : ''
  // Both the JSON GUC current PostgREST sets (what prod's auth.uid() reads first-class) and the
  // legacy per-claim GUCs: the bare supabase/postgres image ships the older auth.uid()/auth.role()
  // that read only request.jwt.claim.sub / .role (verified 2026-09-13), which GoTrue's own
  // migrations replace on a real project.
  await runPsql(
    conn,
    `BEGIN;
     SELECT set_config('request.jwt.claims', :'claims', true),
            set_config('request.jwt.claim.sub', :'claim_sub', true),
            set_config('request.jwt.claim.role', :'claim_role', true);
     ${caller.role ? `SET LOCAL ROLE ${caller.role};` : ''}
     ${sql}
     COMMIT;`,
    {
      ...vars,
      claims,
      claim_sub: caller.claims?.sub ?? '',
      claim_role: caller.claims?.role ?? '',
    }
  )
}

export interface AuditRow {
  eventType: string
  actor: string
  resource: string
  action: string
  result: string
  metadata: Record<string, unknown>
}

/**
 * Every private_registry audit row for one team, read as the connecting (BYPASSRLS/owner) role.
 * Keyed on `registry_team_id`, which every row carries; `team_id` is only present on member-visible
 * rows (SMI-6114 untag rule).
 */
export async function auditRowsForTeam(conn: PgConnParams, teamId: string): Promise<AuditRow[]> {
  const rows = await queryRows(
    conn,
    `SELECT event_type, actor, resource, action, result, metadata::text
       FROM audit_logs
      WHERE metadata->>'registry_team_id' = :'team_id'
      ORDER BY created_at, event_type, id;`,
    { team_id: teamId }
  )
  return rows.map(([eventType, actor, resource, action, result, metadata]) => ({
    eventType,
    actor,
    resource,
    action,
    result,
    metadata: JSON.parse(metadata) as Record<string, unknown>,
  }))
}

export type { PgConnParams }
