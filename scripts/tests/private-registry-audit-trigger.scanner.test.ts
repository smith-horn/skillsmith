/**
 * `splitStatements()` and `stripComments()` case tables for
 * `private-registry-audit-trigger.scanner.ts`. Split out of the original
 * `private-registry-audit-trigger.static.test.ts` (SMI-6680 governance retro, PR #2860 gate) so
 * every test file here stays a reasonable size; see `private-registry-audit-trigger.pins.test.ts`'s
 * module doc comment for the full MODEL and DOES-NOT-DETECT list these cases support.
 *
 * Two independent case tables live here:
 *   - `splitStatements()` (SMI-6680 F2): the `;`-splitting behavior specifically -- the defect this
 *     fixes is separate from anything `stripComments()` itself got wrong (it was always
 *     quote-aware; only the naive `sql.split(';')` calls that consumed its output weren't).
 *   - `stripComments()` escape-string handling (SMI-6114 retro round 4, gate finding on PR #2855).
 *     Deliberately NOT gated by describe.skipIf(locked): both functions are pure functions of their
 *     string argument and read no migration file, so these regression cases must keep running even
 *     when supabase/migrations/ is git-crypt-locked. Each case was executed against the exact
 *     implementation (node, outside vitest) before being written down here, per the repo's
 *     "measure, don't reason" rule.
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { splitStatements, stripComments } from './private-registry-audit-trigger.scanner.ts'
import { columnsFromMigrations } from './private-registry-audit-trigger.pins.ts'

describe('splitStatements() (SMI-6680 F2)', () => {
  // PR #2860 gate finding 6: this table used to be 8 `toEqual`s in one `it()`, so a regression in
  // an earlier case (e.g. the single-quoted literal, assertion 1) would throw and mask every case
  // after it -- including the newer `"`/`""`/`U&"` rows (assertions 4-6) added for PR #2860 gate
  // finding 1. `it.each` runs and reports every row independently, matching the three tables above
  // it in this same describe block.
  it.each([
    [
      'single-quoted literal',
      "SELECT 'a;b' AS x; DROP TABLE foo;",
      ["SELECT 'a;b' AS x", ' DROP TABLE foo', ''],
    ],
    [
      'escape string (E-string)',
      "SELECT e'a;b' AS x; DROP TABLE foo;",
      ["SELECT e'a;b' AS x", ' DROP TABLE foo', ''],
    ],
    [
      'dollar-quoted body',
      'SELECT $$a;b$$ AS x; DROP TABLE foo;',
      ['SELECT $$a;b$$ AS x', ' DROP TABLE foo', ''],
    ],
    // PR #2860 gate finding 1: quoted identifiers were not atomic before this fix.
    [
      'double-quoted identifier',
      'SELECT "a;b" AS x; DROP TABLE foo;',
      ['SELECT "a;b" AS x', ' DROP TABLE foo', ''],
    ],
    // Doubled "" inside a quoted identifier embeds a literal quote, not a terminator.
    [
      'doubled "" inside a quoted identifier',
      'SELECT "a""b;c" AS x; DROP TABLE foo;',
      ['SELECT "a""b;c" AS x', ' DROP TABLE foo', ''],
    ],
    // U&"..." Unicode-escape identifiers close exactly like a plain quoted identifier.
    [
      'U&"..." Unicode-escape identifier',
      'SELECT U&"a;b" AS x; DROP TABLE foo;',
      ['SELECT U&"a;b" AS x', ' DROP TABLE foo', ''],
    ],
    [
      'line comment (--)',
      'SELECT 1; -- a;b\nDROP TABLE foo;',
      ['SELECT 1', ' \nDROP TABLE foo', ''],
    ],
    [
      'block comment (/* */)',
      'SELECT 1; /* a;b */ DROP TABLE foo;',
      ['SELECT 1', '  DROP TABLE foo', ''],
    ],
  ])('does not split on a semicolon inside a %s, or a comment', (_label, sql, expected) => {
    expect(splitStatements(sql)).toEqual(expected)
  })

  it('measured repro: a naive sql.split(";") never puts the audit_logs table reference and DROP COLUMN in the same chunk when a semicolon sits inside a preceding literal; splitStatements() does', () => {
    // This is the actual defect (SMI-6680 F2): a detector requiring BOTH markers in one chunk
    // (e.g. auditSinkViolations()'s `alterAuditLogsRe.test(stmt) && dropColumnRe.test(stmt)`)
    // never fires against the naive split, even though the raw text "DROP COLUMN" is still
    // present *somewhere* in the split output -- just severed from its table reference.
    const stmt =
      "ALTER TABLE public.audit_logs ADD COLUMN note TEXT DEFAULT 'a;b', DROP COLUMN metadata;"
    const bothInOneChunk = (chunks: string[]): boolean =>
      chunks.some((chunk) => /audit_logs/.test(chunk) && /DROP COLUMN/.test(chunk))
    expect(bothInOneChunk(stmt.split(';'))).toBe(false)
    expect(bothInOneChunk(splitStatements(stmt))).toBe(true)
  })

  // PR #2860 gate LOW-1: `stripComments()`'s block-comment branch tracks nesting depth
  // (`depth += 1` / `depth -= 1`) so an inner `/* */` doesn't end the OUTER comment early. Nothing
  // in the suite exercised actual nesting before this case -- every existing block-comment fixture
  // above uses a single, non-nested `/* ... */`, which passes identically whether or not depth
  // tracking works at all. Mutation-proven (SMI-6598): changing `depth += 1` to `depth += 0` makes
  // `stripComments()` close the whole span at the FIRST `*/` it sees (the inner one) instead of the
  // real, matching outer one, leaking ` DROP TABLE x; */` as unstripped text -- verified directly
  // against the mutated implementation before writing this case down, then reverted.
  it('does not end an outer block comment at an inner, nested /* */ (PR #2860 gate LOW-1)', () => {
    const sql = '/* /* */ DROP TABLE x; */'
    expect(stripComments(sql)).toBe('')
    expect(splitStatements(sql)).toEqual([''])
  })

  it(
    'columnsFromMigrations() (pins.ts) finds a column added after a semicolon-bearing literal in ' +
      'the same ALTER TABLE statement -- the same defect shape as the three detectors above, found ' +
      'in a fourth call site during the F2 sweep and fixed in the same branch (coordinator follow-up)',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'private-registry-audit-trigger-columns-fixture-'))
      try {
        writeFileSync(
          join(dir, '20990101000000_create.sql'),
          'CREATE TABLE private_registry_skills (\n  id UUID,\n  team_id UUID\n);'
        )
        // The literal 'a;b' is what defeats a naive `sql.split(';')`: it splits this ONE statement
        // into two chunks, the first carrying the ALTER TABLE ... private_registry_skills prefix
        // and the "note" column, the second carrying "newcol" but not the table reference -- so
        // the naive version silently drops "newcol" from the set (measured, verified in node
        // before writing this fixture down).
        writeFileSync(
          join(dir, '20990101000001_alter.sql'),
          "ALTER TABLE private_registry_skills ADD COLUMN note TEXT DEFAULT 'a;b', ADD COLUMN newcol TEXT;"
        )
        const columns = columnsFromMigrations(dir)
        expect(columns.has('newcol')).toBe(true)
        expect(columns.has('note')).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )
})

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
    "correctly pairs a real backslash-escaped backslash (e'\\\\') inside an escape string with " +
      'the ODD backslash right after it, so the following quote stays escaped too, keeping a ' +
      'later real statement visible (SMI-6680 F8: the prior version of this fixture used an ' +
      'EVEN backslash count before the closing quote, which the plain-string rule and the ' +
      'escape-string rule both close at the identical index -- passing under either rule and so ' +
      'passing even with the escape-string branch disabled entirely. Proven decorative by ' +
      'mutation (SMI-6680 report); this version uses an ODD count so a `/*` exposed by the ' +
      'wrong (plain-string) closing point swallows the following ALTER TABLE into a runaway ' +
      'comment, while the correct escape-aware closing point keeps it visible.)',
    () => {
      const sql =
        "SELECT e'prefix \\\\\\' /*';\n" +
        'ALTER TABLE public.audit_logs DROP COLUMN metadata;\n' +
        '/* trailing comment, must still be stripped */'
      const stripped = stripComments(sql)
      expect(stripped).toMatch(/ALTER\s+TABLE\s+public\.audit_logs\s+DROP\s+COLUMN\s+metadata/)
      expect(stripped).not.toMatch(/trailing comment/)
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
