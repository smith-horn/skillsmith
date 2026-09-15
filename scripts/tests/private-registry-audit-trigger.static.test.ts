/**
 * SMI-6114: an HONEST TRIPWIRE for
 * supabase/migrations/20260913000000_private_registry_audit_trigger.sql -- NOT a security
 * boundary. Text scanning cannot be one: a third adversarial review round (the round-2 gate on
 * PR #2855, which prompted this rescope) kept finding new bypass classes the previous rewrite
 * hadn't closed (Postgres disables a trigger through
 * ALTER TABLE, not ALTER TRIGGER; a second, differently-named trigger on the same table is outside
 * any name-pinned check; the audit sink itself, audit_logs, can be rewritten out from under an
 * unchanged function via CREATE RULE). Rather than chase a fourth bypass class with a fifth regex,
 * the owner rescoped this file: it is a tripwire that forces a human to look at any migration that
 * touches this trigger, this function, or its audit_logs sink, not a proof that no unreviewed
 * change can happen. THE REAL INVARIANT (one row per committed change, no text columns copied, the
 * untag rule) is enforced by live-Postgres suites once SMI-5946 wires Postgres into CI:
 * `private-registry-audit-trigger.test.ts` (row-shape / fail-closed / actor derivation) and
 * `private-registry-audit-visibility.test.ts` (audit visibility never exceeds data visibility).
 * Both skip today without a test database and do not run in CI yet.
 *
 * WHAT THIS FILE DOES NOT, AND CANNOT, DETECT:
 *   - role-membership grants (`GRANT audit_runner TO authenticated;`) that hand a broader role the
 *     EXECUTE privilege this file's own GRANT check already denies to that role by name, or any
 *     other GRANT/REVOKE against audit_logs itself (e.g. `REVOKE INSERT ON audit_logs FROM ...`);
 *   - RLS policy changes on audit_logs (`CREATE POLICY`, `ALTER POLICY`, `DROP POLICY`, or
 *     `ENABLE`/`DISABLE ROW LEVEL SECURITY`) that narrow or widen who can read or write the sink;
 *   - a retention/cleanup job (a pg_cron `DELETE FROM audit_logs ...` or similar scheduled job)
 *     that prunes rows the pinned insert wrote;
 *   - dynamic SQL assembled inside a `DO $$ ... $$` block or an `EXECUTE '...'` string, where the
 *     protected keywords never appear as contiguous, parseable statement text;
 *   - any change applied outside a migration file altogether (a manual `psql` session against
 *     prod, for instance) -- this file only ever reads `supabase/migrations/`.
 *
 * MODEL:
 *   1. THE PIN FORCES HUMAN REVIEW OF ANY CHANGE, INCLUDING A COMMENT. A fail-closed parser
 *      (DEF_RE) finds every CREATE [OR REPLACE] FUNCTION of audit_private_registry_skills_change()
 *      across all migrations regardless of schema qualification, dollar-quote tag or case, and a
 *      separate mention counter catches anything DEF_RE could not parse (e.g. a single-quoted
 *      `AS '...'` body) instead of silently ignoring it (gate finding F1). The latest definition's
 *      RAW header and body -- no comment stripping, no whitespace collapsing -- are pinned by
 *      sha256: any change to either, down to a single added comment, must change the pinned hash,
 *      which means a human has to look at the diff and update the constant. Hashing the raw text
 *      (not a normalized form) is deliberate: a prior version of this file stripped `/* *\/`
 *      comments before hashing, which let a body change hide inside what looked like a comment
 *      (`'database_trigger'` -> `'data/*ignored*\/base_trigger'` normalizes back to the original
 *      string but changes what actually runs) -- round-2 gate finding 4. The triggers are pinned
 *      the same way, against exact raw expected text.
 *   2. THREE MORE FAIL-CLOSED CHECKS, ONE PER ROUND-2 GATE FINDING, EACH EXEMPTABLE ONLY BY NAME.
 *      A later migration that disables either audit trigger via `ALTER TABLE ... DISABLE TRIGGER`
 *      (Postgres does not use `ALTER TRIGGER` for this -- gate finding 1), that creates ANY new
 *      trigger on `private_registry_skills` or ANY overload of
 *      `audit_private_registry_skills_change` regardless of name (gate finding 2), or that
 *      rewrites, drops, renames or adds a trigger/rule to the `audit_logs` sink itself, or changes
 *      its column shape underneath the pinned insert -- `DROP COLUMN`, `ALTER COLUMN ... TYPE` /
 *      `SET DATA TYPE`, `RENAME COLUMN`, `RENAME TO`, `SET NOT NULL`, or `ADD CONSTRAINT` /
 *      `ADD CHECK` (gate finding 3, extended by round-3 gate finding 1) -- fails this suite. All
 *      three scans, plus the by-name tamper and GRANT scans, run against comment-stripped text
 *      (`stripComments()`, round-3 gate finding 2) so a block comment mentioning any of these
 *      shapes cannot false-positive and a real statement hidden after one cannot false-negative.
 *      The only way past any of the three is to add the migration's filename to
 *      REVIEWED_LATER_MIGRATIONS below, after review -- never to weaken the regex.
 *   3. THE SEMANTIC CHECKS DOCUMENT WHY THE PINNED BODY WAS APPROVED, not police future changes:
 *      no EXCEPTION handler (fail-closed), the exact untag CASE, one team_id write, and full
 *      column coverage. They run against the LATEST parsed definition (not just this file) so
 *      they keep describing reality after a future reviewed redefinition, but the pin above -- not
 *      these regexes -- is what makes a bad change fail loudly.
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
 * Strips both `--` line comments and `/* ... *\/` block comments (Postgres allows nesting, so this
 * tracks depth) WITHOUT touching text inside single-quoted string literals, escape-string literals
 * (`E'...'` / `e'...'`), or dollar-quoted bodies (`$$ ... $$` / `$tag$ ... $tag$`) -- a
 * character-scanning state machine, not a regex, since comment/string/dollar-quote nesting isn't a
 * regular language. Used only by the checks that need to see through comments to find a real
 * statement, or avoid a false-positive on a commented-out example: the disabled-trigger,
 * later-trigger and audit-sink tripwires, plus the by-name tamper and GRANT scans. NEVER applied to
 * the raw function/trigger pins above -- those hash/compare the exact text, comments included, by
 * design (round-2 gate finding 4). Verified against a 5-case table (a block comment containing a
 * fake CREATE RULE, a string literal containing `/* x *\/`, a dollar-quoted body containing `--`,
 * nested `/* /* *\/ *\/`, and a real CREATE RULE right after a comment) before being relied on
 * (SMI-6114 retro round 3, gate finding 2, PR #2855).
 *
 * ASSUMES `standard_conforming_strings = on` (Postgres' default, and this project's): in a plain
 * `'...'` string a backslash is a literal character and `''` is the only way to embed a quote, so
 * the plain-string branch below never treats `\` specially. An `E'...'`/`e'...'` ESCAPE string is
 * different regardless of that setting -- Postgres always interprets backslash escapes inside one,
 * so `\` there DOES escape the next character, including a quote (`E'prefix \' /*'` is one complete
 * string, not one that ends at the `\'`). A prior version of this scanner had no E-string branch and
 * fell through to the plain-string rule, which closes at that `\'` early because it never treats `\`
 * as an escape -- turning the text after it (`/*';\nALTER TABLE ...`) into what looks like a real
 * block comment, hiding a real statement from every check below (round-4 gate finding, PR #2855).
 * Escape strings also still allow the doubled-quote `''` embed alongside `\'` (Postgres accepts
 * both), and the `E`/`e` is only recognized as an escape-string opener when it is not the tail of a
 * longer identifier -- checked via the character immediately before it, so `type'x'` parses as
 * plain text followed by an ordinary string, not as an (invalid) escape-string opener. Verified
 * against a 5-case table (the exact hidden-DROP shape above, a real backslash-escaped backslash
 * `e'\\'` ahead of a real statement, doubled quotes inside an escape string `E'it''s'`, the
 * preceding-identifier-char guard via `type'x'`/`CASE'...'`, and a plain string ending at the quote
 * right after a backslash) before being relied on (SMI-6114 retro round 4, PR #2855) -- see the
 * `stripComments()` `it()` blocks below.
 */
function stripComments(sql: string): string {
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    const c2 = i + 1 < n ? sql[i + 1] : ''
    if ((c === 'E' || c === 'e') && c2 === "'" && !/[A-Za-z0-9_]/.test(i > 0 ? sql[i - 1] : '')) {
      // Postgres escape-string literal: E'...' / e'...', recognized only when the E/e isn't the
      // tail of a longer identifier (the preceding-character check above). Inside one, a backslash
      // escapes the next character -- including a quote -- and, same as a plain string, '' still
      // embeds a literal quote (Postgres allows both forms in an escape string).
      let j = i + 2
      while (j < n) {
        if (sql[j] === '\\') {
          j += 2
          continue
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2
            continue
          }
          j += 1
          break
        }
        j += 1
      }
      out += sql.slice(i, j)
      i = j
      continue
    }
    if (c === "'") {
      // Single-quoted string literal: '' is an escaped quote, not a terminator. Under
      // standard_conforming_strings=on a backslash here is a literal character, not an escape, so
      // (unlike the E-string branch above) it is never special-cased.
      let j = i + 1
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2
            continue
          }
          j += 1
          break
        }
        j += 1
      }
      out += sql.slice(i, j)
      i = j
      continue
    }
    if (c === '$') {
      // Dollar-quoted body: $$ ... $$ or $tag$ ... $tag$. Matched by literal tag re-occurrence,
      // not nesting -- Postgres dollar-quote bodies do not nest with the same tag.
      const tagMatch = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i))
      if (tagMatch) {
        const tag = tagMatch[0]
        const closeIdx = sql.indexOf(tag, i + tag.length)
        const end = closeIdx === -1 ? n : closeIdx + tag.length
        out += sql.slice(i, end)
        i = end
        continue
      }
    }
    if (c === '-' && c2 === '-') {
      // Line comment: drop through end of line, keep the newline itself (matches
      // stripLineComments' own behavior above).
      let j = sql.indexOf('\n', i)
      if (j === -1) j = n
      i = j
      continue
    }
    if (c === '/' && c2 === '*') {
      // Block comment, Postgres-style nested: track depth, drop the whole span including any
      // nested /* ... */ inside it.
      let depth = 1
      let j = i + 2
      while (j < n && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth += 1
          j += 2
          continue
        }
        if (sql[j] === '*' && sql[j + 1] === '/') {
          depth -= 1
          j += 2
          continue
        }
        j += 1
      }
      i = j
      continue
    }
    out += c
    i += 1
  }
  return out
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/**
 * List of migrations exempt from the three fail-closed checks below (disabled triggers, any other
 * trigger/overload on private_registry_skills, tampering with the audit_logs sink) -- EMPTY BY
 * DEFAULT. Add a filename only after reviewing that migration against ADR-164. This never exempts
 * the pin checks above: a reviewed later migration that also redefines the function still has to
 * carry a matching PINNED_HEADER_SHA256 / PINNED_BODY_SHA256 update, reviewed the same way (SMI-6114
 * retro round 2, item 5).
 *
 *   REVIEWED_LATER_MIGRATIONS: string[] = [
 *     // '20991231000000_example.sql', // reviewed by <name> on <yyyy-mm-dd>: <why this is safe>
 *   ]
 */
const REVIEWED_LATER_MIGRATIONS: string[] = []

/** Standard remediation text appended to every fail-closed offender message below. */
const reviewRemediation = (file: string): string =>
  `If this change is intended, review it against ADR-164, then add ${file} to ` +
  'REVIEWED_LATER_MIGRATIONS with the reviewer and date.'

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
 * PINNED (SMI-6114, PR #2855 round-2 retro, finding 4). Changing either hash requires a security
 * review against ADR-164 (no text columns copied, `team_id` only under the untag rule, fails
 * closed): update the pin only after that review, and say so in the PR.
 *
 * Computed from the RAW header/body DEF_RE captures of the currently-approved migration -- sha256
 * hex digest of the exact text, with NO comment stripping and NO whitespace collapsing. Raw, not
 * normalized: normalizing before hashing is what let a comment-shaped edit change runtime behaviour
 * without changing the pin (gate finding 4 -- `'database_trigger'` -> a string that LOOKS like it
 * has a block comment inside it but is really a different literal). A comment-only or
 * whitespace-only edit to the function now changes this hash, and that is intended: every edit gets
 * reviewed, not just semantic ones.
 */
const PINNED_HEADER_SHA256 = '8e5be9781814e5026ef64be2396c75055321d51858293a11811c376a61b03c04'
const PINNED_BODY_SHA256 = 'b075d28db93da60b7e012e6f87957b6c03eb2ccdab7ef724de99e5ea66082ca1'

/**
 * Every `CREATE [OR REPLACE] TRIGGER <name> ... ;` statement for the given trigger name, across
 * all migrations, RAW -- no comment stripping, no whitespace collapsing (SMI-6114 retro round 2,
 * finding 4: the pin has to see the exact text, the same reasoning as the function header/body
 * hashes above). `\b` after the name keeps `trg_prs_audit` from matching as a prefix of
 * `trg_prs_audit_truncate` (both `t` and `_` are word characters, so no boundary exists between
 * them) -- verified against a two-trigger fixture before being relied on.
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
      defs.push({ file, text: m[0] })
    }
  }
  return defs
}

/** PINNED (SMI-6114). Exact RAW `CREATE OR REPLACE TRIGGER ...` text (including the migration's
 * own line breaks and indentation), computed from the currently-approved migration the same way
 * as the function hashes above -- not normalized, so a comment or reformatting change inside the
 * statement also fails this check. */
const EXPECTED_TRG_PRS_AUDIT =
  'CREATE OR REPLACE TRIGGER trg_prs_audit\n' +
  '  AFTER INSERT OR UPDATE OR DELETE ON private_registry_skills\n' +
  '  FOR EACH ROW EXECUTE FUNCTION audit_private_registry_skills_change();'
const EXPECTED_TRG_PRS_AUDIT_TRUNCATE =
  'CREATE OR REPLACE TRIGGER trg_prs_audit_truncate\n' +
  '  AFTER TRUNCATE ON private_registry_skills\n' +
  '  FOR EACH STATEMENT EXECUTE FUNCTION audit_private_registry_skills_change();'

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
    const sql = stripComments(content)
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
    const sql = stripComments(content)
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

/** Regex source for `[public.]private_registry_skills`, optionally quoted, either half optional. */
const TABLE_REF_SRC = String.raw`(?:"?public"?\s*\.\s*)?"?private_registry_skills"?`
/** Regex source for `[public.]audit_logs`, optionally quoted, either half optional. */
const AUDIT_LOGS_REF_SRC = String.raw`(?:"?public"?\s*\.\s*)?"?audit_logs"?`
/** A trigger target for DISABLE TRIGGER: any bare/quoted identifier, or the keywords ALL/USER. */
const ANY_TRIGGER_TARGET_SRC = String.raw`(?:"?[A-Za-z_][A-Za-z0-9_]*"?|ALL|USER)`
/** A trigger target scoped to the two audit triggers (or ALL/USER, which include them). */
const AUDIT_TRIGGER_TARGET_SRC = String.raw`(?:"?trg_prs_audit_truncate"?|"?trg_prs_audit"?|ALL|USER)`

/**
 * Every migration strictly after MIGRATION_FILE that disables an audit trigger, or re-enables it
 * under a non-default firing mode, via `ALTER TABLE`. Postgres disables/re-enables a trigger
 * through `ALTER TABLE ... DISABLE|ENABLE TRIGGER`, NOT `ALTER TRIGGER` -- the tamper check above
 * only ever looked at `ALTER TRIGGER`, so a later migration could disable `trg_prs_audit` with
 * every existing static assertion still passing (round-2 gate finding 1). `DISABLE TRIGGER` also
 * accepts the bare keywords ALL and USER as a target, which disable every trigger on the table
 * including ours, so those match too. Case-insensitive, quoted/schema-qualified, matches across
 * line breaks (`\s` includes `\n`). Exempt only via REVIEWED_LATER_MIGRATIONS.
 */
function disableTriggerViolations(): string[] {
  const offenders: string[] = []
  const disableRe = new RegExp(
    String.raw`ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${TABLE_REF_SRC}\s+DISABLE\s+TRIGGER\s+${ANY_TRIGGER_TARGET_SRC}\b`,
    'gi'
  )
  const enableRe = new RegExp(
    String.raw`ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${TABLE_REF_SRC}\s+ENABLE\s+(?:REPLICA|ALWAYS)\s+TRIGGER\s+${AUDIT_TRIGGER_TARGET_SRC}\b`,
    'gi'
  )
  for (const file of laterMigrationFiles()) {
    if (REVIEWED_LATER_MIGRATIONS.includes(file)) continue
    const content = readMigration(file)
    if (content === null) continue
    const sql = stripComments(content)
    for (const m of sql.matchAll(disableRe)) {
      offenders.push(
        `${file}: disables a trigger on private_registry_skills -- ` +
          `${m[0].replace(/\s+/g, ' ').trim()}. ${reviewRemediation(file)}`
      )
    }
    for (const m of sql.matchAll(enableRe)) {
      offenders.push(
        `${file}: re-enables an audit trigger under a non-default firing mode -- ` +
          `${m[0].replace(/\s+/g, ' ').trim()}. ${reviewRemediation(file)}`
      )
    }
  }
  return offenders
}

/**
 * Every migration strictly after MIGRATION_FILE that either (a) CREATEs ANY trigger --
 * whatever its name, timing, event list or backing function -- on private_registry_skills, or
 * (b) redefines audit_private_registry_skills_change() with a non-empty argument list (an
 * overload). Neither shape is visible to DEF_RE or the by-name tamper check above, both of which
 * only ever look at the two pinned trigger names and the zero-arg function signature: a later
 * migration is free to add a second, differently-named trigger (or a same-named overload) that
 * writes something else entirely, or nothing at all, while every existing assertion keeps passing
 * (round-2 gate finding 2 -- the gate's own PoC created `trg_prs_snapshot` calling
 * `audit_prs_snapshot()`, an unrelated function). Statement-scoped (split on `;`) so a trigger on
 * an unrelated table, or an unrelated function, does not false-positive. Exempt only via
 * REVIEWED_LATER_MIGRATIONS.
 */
function laterTriggerViolations(): string[] {
  const offenders: string[] = []
  const onTableRe = new RegExp(String.raw`\bON\s+(?:ONLY\s+)?${TABLE_REF_SRC}\b`, 'i')
  const overloadRe = new RegExp(
    String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?public"?\s*\.\s*)?"?${FUNCTION_NAME}"?\s*\(\s*([^()]+)\)`,
    'gi'
  )
  for (const file of laterMigrationFiles()) {
    if (REVIEWED_LATER_MIGRATIONS.includes(file)) continue
    const content = readMigration(file)
    if (content === null) continue
    const sql = stripComments(content)
    for (const stmt of sql.split(';')) {
      if (!/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\b/i.test(stmt)) continue
      if (!onTableRe.test(stmt)) continue
      offenders.push(
        `${file}: unreviewed trigger on private_registry_skills -- ` +
          `${stmt.replace(/\s+/g, ' ').trim().slice(0, 160)}. ${reviewRemediation(file)}`
      )
    }
    for (const m of sql.matchAll(overloadRe)) {
      if (m[1].trim().length === 0) continue // the pinned zero-arg signature; not an overload.
      offenders.push(
        `${file}: unreviewed overload ${FUNCTION_NAME}(${m[1].trim()}). ${reviewRemediation(file)}`
      )
    }
  }
  return offenders
}

/**
 * Every migration strictly after MIGRATION_FILE that rewrites, drops, renames, or adds a
 * trigger/rule to the audit_logs sink itself: `CREATE [OR REPLACE] RULE ... TO audit_logs`,
 * `CREATE [OR REPLACE] [CONSTRAINT] TRIGGER ... ON audit_logs`, `DROP TABLE audit_logs`,
 * `ALTER TABLE audit_logs ... RENAME`, or `ALTER TABLE audit_logs ... DISABLE TRIGGER` -- OR that
 * changes the sink's column shape underneath the pinned insert: `ALTER TABLE audit_logs ...
 * DROP COLUMN`, `ALTER COLUMN ... TYPE` / `SET DATA TYPE`, `SET NOT NULL`, or `ADD CONSTRAINT` /
 * `ADD CHECK` (round-3 gate finding 1, PR #2855 -- any of these can make the pinned
 * `INSERT INTO audit_logs` fail outright, or accept it while silently storing something other
 * than what the pinned function body computed). The function pin only protects the write --
 * `INSERT INTO audit_logs`; it says nothing about what happens to that INSERT once the statement
 * leaves the trigger, and a rule on audit_logs can turn it into a no-op without the function
 * changing at all (round-2 gate finding 3 -- the gate's own PoC was `CREATE RULE
 * suppress_registry_audit AS ON INSERT TO public.audit_logs ... DO INSTEAD NOTHING`; note CREATE
 * RULE's table reference uses `TO`, not `ON` -- `ON` in that grammar introduces the event).
 * Statement-scoped, and run against stripComments()-cleaned text (round-3 gate finding 2) so a
 * block comment mentioning any of the above cannot false-positive and a real statement hidden
 * right after one cannot false-negative. Exempt only via REVIEWED_LATER_MIGRATIONS. This still
 * cannot see an RLS policy change, a `REVOKE INSERT`, a retention job, a broader role grant, or
 * dynamic SQL against audit_logs -- see the file-header DOES NOT DETECT list.
 */
function auditSinkViolations(): string[] {
  const offenders: string[] = []
  const ruleToAuditLogsRe = new RegExp(String.raw`\bTO\s+${AUDIT_LOGS_REF_SRC}\b`, 'i')
  const triggerOnAuditLogsRe = new RegExp(
    String.raw`\bON\s+(?:ONLY\s+)?${AUDIT_LOGS_REF_SRC}\b`,
    'i'
  )
  const dropAuditLogsRe = new RegExp(
    String.raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?${AUDIT_LOGS_REF_SRC}\b`,
    'i'
  )
  const alterAuditLogsRe = new RegExp(
    String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${AUDIT_LOGS_REF_SRC}\b`,
    'i'
  )
  // Column-shape changes to audit_logs (round-3 gate finding 1). Each is only checked within a
  // statement already confirmed to be an ALTER TABLE against audit_logs (alterAuditLogsRe above),
  // so these can stay loose keyword matches without false-positiving on unrelated tables.
  const dropColumnRe = /\bDROP\s+COLUMN\b/i
  const alterColumnTypeRe =
    /\bALTER\s+COLUMN\s+"?[A-Za-z_][A-Za-z0-9_]*"?\s+(?:SET\s+DATA\s+)?TYPE\b/i
  const setNotNullRe = /\bSET\s+NOT\s+NULL\b/i
  const addConstraintRe = /\bADD\s+(?:CONSTRAINT|CHECK)\b/i
  for (const file of laterMigrationFiles()) {
    if (REVIEWED_LATER_MIGRATIONS.includes(file)) continue
    const content = readMigration(file)
    if (content === null) continue
    const sql = stripComments(content)
    for (const stmt of sql.split(';')) {
      const trimmed = () => stmt.replace(/\s+/g, ' ').trim().slice(0, 160)
      if (/\bCREATE\s+(?:OR\s+REPLACE\s+)?RULE\b/i.test(stmt) && ruleToAuditLogsRe.test(stmt)) {
        offenders.push(
          `${file}: CREATE RULE targeting audit_logs -- ${trimmed()}. ${reviewRemediation(file)}`
        )
      }
      if (
        /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\b/i.test(stmt) &&
        triggerOnAuditLogsRe.test(stmt)
      ) {
        offenders.push(
          `${file}: CREATE TRIGGER on audit_logs -- ${trimmed()}. ${reviewRemediation(file)}`
        )
      }
      if (dropAuditLogsRe.test(stmt)) {
        offenders.push(`${file}: DROP TABLE audit_logs -- ${trimmed()}. ${reviewRemediation(file)}`)
      }
      if (alterAuditLogsRe.test(stmt) && /\bRENAME\b/i.test(stmt)) {
        offenders.push(
          `${file}: ALTER TABLE audit_logs ... RENAME -- ${trimmed()}. ${reviewRemediation(file)}`
        )
      }
      if (alterAuditLogsRe.test(stmt) && /\bDISABLE\s+TRIGGER\b/i.test(stmt)) {
        offenders.push(
          `${file}: ALTER TABLE audit_logs ... DISABLE TRIGGER -- ${trimmed()}. ` +
            reviewRemediation(file)
        )
      }
      if (alterAuditLogsRe.test(stmt) && dropColumnRe.test(stmt)) {
        offenders.push(
          `${file}: ALTER TABLE audit_logs ... DROP COLUMN -- ${trimmed()}. ` +
            reviewRemediation(file)
        )
      }
      if (alterAuditLogsRe.test(stmt) && alterColumnTypeRe.test(stmt)) {
        offenders.push(
          `${file}: ALTER TABLE audit_logs ... ALTER COLUMN ... TYPE -- ${trimmed()}. ` +
            reviewRemediation(file)
        )
      }
      if (alterAuditLogsRe.test(stmt) && setNotNullRe.test(stmt)) {
        offenders.push(
          `${file}: ALTER TABLE audit_logs ... SET NOT NULL -- ${trimmed()}. ` +
            reviewRemediation(file)
        )
      }
      if (alterAuditLogsRe.test(stmt) && addConstraintRe.test(stmt)) {
        offenders.push(
          `${file}: ALTER TABLE audit_logs ... ADD CONSTRAINT/CHECK -- ${trimmed()}. ` +
            reviewRemediation(file)
        )
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
      const header = defs[defs.length - 1].header // RAW: no comment stripping, no normalizing.
      expect(
        sha256(header),
        'the function header changed -- review against ADR-164 before updating PINNED_HEADER_SHA256'
      ).toBe(PINNED_HEADER_SHA256)
    }
  )

  it('pins the function body against a reviewed hash -- ADR-164 (SMI-6114 retro F1/F2)', () => {
    const defs = allFunctionDefinitions()
    expect(defs.length, 'no parseable definition found in any migration').toBeGreaterThan(0)
    const body = defs[defs.length - 1].body // RAW: no comment stripping, no normalizing.
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
    'no later migration disables an audit trigger via ALTER TABLE, or re-enables it under a ' +
      'non-default firing mode (SMI-6114 retro round 2, finding 1)',
    () => {
      expect(disableTriggerViolations()).toEqual([])
    }
  )

  it(
    'no later migration creates another trigger on private_registry_skills, or an overload of ' +
      'the pinned function (SMI-6114 retro round 2, finding 2)',
    () => {
      expect(laterTriggerViolations()).toEqual([])
    }
  )

  it(
    'no later migration rewrites, drops, renames or adds a trigger/rule to the audit_logs sink ' +
      '(SMI-6114 retro round 2, finding 3)',
    () => {
      expect(auditSinkViolations()).toEqual([])
    }
  )

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

/**
 * stripComments() escape-string case table (SMI-6114 retro round 4, gate finding on PR #2855).
 * Deliberately NOT gated by describe.skipIf(locked): stripComments() is a pure function of its
 * string argument and reads no migration file, so these regression cases must keep running even
 * when supabase/migrations/ is git-crypt-locked -- unlike the suite above, which needs the real
 * pinned migration content. Each case was executed against this exact implementation (node, outside
 * vitest) before being written down here, per the repo's "measure, don't reason" rule.
 */
describe('stripComments() escape-string handling (SMI-6114 retro round 4)', () => {
  it(
    "does not let a Postgres escape string's own /* hide a real statement after it -- the " +
      "reviewer's exact case (gate round 4)",
    () => {
      const sql =
        "SELECT E'prefix \\' /*';\n" +
        'ALTER TABLE public.audit_logs DROP COLUMN metadata;\n' +
        '/* ordinary comment */'
      const stripped = stripComments(sql)
      // The real ALTER TABLE, hidden by the pre-fix parser closing the E-string early at \', stays
      // visible to auditSinkViolations() ...
      expect(stripped).toMatch(/ALTER\s+TABLE\s+public\.audit_logs\s+DROP\s+COLUMN\s+metadata/)
      // ... and the real trailing block comment is still genuinely stripped, not left behind by an
      // over-correction that stops treating anything named /* as a comment.
      expect(stripped).not.toMatch(/ordinary comment/)
    }
  )

  it(
    "handles a real backslash-escaped backslash inside an escape string (e'\\\\'), without " +
      'losing the statement that follows it',
    () => {
      const sql =
        "SELECT e'\\\\';\n" +
        'CREATE RULE suppress_registry_audit AS ON INSERT TO audit_logs DO INSTEAD NOTHING;'
      const stripped = stripComments(sql)
      expect(stripped).toMatch(/CREATE\s+(?:OR\s+REPLACE\s+)?RULE\s+suppress_registry_audit/)
    }
  )

  it(
    "allows doubled quotes inside an escape string (E'it''s'), which Postgres accepts " +
      'alongside backslash-escaping within the same literal',
    () => {
      // Doubling alone (no backslash in the string) is not a real differentiator here: if an
      // E-string closed too early because doubling were unimplemented, the leftover quote just
      // starts a NEW standard-quoted string, whose own (pre-existing, untouched) doubling support
      // resynchronizes to the same final boundary by coincidence -- a broken-doubling
      // implementation would pass this shape identically to a correct one, the exact decorative-
      // test trap CLAUDE.md's SMI-6598 rule warns about. Mixing a doubled pair with a
      // backslash-escaped quote in the SAME literal breaks that coincidence: verified in node that
      // a doubling-unaware E-string scanner mis-closes after "it", then (lacking backslash-escape
      // awareness in the fallback standard-string branch it lands in) also mis-closes the
      // remaining `'s \' fine'` right after the backslash, leaving a stray quote that starts an
      // unterminated string -- which leaves the real comment below un-stripped (still literal
      // "string" content) where the correct implementation strips it.
      const sql =
        "SELECT E'it''s \\' fine';\n" +
        '/* real comment, must be stripped */ ALTER TABLE public.audit_logs DROP COLUMN metadata;'
      const stripped = stripComments(sql)
      expect(stripped).not.toMatch(/real comment/)
      expect(stripped).toMatch(/ALTER\s+TABLE\s+public\.audit_logs\s+DROP\s+COLUMN\s+metadata/)
    }
  )

  it(
    'only treats E/e as an escape-string opener when it is not the tail of a longer ' +
      'identifier, checked via the preceding character',
    () => {
      // `type` ends in 'e', but the character right before it ('p') is an identifier character,
      // so the quote after it is NOT an escape-string opener. This parses as plain text `type`
      // followed by an ordinary single-quoted string 'x' -- not valid SQL on its own (`type` isn't
      // a legal token there), but it proves the scanner doesn't misparse the quote boundary.
      const sanity = "SELECT type'x';"
      expect(stripComments(sanity)).toBe(sanity)

      // Differentiator: CASE also ends in 'E'. If the preceding-character guard were missing, the
      // backslash right before the first quote would be wrongly read as an escape-string escape,
      // swallowing the real comment that follows as literal (unstripped) string content instead of
      // genuinely stripping it -- proving the guard, not just documenting it.
      const sql =
        "SELECT CASE'\\' /* would stay hidden if wrongly treated as an escape string */' END;\n" +
        'ALTER TABLE public.audit_logs DROP COLUMN metadata;'
      const stripped = stripComments(sql)
      expect(stripped).not.toMatch(/would stay hidden/)
      expect(stripped).toMatch(/ALTER\s+TABLE\s+public\.audit_logs\s+DROP\s+COLUMN\s+metadata/)
    }
  )

  it(
    'agrees that a plain string ends at the quote right after a backslash -- under ' +
      'standard_conforming_strings=on the backslash is literal, not an escape',
    () => {
      const sql =
        "SELECT 'a\\' /* real comment -- only stripped if the string closed at the quote right " +
        "after the backslash */';\n" +
        'ALTER TABLE public.audit_logs DROP COLUMN metadata;'
      const stripped = stripComments(sql)
      expect(stripped).not.toMatch(/only stripped if the string closed/)
      expect(stripped).toMatch(/ALTER\s+TABLE\s+public\.audit_logs\s+DROP\s+COLUMN\s+metadata/)
    }
  )
})
