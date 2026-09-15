/**
 * SMI-6114 / SMI-6680: the raw-text pins (function header/body sha256, exact trigger text) for
 * `audit_private_registry_skills_change()` and its two triggers, plus the column-coverage check
 * they feed. Split out of the single ~1000-line test file (SMI-6680 governance retro) so every
 * non-test file here stays under the repo's 500-line gate. See
 * `private-registry-audit-trigger.static.test.ts`'s module doc comment for the full MODEL
 * (pin vs. tripwire) and DOES-NOT-DETECT list -- this file only holds the pin *mechanics*.
 */

import { createHash } from 'node:crypto'
import { splitStatements, stripLineComments } from './private-registry-audit-trigger.scanner.ts'
import {
  FUNCTION_NAME,
  allMigrationFiles,
  readMigration,
} from './private-registry-audit-trigger.migrations.ts'

export const sha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex')

/**
 * Matches every CREATE [OR REPLACE] FUNCTION definition of audit_private_registry_skills_change(),
 * across optional `public.` (quoted or not) schema qualification, any dollar-quote tag (matched
 * via backreference), and any case. Captures the header (between the empty arg list and `AS`) and
 * the body separately, so both can be pinned independently. Measured against an 11-case table
 * before being written down (SMI-6114 retro gate finding F1, PR #2855).
 */
export const DEF_RE = new RegExp(
  String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:(?:"?public"?)\s*\.\s*)?"?${FUNCTION_NAME}"?\s*\(\s*\)([\s\S]*?)\bAS\s+(\$[A-Za-z_]*\$)([\s\S]*?)\2`,
  'gi'
)

/**
 * Counts every CREATE [OR REPLACE] FUNCTION mention of the same name and empty arg list --
 * deliberately looser than DEF_RE (no AS-body requirement), so a body DEF_RE cannot parse still
 * counts as a mention. The fail-closed check in the static test file compares this count to
 * DEF_RE's per-file match count and fails on any gap, instead of silently treating the unparsed
 * definition as absent.
 */
export const FUNCTION_CREATE_MENTION_RE = new RegExp(
  String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:(?:"?public"?)\s*\.\s*)?"?${FUNCTION_NAME}"?\s*\(\s*\)`,
  'gi'
)

export interface FunctionDefinition {
  file: string
  header: string
  body: string
}

/**
 * Every audit_private_registry_skills_change() definition across ALL migrations in `dir`, in
 * filename order, header and body RAW (not comment-stripped). A later migration that redefines
 * the function with `CREATE OR REPLACE FUNCTION` is the realistic change path once 20260913000000
 * is applied to staging, so the checks that use this must look at the LATEST definition, not just
 * this one file (SMI-6114 retro F2).
 */
export function allFunctionDefinitions(dir?: string): FunctionDefinition[] {
  const defs: FunctionDefinition[] = []
  for (const file of allMigrationFiles(dir)) {
    const content = readMigration(file, dir)
    if (content === null) continue
    for (const m of content.matchAll(DEF_RE)) {
      defs.push({ file, header: m[1], body: m[3] })
    }
  }
  return defs
}

export function latestFunctionDefinition(dir?: string): FunctionDefinition {
  const defs = allFunctionDefinitions(dir)
  if (defs.length === 0) {
    throw new Error('No audit_private_registry_skills_change() definition found in any migration')
  }
  return defs[defs.length - 1]
}

/** Comment-stripped (but not whitespace-normalized) body of the LATEST definition. */
export function latestFunctionBody(dir?: string): string {
  return stripLineComments(latestFunctionDefinition(dir).body)
}

/**
 * Every `private_registry_skills` column the migration history in `dir` creates: the CREATE TABLE
 * column list, plus ADD COLUMN, minus DROP COLUMN, across all migrations. The initial CREATE TABLE
 * column list is matched with LINE comments stripped only (not block comments -- a block-commented
 * column in the CREATE TABLE body would still count; caught by the PROD_COLUMNS equality check
 * that consumes this, not by this extractor) (SMI-6680 F9). The ADD/DROP COLUMN scan below uses
 * `splitStatements()` (SMI-6680 F2 sweep, coordinator follow-up) instead of a naive `sql.split(';')`
 * -- the same defect shape found in the three detector functions: a semicolon inside a string
 * literal earlier in the same ALTER TABLE statement (e.g. a DEFAULT clause) used to sever the
 * table reference from its own ADD/DROP COLUMN clause into two different chunks, silently
 * dropping the column from this set. `splitStatements()` is also fully comment-safe (both line
 * and block), so this half of the function is stricter than the CREATE TABLE half above.
 */
export function columnsFromMigrations(dir?: string): Set<string> {
  const columns = new Set<string>()
  for (const file of allMigrationFiles(dir)) {
    const content = readMigration(file, dir)
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
    for (const stmt of splitStatements(sql)) {
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
 * PINNED (SMI-6114, PR #2855 round-2 retro, finding 4). Changing either hash requires a security
 * review against ADR-164 (no text columns copied, `team_id` only under the untag rule, fails
 * closed): update the pin only after that review, and say so in the PR. Computed from the RAW
 * header/body DEF_RE captures, sha256 hex digest, NO comment stripping, NO whitespace collapsing --
 * a comment-only or whitespace-only edit to the function now changes this hash, and that is
 * intended: every edit gets reviewed, not just semantic ones.
 */
export const PINNED_HEADER_SHA256 =
  '8e5be9781814e5026ef64be2396c75055321d51858293a11811c376a61b03c04'
export const PINNED_BODY_SHA256 = 'b075d28db93da60b7e012e6f87957b6c03eb2ccdab7ef724de99e5ea66082ca1'

export interface TriggerDefinition {
  file: string
  text: string
}

/**
 * Every `CREATE [OR REPLACE] TRIGGER <name> ... ;` statement for the given trigger name, across
 * all migrations in `dir`, RAW -- no comment stripping, no whitespace collapsing (same reasoning as
 * the function header/body hashes above).
 */
export function triggerDefinitions(name: string, dir?: string): TriggerDefinition[] {
  const re = new RegExp(
    String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+"?${name}"?\b[\s\S]*?;`,
    'gi'
  )
  const defs: TriggerDefinition[] = []
  for (const file of allMigrationFiles(dir)) {
    const content = readMigration(file, dir)
    if (content === null) continue
    for (const m of content.matchAll(re)) {
      defs.push({ file, text: m[0] })
    }
  }
  return defs
}

/** PINNED (SMI-6114). Exact RAW `CREATE OR REPLACE TRIGGER ...` text, computed from the
 * currently-approved migration the same way as the function hashes above. */
export const EXPECTED_TRG_PRS_AUDIT =
  'CREATE OR REPLACE TRIGGER trg_prs_audit\n' +
  '  AFTER INSERT OR UPDATE OR DELETE ON private_registry_skills\n' +
  '  FOR EACH ROW EXECUTE FUNCTION audit_private_registry_skills_change();'
export const EXPECTED_TRG_PRS_AUDIT_TRUNCATE =
  'CREATE OR REPLACE TRIGGER trg_prs_audit_truncate\n' +
  '  AFTER TRUNCATE ON private_registry_skills\n' +
  '  FOR EACH STATEMENT EXECUTE FUNCTION audit_private_registry_skills_change();'

/**
 * Failure-message builder for the four raw-text pins above (SMI-6680 F5). Previously the header
 * and body pins carried a generic "review against ADR-164" message with no file name, and the two
 * trigger pins had no message at all -- a reader hit a bare multi-line-string diff. Names the exact
 * migration file the latest (pinned) definition came from, and says plainly that a comment-only or
 * whitespace-only edit trips the check too -- the single most surprising property of this design,
 * previously explained only in this suite's module-level doc comment, never in the failure a
 * maintainer actually sees.
 */
export const pinRemediation = (what: string, file: string, constant: string): string =>
  `${what} changed in ${file}. A comment-only or whitespace-only edit trips this too, by design ` +
  `(raw text is hashed/compared, not normalized -- see this file's own header). Review the diff ` +
  `against ADR-164, then set ${constant} to the "Received" value above and say in the PR that ` +
  'you did the review.'
