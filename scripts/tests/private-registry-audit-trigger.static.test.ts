/**
 * SMI-6114: always-on structural assertions for
 * supabase/migrations/20260913000000_private_registry_audit_trigger.sql.
 *
 * The behaviour is pinned against a real Postgres in `private-registry-audit-trigger.test.ts`,
 * which skips without a test database (and does not run in CI yet, SMI-5946). This file is the part
 * CI always runs: it catches the regressions that are visible in the SQL text itself, and it owns
 * the one guard the live suite cannot provide — COLUMN COVERAGE. The trigger lists every
 * private_registry_skills column explicitly (a generic row diff would detoast `content` on every
 * UPDATE); a later migration that adds a column without adding it to the trigger would make
 * privileged changes to that column unaudited, silently. The coverage test derives the column set
 * from the migrations, so it fails at PR time instead.
 *
 * Git-crypt: same contract as private-registry-rls.test.ts (SMI-5984). A locked migration is only
 * accepted when SKILLSMITH_GIT_CRYPT_EXPECTED_LOCKED=1; content assertions then skip.
 */

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const helpers = (await import('../audit-standards-helpers.mjs')) as {
  auditSecdefAnonGrants: (
    migrations: Array<{ name: string; content: string }>,
    opts: { cutoff: string | number; allowlist?: string[] }
  ) => Array<{ file: string; fn: string; signature: string; reason: string }>
}

const MIGRATIONS_DIR = 'supabase/migrations'
const MIGRATION_FILE = '20260913000000_private_registry_audit_trigger.sql'
const GIT_CRYPT_MAGIC = Buffer.from([0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54])
const EXPECT_LOCKED_ENV_VAR = 'SKILLSMITH_GIT_CRYPT_EXPECTED_LOCKED'

/** The 15 columns read from prod's information_schema on 2026-09-13. */
const PROD_COLUMNS = [
  'id',
  'team_id',
  'skill_id',
  'version',
  'description',
  'content',
  'content_hash',
  'deprecated',
  'published_by',
  'published_at',
  'approval_status',
  'approval_mode',
  'approved_by',
  'approved_at',
  'review_note',
]

function readMigration(name: string): string | null {
  const raw = readFileSync(join(MIGRATIONS_DIR, name))
  if (raw.subarray(0, GIT_CRYPT_MAGIC.length).equals(GIT_CRYPT_MAGIC)) {
    if (process.env[EXPECT_LOCKED_ENV_VAR] !== '1') {
      throw new Error(
        `${name} is git-crypt-locked but ${EXPECT_LOCKED_ENV_VAR} is not set — treat as an unlock ` +
          'failure, not a lock-state edge case (SMI-5984).'
      )
    }
    return null
  }
  return raw.toString('utf8')
}

const stripLineComments = (sql: string): string => sql.replace(/--[^\n]*/g, '')

const triggerSql = readMigration(MIGRATION_FILE)
const locked = triggerSql === null

/** The plpgsql body of audit_private_registry_skills_change(). */
function functionBody(sql: string): string {
  const match = sql.match(
    /FUNCTION\s+audit_private_registry_skills_change\(\)[\s\S]*?AS \$\$([\s\S]*?)\$\$;/
  )
  if (!match) throw new Error('audit_private_registry_skills_change() body not found')
  return stripLineComments(match[1])
}

/**
 * Every private_registry_skills column the migration history creates: the CREATE TABLE column
 * list, plus ADD COLUMN, minus DROP COLUMN, across all migrations (comments stripped, so the
 * commented-out rollback blocks do not count).
 */
function columnsFromMigrations(): Set<string> {
  const columns = new Set<string>()
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  for (const file of files) {
    const content = readMigration(file)
    if (content === null) continue
    const sql = stripLineComments(content)
    const create = sql.match(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?private_registry_skills\s*\(([\s\S]*?)\n\);/i
    )
    if (create) {
      for (const line of create[1].split('\n')) {
        const col = line.match(/^\s*([a-z_]+)\s+(?:UUID|TEXT|JSONB|BOOLEAN|TIMESTAMPTZ)\b/i)
        if (col) columns.add(col[1].toLowerCase())
      }
    }
    for (const stmt of sql.split(';')) {
      if (
        !/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?private_registry_skills\b/i.test(
          stmt
        )
      ) {
        continue
      }
      for (const m of stmt.matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_]+)"?/gi)) {
        columns.add(m[1].toLowerCase())
      }
      for (const m of stmt.matchAll(/DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"?([a-z_]+)"?/gi)) {
        columns.delete(m[1].toLowerCase())
      }
    }
  }
  return columns
}

describe.skipIf(locked)('20260913000000_private_registry_audit_trigger.sql (SMI-6114)', () => {
  const sql = triggerSql ?? ''
  const code = stripLineComments(sql)

  it('audits every row-level mutation AFTER the write, and TRUNCATE per statement', () => {
    expect(code).toMatch(
      /CREATE OR REPLACE TRIGGER trg_prs_audit\s+AFTER INSERT OR UPDATE OR DELETE ON private_registry_skills\s+FOR EACH ROW EXECUTE FUNCTION audit_private_registry_skills_change\(\);/
    )
    expect(code).toMatch(
      /CREATE OR REPLACE TRIGGER trg_prs_audit_truncate\s+AFTER TRUNCATE ON private_registry_skills\s+FOR EACH STATEMENT EXECUTE FUNCTION audit_private_registry_skills_change\(\);/
    )
  })

  it('is SECURITY DEFINER with a pinned search_path and revokes anon by name (Check 51/52)', () => {
    expect(code).toMatch(
      /FUNCTION audit_private_registry_skills_change\(\)\s+RETURNS trigger\s+LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = public, pg_temp/
    )
    expect(
      helpers.auditSecdefAnonGrants([{ name: MIGRATION_FILE, content: sql }], {
        cutoff: '20260704000000',
      })
    ).toEqual([])
  })

  it('fails closed: the function body has no exception handler around the audit write', () => {
    expect(functionBody(sql)).not.toMatch(/\bEXCEPTION\b/i)
  })

  it('never copies content, description or review_note text into metadata', () => {
    const body = functionBody(sql)
    expect(body).not.toMatch(/'content'\s*,/)
    expect(body).not.toMatch(/'description'\s*,/)
    expect(body).not.toMatch(/'review_note'\s*,/)
    expect(body).toMatch(/'review_note_present', v_row\.review_note IS NOT NULL/)
  })

  it('writes metadata.team_id only under the member-visibility rule (SMI-6114 untag)', () => {
    const body = functionBody(sql)
    // audit_logs_team_scoped_read reads exactly this key, so it may be WRITTEN in one place only
    // (`'team_id'::TEXT` in the changed-columns list is a column name, not a metadata key).
    expect(body.match(/'team_id'\s*,/g)).toHaveLength(1)
    expect(body).toMatch(
      /CASE WHEN v_tagged THEN jsonb_build_object\('team_id', v_row\.team_id\)\s+ELSE '\{\}'::JSONB END/
    )
    expect(body).toMatch(/v_visible_before := OLD\.approval_status = 'approved';/)
    expect(body).toMatch(/v_visible_after := NEW\.approval_status = 'approved';/)
    expect(body).toMatch(
      /v_tagged := CASE v_event\s+WHEN 'publish' THEN v_visible_after\s+WHEN 'approve' THEN v_visible_after\s+WHEN 'delete'\s+THEN v_visible_before\s+ELSE v_visible_before AND v_visible_after\s+END;/
    )
  })

  it('compares every private_registry_skills column the migrations create', () => {
    const columns = columnsFromMigrations()
    // Denominator first: an extractor that found nothing would make the loop below vacuous.
    expect([...columns].sort()).toEqual([...PROD_COLUMNS].sort())
    const body = functionBody(sql)
    const uncovered = [...columns].filter(
      (col) => !new RegExp(`NEW\\.${col} IS DISTINCT FROM OLD\\.${col}\\b`).test(body)
    )
    expect(uncovered).toEqual([])
  })
})
