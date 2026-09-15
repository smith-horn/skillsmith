/**
 * SMI-6114: always-on structural assertions for
 * supabase/migrations/20260913000000_private_registry_audit_trigger.sql.
 *
 * The behaviour is pinned against a real Postgres in `private-registry-audit-trigger.test.ts`,
 * which skips without a test database (and does not run in CI yet, SMI-5946). This file is the
 * part CI always runs.
 *
 * MODEL (rewritten after the cross-family review gate on PR #2855 found the prior denylist
 * approach -- an enumerated list of banned serializers, and a per-column "allowed occurrence"
 * regex -- could not be made complete; see F1/F2 below):
 *
 *   1. THE PIN FORCES HUMAN REVIEW OF ANY CHANGE. A fail-closed parser (DEF_RE) finds every
 *      CREATE [OR REPLACE] FUNCTION of audit_private_registry_skills_change() across all
 *      migrations regardless of schema qualification, dollar-quote tag or case, and a separate
 *      mention counter catches anything DEF_RE could not parse (e.g. a single-quoted `AS '...'`
 *      body) instead of silently ignoring it (gate finding F1). The latest definition's header
 *      and body are then normalized and pinned by sha256: any change to either -- a new metadata
 *      key, an appended snapshot expression, SECURITY INVOKER instead of DEFINER, anything -- must
 *      change the pinned hash, which means a human has to look at the diff and update the
 *      constant. The triggers are pinned the same way, against exact expected text. THIS is the
 *      real defense against gate finding F2 (a redefinition serializing the whole row via
 *      `jsonb_build_array(NEW)`, which no enumerable denylist could rule out completely): the pin
 *      does not try to characterize every unsafe body, it just refuses to let the body change
 *      unreviewed.
 *   2. THE SEMANTIC CHECKS DOCUMENT WHY THE PINNED BODY WAS APPROVED, not police future changes:
 *      no EXCEPTION handler (fail-closed), the exact untag CASE, one team_id write, and full
 *      column coverage. They run against the LATEST parsed definition (not just this file) so
 *      they keep describing reality after a future reviewed redefinition, but the pin above -- not
 *      these regexes -- is what makes a bad change fail loudly.
 *   3. LIVE-POSTGRES BEHAVIOUR IS IN THE LIVE SUITES, which don't run in CI (SMI-5946).
 *
 * Column coverage is the one guard the live suite cannot provide even when it does run: the
 * trigger lists every private_registry_skills column explicitly so it can report an exact
 * `changed_columns` list, and this file's coverage check derives the column set from the
 * migrations so a later column addition without a matching trigger clause fails at PR time. (Not
 * to avoid detoasting `content`: `NEW.content IS DISTINCT FROM OLD.content` still reads (detoasts)
 * `content` on every UPDATE, the same as a generic row diff would -- measured: 33-119ms explicit vs
 * 86-142ms generic `to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)`, 20 rows of ~1.9MB stored
 * `content`, SMI-6114 retro.)
 *
 * Git-crypt: same contract as private-registry-rls.test.ts (SMI-5984). A locked migration is only
 * accepted when SKILLSMITH_GIT_CRYPT_EXPECTED_LOCKED=1; content assertions then skip.
 */

import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
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
const PINNED_VERSION = Number(MIGRATION_FILE.match(/^(\d+)/)![1])
// Not git-crypt-scoped (only supabase/functions/ and supabase/migrations/ are), so this is always
// plaintext and needs no GIT_CRYPT_MAGIC handling of its own.
const ROLLBACK_FILE = 'supabase/rollbacks/20260913000000_private_registry_audit_trigger_down.sql'
const GIT_CRYPT_MAGIC = Buffer.from([0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54])
const EXPECT_LOCKED_ENV_VAR = 'SKILLSMITH_GIT_CRYPT_EXPECTED_LOCKED'
const FUNCTION_NAME = 'audit_private_registry_skills_change'

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

const triggerSql = readMigration(MIGRATION_FILE)
const locked = triggerSql === null

function allMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
}

/** Every migration whose numeric-prefix version is strictly after MIGRATION_FILE's own. */
function laterMigrationFiles(): string[] {
  return allMigrationFiles().filter((f) => {
    const m = f.match(/^(\d+)/)
    return m !== null && Number(m[1]) > PINNED_VERSION
  })
}

const stripLineComments = (sql: string): string => sql.replace(/--[^\n]*/g, '')

/**
 * strip `--` line comments and `/* *\/` block comments, collapse whitespace runs to one space,
 * trim. Keeps case. Used for both the pinned-hash inputs and the pinned-trigger-text comparison,
 * so a reformatting-only edit (SMI-6598 revert check (g)) cannot change either pin.
 */
function normalizeSql(text: string): string {
  return stripLineComments(text)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/**
 * Matches every CREATE [OR REPLACE] FUNCTION definition of audit_private_registry_skills_change(),
 * across optional `public.` (quoted or not) schema qualification, any dollar-quote tag (matched
 * via backreference), and any case. Captures the header (between the empty arg list and `AS`) and
 * the body separately, so both can be pinned independently. Measured against an 11-case table
 * (9 from the gate's own case table plus the two extra revert-check shapes below) before being
 * written down (SMI-6114 retro gate finding F1, PR #2855).
 */
const DEF_RE = new RegExp(
  String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:(?:"?public"?)\s*\.\s*)?"?${FUNCTION_NAME}"?\s*\(\s*\)([\s\S]*?)\bAS\s+(\$[A-Za-z_]*\$)([\s\S]*?)\2`,
  'gi'
)

/**
 * Counts every CREATE [OR REPLACE] FUNCTION mention of the same name and empty arg list --
 * deliberately looser than DEF_RE (no AS-body requirement), so a body DEF_RE cannot parse (a
 * single-quoted `AS '...'` body, for example, SMI-6598 revert check (b)) still counts as a
 * mention. The fail-closed check below compares this count to DEF_RE's per-file match count and
 * fails on any gap, instead of silently treating the unparsed definition as absent.
 */
const FUNCTION_CREATE_MENTION_RE = new RegExp(
  String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:(?:"?public"?)\s*\.\s*)?"?${FUNCTION_NAME}"?\s*\(\s*\)`,
  'gi'
)

interface FunctionDefinition {
  file: string
  header: string
  body: string
}

/**
 * Every audit_private_registry_skills_change() definition across ALL migrations, in filename
 * order, header and body RAW (not comment-stripped -- callers normalize as needed). A later
 * migration that redefines the function with `CREATE OR REPLACE FUNCTION` is the realistic change
 * path once 20260913000000 is applied to staging -- the live suites that would catch a bad
 * redefinition skip in CI (SMI-5946), so the checks below must look at the LATEST definition, not
 * just this one file (SMI-6114 retro F2).
 */
function allFunctionDefinitions(): FunctionDefinition[] {
  const defs: FunctionDefinition[] = []
  for (const file of allMigrationFiles()) {
    const content = readMigration(file)
    if (content === null) continue
    for (const m of content.matchAll(DEF_RE)) {
      defs.push({ file, header: m[1], body: m[3] })
    }
  }
  return defs
}

function latestFunctionDefinition(): FunctionDefinition {
  const defs = allFunctionDefinitions()
  if (defs.length === 0) {
    throw new Error('No audit_private_registry_skills_change() definition found in any migration')
  }
  return defs[defs.length - 1]
}

/** Comment-stripped (but not whitespace-normalized) body of the LATEST definition. */
function latestFunctionBody(): string {
  return stripLineComments(latestFunctionDefinition().body)
}

/** Every private_registry_skills.team_id column the migration history creates: the CREATE TABLE
 * column list, plus ADD COLUMN, minus DROP COLUMN, across all migrations (comments stripped, so the
 * commented-out rollback blocks do not count).
 */
function columnsFromMigrations(): Set<string> {
  const columns = new Set<string>()
  for (const file of allMigrationFiles()) {
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

/**
 * PINNED (SMI-6114, PR #2855 retro). Changing either hash requires a security review against
 * ADR-164 (no text columns copied, `team_id` only under the untag rule, fails closed): update the
 * pin only after that review, and say so in the PR.
 *
 * Computed from the currently-approved migration: normalizeSql() applied to the header/body DEF_RE
 * captures, sha256 hex digest (scripts/tests/private-registry-audit-trigger.static.test.ts, this
 * file's own history has the derivation script).
 */
const PINNED_HEADER_SHA256 = '2d49649af8f23b018f3dc58efdd19ec86860e8593b2f8a9e51bec2b11c1760fa'
const PINNED_BODY_SHA256 = '7cfe25b46b334a5e13dc487ac65c107d2da7989773201da12f7f68101159cf0e'

/**
 * Every `CREATE [OR REPLACE] TRIGGER <name> ... ;` statement for the given trigger name, across
 * all migrations, normalized (SMI-6114 retro F1). `\b` after the name keeps `trg_prs_audit` from
 * matching as a prefix of `trg_prs_audit_truncate` (both `t` and `_` are word characters, so no
 * boundary exists between them) -- verified against a two-trigger fixture before being relied on.
 */
function triggerDefinitions(name: string): Array<{ file: string; text: string }> {
  const re = new RegExp(
    String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+"?${name}"?\b[\s\S]*?;`,
    'gi'
  )
  const defs: Array<{ file: string; text: string }> = []
  for (const file of allMigrationFiles()) {
    const content = readMigration(file)
    if (content === null) continue
    for (const m of content.matchAll(re)) {
      defs.push({ file, text: normalizeSql(m[0]) })
    }
  }
  return defs
}

/** PINNED (SMI-6114). Normalized `CREATE OR REPLACE TRIGGER ...` text, computed from the
 * currently-approved migration the same way as the function hashes above. */
const EXPECTED_TRG_PRS_AUDIT =
  'CREATE OR REPLACE TRIGGER trg_prs_audit AFTER INSERT OR UPDATE OR DELETE ON private_registry_skills FOR EACH ROW EXECUTE FUNCTION audit_private_registry_skills_change();'
const EXPECTED_TRG_PRS_AUDIT_TRUNCATE =
  'CREATE OR REPLACE TRIGGER trg_prs_audit_truncate AFTER TRUNCATE ON private_registry_skills FOR EACH STATEMENT EXECUTE FUNCTION audit_private_registry_skills_change();'

function dropTriggerRe(name: string): RegExp {
  return new RegExp(
    String.raw`DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?(?:"?public"?\s*\.\s*)?"?${name}"?\b`,
    'i'
  )
}
function alterTriggerRe(name: string): RegExp {
  return new RegExp(String.raw`ALTER\s+TRIGGER\s+(?:"?public"?\s*\.\s*)?"?${name}"?\b`, 'i')
}
const DROP_FUNCTION_RE = new RegExp(
  String.raw`DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?(?:"?public"?\s*\.\s*)?"?${FUNCTION_NAME}"?\s*\(`,
  'i'
)
const ALTER_FUNCTION_RE = new RegExp(
  String.raw`ALTER\s+FUNCTION\s+(?:"?public"?\s*\.\s*)?"?${FUNCTION_NAME}"?\s*\(`,
  'i'
)

/**
 * Every migration strictly after MIGRATION_FILE that drops or alters the pinned function or
 * either trigger by name. Case-insensitive, schema-qualification and IF EXISTS tolerant
 * (SMI-6114 retro F1, revert checks (c)/(d)).
 */
function triggerOrFunctionTamperViolations(): string[] {
  const offenders: string[] = []
  for (const file of laterMigrationFiles()) {
    const content = readMigration(file)
    if (content === null) continue
    const sql = stripLineComments(content)
    if (dropTriggerRe('trg_prs_audit_truncate').test(sql)) {
      offenders.push(`${file}: DROP TRIGGER trg_prs_audit_truncate`)
    }
    if (dropTriggerRe('trg_prs_audit').test(sql)) {
      offenders.push(`${file}: DROP TRIGGER trg_prs_audit`)
    }
    if (DROP_FUNCTION_RE.test(sql)) {
      offenders.push(`${file}: DROP FUNCTION ${FUNCTION_NAME}`)
    }
    if (ALTER_FUNCTION_RE.test(sql)) {
      offenders.push(`${file}: ALTER FUNCTION ${FUNCTION_NAME}`)
    }
    if (alterTriggerRe('trg_prs_audit_truncate').test(sql)) {
      offenders.push(`${file}: ALTER TRIGGER trg_prs_audit_truncate`)
    }
    if (alterTriggerRe('trg_prs_audit').test(sql)) {
      offenders.push(`${file}: ALTER TRIGGER trg_prs_audit`)
    }
  }
  return offenders
}

/**
 * Every migration strictly after MIGRATION_FILE that GRANTs EXECUTE on the pinned function to
 * anon, authenticated or PUBLIC (SMI-6114 retro F1, revert check (f)). Splits each migration into
 * `;`-delimited statements so a GRANT on some unrelated function does not false-positive just
 * because the pinned function name appears elsewhere in the same file.
 */
function grantExecuteViolations(): string[] {
  const offenders: string[] = []
  const nameRe = new RegExp(String.raw`\b${FUNCTION_NAME}\b`, 'i')
  for (const file of laterMigrationFiles()) {
    const content = readMigration(file)
    if (content === null) continue
    const sql = stripLineComments(content)
    for (const stmt of sql.split(';')) {
      if (!/\bGRANT\b/i.test(stmt) || !/\bEXECUTE\b/i.test(stmt)) continue
      if (!/\bON\s+FUNCTION\b/i.test(stmt) || !nameRe.test(stmt)) continue
      const toIdx = stmt.search(/\bTO\b/i)
      if (toIdx === -1) continue
      if (/\b(anon|authenticated|PUBLIC)\b/i.test(stmt.slice(toIdx))) {
        offenders.push(`${file}: ${stmt.trim().replace(/\s+/g, ' ').slice(0, 160)}`)
      }
    }
  }
  return offenders
}

describe.skipIf(locked)('20260913000000_private_registry_audit_trigger.sql (SMI-6114)', () => {
  const sql = triggerSql ?? ''
  const code = stripLineComments(sql)

  it(
    'parses every CREATE FUNCTION mention of audit_private_registry_skills_change() -- fails ' +
      'closed on anything it cannot read (SMI-6114 retro F1)',
    () => {
      const mentionCounts = new Map<string, number>()
      for (const file of allMigrationFiles()) {
        const content = readMigration(file)
        if (content === null) continue
        const n = [...content.matchAll(FUNCTION_CREATE_MENTION_RE)].length
        if (n > 0) mentionCounts.set(file, n)
      }
      const defCounts = new Map<string, number>()
      for (const d of allFunctionDefinitions()) {
        defCounts.set(d.file, (defCounts.get(d.file) ?? 0) + 1)
      }
      const unparsed = [...mentionCounts.entries()]
        .filter(([file, count]) => (defCounts.get(file) ?? 0) < count)
        .map(
          ([file, count]) =>
            `${file}: ${count} CREATE FUNCTION mention(s), only ${defCounts.get(file) ?? 0} parsed`
        )
      expect(
        unparsed,
        'a migration CREATEs the function in a form this parser cannot read'
      ).toEqual([])
    }
  )

  it(
    'pins the function header (RETURNS / LANGUAGE / SECURITY DEFINER / SET search_path) against ' +
      'a reviewed hash -- ADR-164 (SMI-6114 retro F1/F2)',
    () => {
      const defs = allFunctionDefinitions()
      // Denominator first: an empty defs list would make the hash check below vacuous.
      expect(defs.length, 'no parseable definition found in any migration').toBeGreaterThan(0)
      const header = normalizeSql(defs[defs.length - 1].header)
      expect(
        sha256(header),
        'the function header changed -- review against ADR-164 before updating PINNED_HEADER_SHA256'
      ).toBe(PINNED_HEADER_SHA256)
    }
  )

  it('pins the function body against a reviewed hash -- ADR-164 (SMI-6114 retro F1/F2)', () => {
    const defs = allFunctionDefinitions()
    expect(defs.length, 'no parseable definition found in any migration').toBeGreaterThan(0)
    const body = normalizeSql(defs[defs.length - 1].body)
    expect(
      sha256(body),
      'the function body changed -- review against ADR-164 before updating PINNED_BODY_SHA256'
    ).toBe(PINNED_BODY_SHA256)
  })

  it('pins the triggers trg_prs_audit and trg_prs_audit_truncate against reviewed expected text (SMI-6114 retro F1)', () => {
    const auditDefs = triggerDefinitions('trg_prs_audit')
    const truncateDefs = triggerDefinitions('trg_prs_audit_truncate')
    expect(
      auditDefs.length,
      'trg_prs_audit: no CREATE TRIGGER found in any migration'
    ).toBeGreaterThan(0)
    expect(
      truncateDefs.length,
      'trg_prs_audit_truncate: no CREATE TRIGGER found in any migration'
    ).toBeGreaterThan(0)
    expect(auditDefs[auditDefs.length - 1].text).toBe(EXPECTED_TRG_PRS_AUDIT)
    expect(truncateDefs[truncateDefs.length - 1].text).toBe(EXPECTED_TRG_PRS_AUDIT_TRUNCATE)
  })

  it('no later migration drops or alters the pinned function or triggers by name (SMI-6114 retro F1)', () => {
    expect(triggerOrFunctionTamperViolations()).toEqual([])
  })

  it(
    'revokes EXECUTE from anon and authenticated (Check 51/52), and no later migration re-grants ' +
      'it to anon, authenticated or PUBLIC (SMI-6114)',
    () => {
      // Scoped to MIGRATION_FILE only (not every migration): the whole-directory form picks up
      // pre-existing, out-of-scope SECDEF functions elsewhere in the migration history (e.g.
      // 20260819000002_fix_check_team_tier_access.sql) that are this test's business no more than
      // they were before -- broadening this call is not what "keep the existing check" meant.
      expect(
        helpers.auditSecdefAnonGrants([{ name: MIGRATION_FILE, content: sql }], {
          cutoff: '20260704000000',
        })
      ).toEqual([])
      expect(grantExecuteViolations()).toEqual([])
    }
  )

  it('fails closed: the function body has no exception handler around the audit write, in the LATEST definition', () => {
    expect(latestFunctionBody()).not.toMatch(/\bEXCEPTION\b/i)
  })

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

  it('compares every private_registry_skills column the migrations create, in the LATEST definition', () => {
    const columns = columnsFromMigrations()
    // Denominator first: an extractor that found nothing would make the loop below vacuous.
    expect([...columns].sort()).toEqual([...PROD_COLUMNS].sort())
    const body = latestFunctionBody()
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
