/**
 * SMI-6114: always-on structural assertions for
 * supabase/migrations/20260913000000_private_registry_audit_trigger.sql.
 *
 * The behaviour is pinned against a real Postgres in `private-registry-audit-trigger.test.ts`,
 * which skips without a test database (and does not run in CI yet, SMI-5946). This file
 * (private-registry-audit-trigger.static.test.ts) is the part CI always runs: it catches the
 * regressions that are visible in the SQL text itself, and it owns the one guard the live suite
 * cannot provide -- COLUMN COVERAGE, not the live suite named above. The trigger lists every
 * private_registry_skills column explicitly so it can report an exact `changed_columns` list and
 * so this file's coverage test can check each column is covered individually -- not to avoid
 * detoasting `content`: `NEW.content IS DISTINCT FROM OLD.content` still reads (detoasts)
 * `content` on every UPDATE, the same as a generic row diff would (measured: 33-119ms explicit vs
 * 86-142ms generic `to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)`, 20 rows of ~1.9MB stored
 * `content`, SMI-6114 retro). The coverage test derives the column set from the migrations, so it
 * fails at PR time instead.
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
// Not git-crypt-scoped (only supabase/functions/ and supabase/migrations/ are), so this is always
// plaintext and needs no GIT_CRYPT_MAGIC handling of its own.
const ROLLBACK_FILE = 'supabase/rollbacks/20260913000000_private_registry_audit_trigger_down.sql'
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

/** The plpgsql body of audit_private_registry_skills_change(), from MIGRATION_FILE only. */
function functionBody(sql: string): string {
  const match = sql.match(
    /FUNCTION\s+audit_private_registry_skills_change\(\)[\s\S]*?AS \$\$([\s\S]*?)\$\$;/
  )
  if (!match) throw new Error('audit_private_registry_skills_change() body not found')
  return stripLineComments(match[1])
}

const FUNCTION_DEF_RE =
  /CREATE (?:OR REPLACE )?FUNCTION\s+audit_private_registry_skills_change\(\)[\s\S]*?AS \$\$([\s\S]*?)\$\$;/g

/**
 * Every audit_private_registry_skills_change() body across ALL migrations, in filename order
 * (comments stripped per definition). A later migration that redefines the function with
 * `CREATE OR REPLACE FUNCTION` is the realistic change path once 20260913000000 is applied to
 * staging -- the live suites that would catch a bad redefinition skip in CI (SMI-5946), so the
 * security-invariant checks below must look at the LATEST definition, not just this one file
 * (SMI-6114 retro F2).
 */
function allFunctionDefinitions(): Array<{ file: string; body: string }> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  const defs: Array<{ file: string; body: string }> = []
  for (const file of files) {
    const content = readMigration(file)
    if (content === null) continue
    for (const m of content.matchAll(FUNCTION_DEF_RE)) {
      defs.push({ file, body: stripLineComments(m[1]) })
    }
  }
  return defs
}

function latestFunctionBody(): string {
  const defs = allFunctionDefinitions()
  if (defs.length === 0) {
    throw new Error('No audit_private_registry_skills_change() definition found in any migration')
  }
  return defs[defs.length - 1].body
}

/**
 * Every RECORD- or %ROWTYPE-typed variable the DECLARE block introduces, beyond the implicit
 * NEW/OLD. A mutation that serialises a whole row through a differently-named local variable
 * (rather than NEW/OLD/v_row directly) is still a row-serialisation, so the ban below must reach
 * it by declared type, not by a fixed name list.
 */
function declaredRecordVariables(body: string): string[] {
  const declareMatch = body.match(/DECLARE([\s\S]*?)BEGIN/)
  const declareBlock = declareMatch ? declareMatch[1] : ''
  const names: string[] = []
  for (const m of declareBlock.matchAll(/(\w+)\s+(?:RECORD|\w+%ROWTYPE)\b/gi)) {
    names.push(m[1])
  }
  return names
}

/**
 * Allowed occurrences of a private_registry_skills text column's bare word (`content`,
 * `description` or `review_note`) inside the trigger body: (1) the changed-column-list line
 * (`IF NEW.col IS DISTINCT FROM OLD.col THEN v_changed := v_changed || 'col'::TEXT; END IF;`,
 * which accounts for 3 occurrences per match), (2) an `IS NOT NULL` presence check, and (3) for
 * `content` only, the two `jsonb_typeof`/`jsonb_object_keys` shape checks. Any occurrence not
 * accounted for here -- including `v_row.content` passed bare as a jsonb_build_object VALUE under
 * a brand-new key name -- is exactly the M1-style gap a literal-key-name regex cannot see
 * (SMI-6114 retro F2).
 */
function allowedTextColumnOccurrences(body: string, col: string): number {
  let allowed = 0
  const changeListRe = new RegExp(
    `IF\\s+NEW\\.${col}\\s+IS DISTINCT FROM\\s+OLD\\.${col}\\s+THEN\\s+v_changed\\s*:=\\s*v_changed\\s*\\|\\|\\s*'${col}'::TEXT;\\s*END IF;`,
    'g'
  )
  allowed += (body.match(changeListRe)?.length ?? 0) * 3
  const presenceRe = new RegExp(`(NEW|OLD|v_row)\\.${col}\\s+IS NOT NULL`, 'g')
  allowed += body.match(presenceRe)?.length ?? 0
  if (col === 'content') {
    allowed += body.match(/jsonb_typeof\(NEW\.content\)/g)?.length ?? 0
    allowed += body.match(/jsonb_object_keys\(NEW\.content\)/g)?.length ?? 0
  }
  return allowed
}

/**
 * Anything that serialises a whole row (or a declared RECORD/%ROWTYPE variable) into metadata:
 * `to_jsonb`/`to_json` on NEW, OLD or any such variable, `row_to_json`, `hstore(`,
 * `jsonb_populate_record`, or a `json_build_object`/`jsonb_build_object` call spread over `.*`.
 * `to_jsonb(v_row)` (M2) copies content, description and review_note in one call and writes
 * team_id unconditionally -- the exact shape the untag rule and the text-column check above
 * cannot see through a literal-key-name regex alone.
 */
function rowSerialisationViolations(body: string): string[] {
  const recordVars = ['NEW', 'OLD', ...declaredRecordVariables(body)]
  const varsAlt = recordVars.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const patterns: RegExp[] = [
    new RegExp(`\\bto_jsonb\\s*\\(\\s*(${varsAlt})\\b`, 'i'),
    new RegExp(`\\bto_json\\s*\\(\\s*(${varsAlt})\\b`, 'i'),
    /\brow_to_json\s*\(/i,
    /\bhstore\s*\(/i,
    /\bjsonb_populate_record\s*\(/i,
    new RegExp(`\\b(?:json|jsonb)_build_object\\s*\\(\\s*(${varsAlt})\\.\\*`, 'i'),
  ]
  return patterns.filter((re) => re.test(body)).map((re) => re.source)
}

/**
 * Every private_registry_skills.team_id column the migration history creates: the CREATE TABLE
 * column list, plus ADD COLUMN, minus DROP COLUMN, across all migrations (comments stripped, so the
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

  it(
    'content, description and review_note appear only in allowed contexts, in the LATEST ' +
      'definition across all migrations (SMI-6114 retro F2)',
    () => {
      const body = latestFunctionBody()
      expect(body).toMatch(/'review_note_present', v_row\.review_note IS NOT NULL/)
      for (const col of ['content', 'description', 'review_note']) {
        const total = body.match(new RegExp(`\\b${col}\\b`, 'gi'))?.length ?? 0
        const allowed = allowedTextColumnOccurrences(body, col)
        expect(total, `${col}: occurrence outside an allowed context`).toBe(allowed)
      }
    }
  )

  it(
    'never serialises a whole row -- or a declared RECORD/%ROWTYPE variable -- into metadata, ' +
      'in the LATEST definition across all migrations (SMI-6114 retro F2)',
    () => {
      const body = latestFunctionBody()
      expect(rowSerialisationViolations(body)).toEqual([])
    }
  )

  it(
    'writes metadata.team_id only under the member-visibility rule, via only the two allowed ' +
      'value expressions, in the LATEST definition (SMI-6114 untag, retro F2)',
    () => {
      const body = latestFunctionBody()
      // audit_logs_team_scoped_read reads exactly this key, so it may be WRITTEN in one place
      // only (`'team_id'::TEXT` in the changed-columns list is a column name, not a metadata key).
      expect(body.match(/'team_id'\s*,/g)).toHaveLength(1)
      expect(body).toMatch(
        /CASE WHEN v_tagged THEN jsonb_build_object\('team_id', v_row\.team_id\)\s+ELSE '\{\}'::JSONB END/
      )
      expect(body).toMatch(/v_visible_before := OLD\.approval_status = 'approved';/)
      expect(body).toMatch(/v_visible_after := NEW\.approval_status = 'approved';/)
      expect(body).toMatch(
        /v_tagged := CASE v_event\s+WHEN 'publish' THEN v_visible_after\s+WHEN 'approve' THEN v_visible_after\s+WHEN 'delete'\s+THEN v_visible_before\s+ELSE v_visible_before AND v_visible_after\s+END;/
      )
      // Value-level guard: every NEW|OLD|v_row.team_id reference is either the resource-string
      // concatenation, the always-present registry_team_id entry, the tagged CASE arm, or the
      // changed-column-list comparison -- never a bare copy into a new or unconditional key.
      const teamIdValueRefs = body.match(/(NEW|OLD|v_row)\.team_id\b/g)?.length ?? 0
      const inResourceConcat = body.match(/\|\|\s*v_row\.team_id\s*\|\|/g)?.length ?? 0
      const inRegistryTeamId = body.match(/'registry_team_id',\s*v_row\.team_id/g)?.length ?? 0
      const inCaseArm = body.match(/'team_id',\s*v_row\.team_id/g)?.length ?? 0
      const changeListMatches =
        body.match(
          /IF\s+NEW\.team_id\s+IS DISTINCT FROM\s+OLD\.team_id\s+THEN\s+v_changed\s*:=\s*v_changed\s*\|\|\s*'team_id'::TEXT;\s*END IF;/g
        )?.length ?? 0
      expect(teamIdValueRefs).toBe(
        inResourceConcat + inRegistryTeamId + inCaseArm + changeListMatches * 2
      )
    }
  )

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

  // SMI-6114: pin the schema_version registration (migration insert, rollback delete) so a later
  // edit can't silently drop either half.
  it('registers schema_version 116 exactly once, idempotently, before the transaction COMMIT', () => {
    const inserts = code.match(
      /INSERT INTO schema_version \(version\) VALUES \(116\) ON CONFLICT DO NOTHING;/g
    )
    // Denominator first: a pattern that matched nothing would make the ordering check below vacuous.
    expect(inserts).toHaveLength(1)
    const commits = code.match(/\bCOMMIT;/g)
    expect(commits).toHaveLength(1)
    expect(code.indexOf(inserts![0])).toBeLessThan(code.indexOf(commits![0]))
  })

  it('the standalone rollback file deletes schema_version 116 as a real (uncommented) statement', () => {
    const rollbackCode = stripLineComments(readFileSync(ROLLBACK_FILE, 'utf8'))
    expect(rollbackCode.match(/DELETE FROM schema_version WHERE version = 116;/g)).toHaveLength(1)
  })
})
