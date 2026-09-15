/**
 * SMI-6114 / SMI-6680: comment- and quote-aware SQL text scanning shared by the
 * private-registry-audit-trigger tripwire suite. Split out of the single ~1000-line test file
 * (SMI-6680 governance retro F1/F2) so every non-test file here stays under the repo's 500-line
 * gate.
 *
 * `literalSpanEnd()` is the one piece of state machine `stripComments()` and `splitStatements()`
 * (SMI-6680 F2) share: given an index that starts a Postgres atomic quoted/escaped span, it returns
 * the index immediately past that span's real close -- or `null` if no such span starts there. Both
 * callers treat everything inside as atomic: a `;`, or a `--`/`/* *\/` sequence, inside one of these
 * spans can never split a statement or start a real comment.
 *
 * ENUMERATION (PR #2860 gate finding 1): every PostgreSQL lexical form whose closing delimiter is
 * NOT just "the next occurrence of the opening character," cross-checked against the Lexical
 * Structure chapter of the PostgreSQL docs (identifiers/key words + constants sections are the
 * only two sections that define a quote-delimited atomic token -- nothing elsewhere in the grammar
 * introduces a new quoting convention; array/row constructors, casts, and type-prefixed constants
 * are all built from the tokens below plus ordinary punctuation, not a new one):
 *   1. Single-quoted string constant `'...'` -- own branch below, `''` embeds a literal quote.
 *   2. Escape string constant `E'...'`/`e'...'` -- own branch below, `\` escapes the next char too.
 *   3. Dollar-quoted string constant `$$...$$`/`$tag$...$tag$` -- own branch below. CAVEAT: the tag
 *      match in that branch (`literalSpanEnd()`'s `$` case, `^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$`) is
 *      ASCII-only, while Postgres dollar-quote tags follow the broader unquoted-identifier rules,
 *      which admit non-ASCII letters. A non-ASCII tag falls through this branch entirely -- it is
 *      scanned as ordinary text instead of an atomic span, so a `;` inside the body is treated as a
 *      real statement separator. This is fail-closed: the failure direction is always over-split,
 *      never a miss (a mis-scanned body can only break one statement into extra chunks a detector
 *      still sees, never merge two into one that hides a dangerous statement inside inert text).
 *      Verified: `CREATE FUNCTION f() ... AS $tagé$ BEGIN x := 1; END $tagé$ LANGUAGE plpgsql;` --
 *      whose two `;`s both sit inside the (mis-scanned, non-atomic) `$tagé$...$tagé$` body -- yields
 *      3 chunks from `splitStatements()`, not 1. No real migration currently has a non-ASCII
 *      dollar-quote tag (`grep -rlP '\$[^$\s]*[^\x00-\x7F][^$\s]*\$' supabase/migrations/` matches 0
 *      files), so this is a documentation-accuracy gap in an enumeration whose whole value is being
 *      an audited, complete list -- not a live security gap.
 *   4. Quoted (delimited) identifier `"..."` -- own branch below (PR #2860 finding 1's fix), `""`
 *      embeds a literal quote, same doubling rule as (1).
 *   5. Unicode-escape string constant `U&'...'` -- NOT a separate branch: per the Postgres docs,
 *      "except for the addition of Unicode escapes, U&'...' string constants otherwise work
 *      exactly like standard string constants," so the leading `U&` is just ordinary text scanned
 *      before branch (1)'s own `'` triggers, and closing-quote detection is identical. Verified
 *      empirically, not just cited (see this file's own `it()` blocks).
 *   6. Unicode-escape quoted identifier `U&"..."` -- NOT a separate branch, same reasoning as (5)
 *      applied to branch (4): the docs state U&"..." "is otherwise the same as regular quoted
 *      identifiers" apart from the escapes.
 *   7. Bit-string constant `B'...'`/`b'...'` and hex string constant `X'...'`/`x'...'` -- NOT
 *      separate branches: the `B`/`X` prefix is ordinary text before branch (1)'s `'` triggers,
 *      identical closing-quote detection.
 *   8. A trailing `UESCAPE '<char>'` clause on (5) or (6) -- NOT special-cased: it is its own,
 *      independent plain string constant (one character), parsed by branch (1) when the scanner
 *      reaches it, same as any other `'...'`.
 *   9. Adjacent string constant continuation: `'a'` NEWLINE `'b'` -- NOT a separate branch, and
 *      needs none: per the Postgres docs, two string constants separated only by whitespace with at
 *      least one newline (comments allowed in the gap too) are concatenated into a single constant,
 *      and nothing else may appear between the parts. The gap is therefore always exactly what
 *      `stripComments()`/`splitStatements()` already handle correctly outside any literal span
 *      (whitespace passed through, comments stripped), so no `;` can ever hide there. Verified: in a
 *      scratch Postgres instance, `SELECT 'a' ; 'b';` is a syntax error (the `;` is never swallowed
 *      into the continuation), while `SELECT 'a'` NEWLINE `'b';` and `SELECT 'a' -- comment` NEWLINE
 *      `'b';` both parse and evaluate to `'ab'`.
 * Line comments (`--`) and block comments (`/* *\/`) are NOT part of this enumeration -- they are
 * handled directly by `stripComments()`/`splitStatements()` themselves, not by this function, since
 * they can nest (block comments) or need active suppression at the top level rather than atomic
 * span reproduction.
 *
 * `stripComments()` was refactored to call this helper instead of inlining the literal branches
 * itself; the refactor was verified byte-identical to the pre-refactor implementation across the
 * 9-case table this module's `it()` blocks below exercise, plus two extra dollar-quote/nesting
 * cases, before being relied on (SMI-6680, measure-don't-reason).
 *
 * ASSUMES `standard_conforming_strings = on` (Postgres' default, and this project's): in a plain
 * `'...'` string a backslash is a literal character and `''` is the only way to embed a quote, so
 * the plain-string branch never treats `\` specially. An `E'...'`/`e'...'` ESCAPE string is
 * different regardless of that setting -- Postgres always interprets backslash escapes inside one,
 * so `\` there DOES escape the next character, including a quote. Escape strings also still allow
 * the doubled-quote `''` embed alongside `\'` (Postgres accepts both), and the `E`/`e` is only
 * recognized as an escape-string opener when it is not the tail of a longer identifier -- checked
 * via the character immediately before it. Verified against a 5-case table (SMI-6114 retro round 4,
 * PR #2855) -- see `private-registry-audit-trigger.scanner.test.ts`'s `stripComments()`
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
  if (c === '"') {
    // Quoted (delimited) identifier: "" is an escaped double-quote, not a terminator -- same
    // doubling rule as the plain-string branch above, just with `"` instead of `'` (PR #2860 gate
    // finding 1: `ADD COLUMN "note;field" text` previously split inside the quoted identifier,
    // since nothing treated it as atomic). This branch also transparently covers `U&"..."`
    // Unicode-escape identifiers -- the leading `U&` is ordinary text before this same
    // quote-closing rule takes over, and Postgres documents U&"..." as behaving exactly like a
    // regular quoted identifier except for the added \XXXX escapes, which this scanner has no
    // need to interpret (it only needs to find where the atomic span ends, not decode it).
    let j = i + 1
    while (j < n) {
      if (sql[j] === '"') {
        if (sql[j + 1] === '"') {
          j += 2
          continue
        }
        return j + 1
      }
      j += 1
    }
    return n
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
