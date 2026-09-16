/**
 * SQL-text helpers shared by the SMI-6651 release-RPC suite's two halves: the PG-free
 * `private-registry-content-release.structural.test.ts` and the live-Postgres
 * `private-registry-content-release.pg.test.ts`. Both need to read a predicate out of the shipped
 * migration text; neither needs a database to do it.
 *
 * These live in their own module rather than in `test-helpers.ts` because that module is already
 * at 459 lines and, unlike a `*.test.ts` file, is NOT exempt from the 500-line pre-commit gate
 * (`scripts/file-length-policy.mjs` matches `.test.`/`.spec.` in the basename — `.test-helpers.ts`
 * does not match).
 *
 * @module scripts/tests/supabase/private-registry-content-release.test-sqltext
 */

/** Strips `--` line comments and block comments from a SQL fragment, honoring `'...'` string
 *  literals (`''` is an escaped quote, not a terminator) so a `--` inside a literal is never
 *  mistaken for a comment start.
 *
 *  Why stripping is load-bearing (Finding 2, Sol gate follow-up round): a predicate commented out
 *  as `-- AND prs.team_id = v_row.team_id` still contains the plain substring
 *  `AND prs.team_id = v_row.team_id`, so a `toContain()` check against RAW extracted text passes
 *  even though the guard is now inert SQL. Proven against the pre-fix helper in a temporary
 *  before-state proof file before the fix was written (SMI-6598 rule). */
export function stripSqlComments(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    if (sql[i] === "'") {
      out += sql[i++]
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          out += sql.slice(i, i + 2)
          i += 2
          continue
        }
        out += sql[i]
        if (sql[i] === "'") {
          i++
          break
        }
        i++
      }
    } else if (sql[i] === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++
    } else if (sql[i] === '/' && sql[i + 1] === '*') {
      i += 2
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i += 2
    } else {
      out += sql[i++]
    }
  }
  return out
}

/** Extracts the step-4 content re-read's own `SELECT ... ;` out of a migration text, with SQL
 *  comments stripped.
 *
 *  KNOWN LIMITATION — read this before trusting what any assertion built on it proves (SMI-6685).
 *  Comment-stripping closes exactly ONE bypass: a predicate that exists only inside a comment. It
 *  does not make `toContain` a proof that a predicate is EFFECTIVE, because substring presence is
 *  a lexical property and effectiveness is a semantic one. Three gaps, all measured:
 *
 *    1. Mutating the statement to `AND prs.deprecated = false OR TRUE` leaves all three predicate
 *       substrings present — every `toContain` still passes, and every `.not.toContain` is equally
 *       blind — while `AND` binding tighter than `OR` turns the whole WHERE clause into an
 *       unconditional match and disables the tenant guard outright.
 *    2. This `indexOf` anchor has no uniqueness guard, unlike its sibling `replaceExactlyOnce` in
 *       the test-reverts module, which enforces exactly-once for precisely this reason. A future
 *       duplicate anchor would silently extract the wrong statement.
 *    3. `stripSqlComments` does not nest block comments the way real Postgres does.
 *
 *  Gaps 2 and 3 are not reachable from today's call sites. SMI-6685 replaces this whole mechanism
 *  with a semantic check rather than patching it a third time, per `pr-reviewer`'s
 *  delete-and-re-derive rule. Until then, treat every assertion built on this as a smoke check on
 *  the migration text, never as proof of the security property. The real proof is the behavioural
 *  revert-then-restore suite in `.pg.test.ts` (tests (a), (d/f), (i)), which rebuilds the schema
 *  with a broken migration and observes the RPC's actual output change. */
export function extractReReadSelect(sql: string): string {
  const start = sql.indexOf('SELECT prs.content INTO v_content')
  if (start === -1) throw new Error('extractReReadSelect: anchor not found')
  const end = sql.indexOf(';', start)
  if (end === -1) throw new Error('extractReReadSelect: unterminated statement')
  return stripSqlComments(sql.slice(start, end + 1))
}
