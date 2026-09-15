/**
 * SMI-6114 / SMI-6680: comment- and quote-aware SQL text scanning shared by the
 * private-registry-audit-trigger tripwire suite. Split out of the single ~1000-line test file
 * (SMI-6680 governance retro F1/F2) so every non-test file here stays under the repo's 500-line
 * gate.
 *
 * `literalSpanEnd()` is the one piece of state machine `stripComments()` and `splitStatements()`
 * (SMI-6680 F2) share: given an index that starts a Postgres string literal, escape-string literal
 * (`E'...'`/`e'...'`), or dollar-quoted body (`$$...$$`/`$tag$...$tag$`), it returns the index
 * immediately past that literal's real close -- or `null` if no literal starts there. Both callers
 * treat everything inside as atomic: a `;`, or a `--`/`/* *\/` sequence, inside a literal can never
 * split a statement or start a real comment. `stripComments()` was refactored to call this helper
 * instead of inlining the three literal branches itself; the refactor was verified byte-identical
 * to the pre-refactor implementation across the 9-case table this module's `it()` blocks below
 * exercise, plus two extra dollar-quote/nesting cases, before being relied on (SMI-6680, measure-
 * don't-reason).
 *
 * ASSUMES `standard_conforming_strings = on` (Postgres' default, and this project's): in a plain
 * `'...'` string a backslash is a literal character and `''` is the only way to embed a quote, so
 * the plain-string branch never treats `\` specially. An `E'...'`/`e'...'` ESCAPE string is
 * different regardless of that setting -- Postgres always interprets backslash escapes inside one,
 * so `\` there DOES escape the next character, including a quote. Escape strings also still allow
 * the doubled-quote `''` embed alongside `\'` (Postgres accepts both), and the `E`/`e` is only
 * recognized as an escape-string opener when it is not the tail of a longer identifier -- checked
 * via the character immediately before it. Verified against a 5-case table (SMI-6114 retro round 4,
 * PR #2855) -- see `private-registry-audit-trigger.static.test.ts`'s `stripComments()`
 * escape-string `it()` blocks.
 */

export const stripLineComments = (sql: string): string => sql.replace(/--[^\n]*/g, '')

/**
 * If a Postgres string/escape-string/dollar-quoted literal starts at index `i` in `sql`, returns
 * the index immediately after it; otherwise `null`. See the module doc comment above.
 */
export function literalSpanEnd(sql: string, i: number): number | null {
  const n = sql.length
  const c = sql[i]
  const c2 = i + 1 < n ? sql[i + 1] : ''
  if ((c === 'E' || c === 'e') && c2 === "'" && !/[A-Za-z0-9_]/.test(i > 0 ? sql[i - 1] : '')) {
    // Postgres escape-string literal: E'...' / e'...'. A backslash escapes the next character
    // (including a quote); '' still embeds a literal quote too (Postgres allows both forms).
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
        return j + 1
      }
      j += 1
    }
    return n
  }
  if (c === "'") {
    // Single-quoted string literal: '' is an escaped quote, not a terminator. Under
    // standard_conforming_strings=on a backslash here is a literal character, not an escape.
    let j = i + 1
    while (j < n) {
      if (sql[j] === "'") {
        if (sql[j + 1] === "'") {
          j += 2
          continue
        }
        return j + 1
      }
      j += 1
    }
    return n
  }
  if (c === '$') {
    // Dollar-quoted body: $$ ... $$ or $tag$ ... $tag$. Matched by literal tag re-occurrence, not
    // nesting -- Postgres dollar-quote bodies do not nest with the same tag.
    const tagMatch = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i))
    if (tagMatch) {
      const tag = tagMatch[0]
      const closeIdx = sql.indexOf(tag, i + tag.length)
      return closeIdx === -1 ? n : closeIdx + tag.length
    }
  }
  return null
}

/**
 * Strips both `--` line comments and `/* ... *\/` block comments (Postgres allows nesting, so this
 * tracks depth) WITHOUT touching text inside a literal span (see `literalSpanEnd()` above) -- a
 * character-scanning state machine, not a regex, since comment/string/dollar-quote nesting isn't a
 * regular language. Used only by the checks that need to see through comments to find a real
 * statement, or avoid a false-positive on a commented-out example. NEVER applied to the raw
 * function/trigger pins in `private-registry-audit-trigger.pins.ts` -- those hash/compare the exact
 * text, comments included, by design (round-2 gate finding 4, PR #2855).
 */
export function stripComments(sql: string): string {
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    const c2 = i + 1 < n ? sql[i + 1] : ''
    const litEnd = literalSpanEnd(sql, i)
    if (litEnd !== null) {
      out += sql.slice(i, litEnd)
      i = litEnd
      continue
    }
    if (c === '-' && c2 === '-') {
      // Line comment: drop through end of line, keep the newline itself.
      let j = sql.indexOf('\n', i)
      if (j === -1) j = n
      i = j
      continue
    }
    if (c === '/' && c2 === '*') {
      // Block comment, Postgres-style nested: track depth, drop the whole span.
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

/**
 * Splits `sql` into `;`-delimited statement chunks, treating a `;` inside a literal span (string,
 * escape string, dollar-quoted body) or a comment as ordinary text, never a separator (SMI-6680
 * F2). Comments are dropped from the output, matching `stripComments()`'s own rule, so a caller
 * that already ran `stripComments()` first sees no behavior change from switching to this
 * function; a caller that doesn't still gets a comment-safe split. Runs `stripComments()` first
 * and then re-scans the (now comment-free) text with the same `literalSpanEnd()` helper, splitting
 * on any `;` that isn't inside a literal span -- extracted from `stripComments()`'s own scanner
 * (SMI-6114 retro F2): the two share the literal-detection state machine, and this function's own
 * remaining logic (comment removal, `;` splitting) is a strict subset of what `stripComments()`
 * already had to do.
 *
 * Fixes a real defect (SMI-6680 F2, measured): naive `sql.split(';')` on
 * `ALTER TABLE public.audit_logs ADD COLUMN note TEXT DEFAULT 'a;b', DROP COLUMN metadata;` yields
 * two chunks, neither containing `DROP COLUMN` and `audit_logs` together, so a detector requiring
 * both in the same chunk never fires -- defeated by a punctuation mark inside a string literal.
 */
export function splitStatements(sql: string): string[] {
  const stripped = stripComments(sql)
  const chunks: string[] = []
  let current = ''
  let i = 0
  const n = stripped.length
  while (i < n) {
    const c = stripped[i]
    const litEnd = literalSpanEnd(stripped, i)
    if (litEnd !== null) {
      current += stripped.slice(i, litEnd)
      i = litEnd
      continue
    }
    if (c === ';') {
      chunks.push(current)
      current = ''
      i += 1
      continue
    }
    current += c
    i += 1
  }
  chunks.push(current)
  return chunks
}
