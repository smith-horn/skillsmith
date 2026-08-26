/**
 * SMI-5898 Wave 2 Step 4: shared setup/fixture harness for
 * `merge-duplicate-skills.test.ts`. Reuses `scripts/indexer/smi5879-census.pg.ts`
 * — this repo's one existing convention for "run raw multi-statement SQL
 * against Postgres" — same pattern as
 * `repo-url-canonical-trigger.test-helpers.ts`.
 *
 * Fixture schema is a minimal mirror of the real tables' column shapes
 * (confirmed via `information_schema.columns` against prod at implementation
 * time), not a verbatim copy of every column the shipped tables carry.
 *
 * Connection: reuses the SMI-5879 suite's own env var names (both suites can
 * point at the SAME ephemeral Postgres instance safely — each test file works
 * in its own schema, see resetSchema() below):
 *   SMI5879_TEST_PGHOST / SMI5879_TEST_PGPORT / SMI5879_TEST_PGUSER /
 *   SMI5879_TEST_PGPASSWORD / SMI5879_TEST_PGDATABASE
 *
 *   docker run -d --name smi5879-census-test-pg -e POSTGRES_PASSWORD=testpass \
 *     -e POSTGRES_DB=postgres -p 15499:5432 postgres:15-alpine
 *   SMI5879_TEST_PGHOST=host.docker.internal SMI5879_TEST_PGPORT=15499 \
 *   SMI5879_TEST_PGUSER=postgres SMI5879_TEST_PGPASSWORD=testpass \
 *   SMI5879_TEST_PGDATABASE=postgres npx vitest run scripts/tests/indexer/merge-duplicate-skills.test.ts
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  runPsql,
  queryScalar,
  testConnParamsFromEnv,
  type PgConnParams,
} from '../../indexer/smi5879-census.pg.ts'

const MIGRATION_PATH = join(
  process.cwd(),
  'supabase/migrations/20260819000000_smi5898_repo_url_canonical.sql'
)

export const prePushNoLiveTestPg = !testConnParamsFromEnv()

const CREATE_FIXTURES_SQL = `
CREATE TABLE skills (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  repo_url TEXT,
  author TEXT,
  name TEXT NOT NULL DEFAULT 'test-skill',
  quarantined BOOLEAN NOT NULL DEFAULT false,
  last_seen_at TIMESTAMPTZ,
  trust_tier TEXT,
  stars INT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE categories (id TEXT PRIMARY KEY);

CREATE TABLE skill_categories (
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (skill_id, category_id)
);

CREATE TABLE skills_optimized (
  skill_id TEXT PRIMARY KEY REFERENCES skills(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL DEFAULT 'h',
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE skill_transformations (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  skill_id TEXT NOT NULL UNIQUE REFERENCES skills(id) ON DELETE CASCADE,
  transformed_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE outreach_suppressions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id TEXT NOT NULL UNIQUE,
  suppressed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT NOT NULL DEFAULT 'test'
);

CREATE TABLE outreach_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id TEXT NOT NULL,
  filed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  repo_owner TEXT NOT NULL DEFAULT 'x',
  repo_name TEXT NOT NULL DEFAULT 'y',
  finding_summary JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'filed',
  dry_run BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE quarantine_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id TEXT NOT NULL,
  reviewer_id UUID NOT NULL DEFAULT gen_random_uuid(),
  reviewer_email TEXT NOT NULL DEFAULT 'r@example.com',
  decision TEXT NOT NULL DEFAULT 'approve',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  required_approvals INT NOT NULL DEFAULT 2,
  is_complete BOOLEAN NOT NULL DEFAULT false
);
`

/** Full reset, scoped to `schemaName` (vitest's file-level parallelism means a shared `public` schema would race sibling test files). Applies the REAL shipped migration for repo_url_canonical, then the fixture tables above. */
export async function resetSchema(conn: PgConnParams, schemaName: string): Promise<PgConnParams> {
  await runPsql(
    conn,
    `DROP SCHEMA IF EXISTS "${schemaName}" CASCADE; CREATE SCHEMA "${schemaName}";`
  )
  const scoped: PgConnParams = { ...conn, searchPath: `${schemaName},public` }
  await runPsql(scoped, 'CREATE EXTENSION IF NOT EXISTS pgcrypto;')
  await runPsql(scoped, CREATE_FIXTURES_SQL)
  const migrationSql = readFileSync(MIGRATION_PATH, 'utf8')
  await runPsql(scoped, migrationSql)
  return scoped
}

/** Insert a skill row via INSERT (fires the trigger, populating repo_url_canonical); returns its id. */
export async function insertSkill(
  conn: PgConnParams,
  fields: Partial<{
    repoUrl: string
    author: string
    name: string
    quarantined: boolean
    lastSeenAt: string
    trustTier: string
    stars: number
    updatedAt: string
  }>
): Promise<string> {
  const repoUrl = fields.repoUrl ? `'${fields.repoUrl}'` : 'NULL'
  const author = fields.author ? `'${fields.author}'` : 'NULL'
  const name = fields.name ? `'${fields.name}'` : `'test-skill'`
  const quarantined = fields.quarantined ? 'true' : 'false'
  const lastSeenAt = fields.lastSeenAt ? `'${fields.lastSeenAt}'` : 'NULL'
  const trustTier = fields.trustTier ? `'${fields.trustTier}'` : 'NULL'
  const stars = fields.stars ?? 'NULL'
  const updatedAt = fields.updatedAt ? `'${fields.updatedAt}'` : 'now()'
  const id = await queryScalar(
    conn,
    `INSERT INTO skills (repo_url, author, name, quarantined, last_seen_at, trust_tier, stars, updated_at)
     VALUES (${repoUrl}, ${author}, ${name}, ${quarantined}, ${lastSeenAt}, ${trustTier}, ${stars}, ${updatedAt})
     RETURNING id::text;`
  )
  if (!id) throw new Error('merge-duplicate-skills test: skill insert returned no id')
  return id
}
