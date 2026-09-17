/**
 * The fail-closed identifier tripwire: `executableText` and `mentionsIdentifier` (SMI-6690).
 *
 * WHY THIS EXISTS, SEPARATELY FROM `./sql-statement-guards.ts`. That module's `matches*` functions
 * parse a statement's grammar — a verb, a list, an argument list — and grammar-parsing can only
 * ever be as complete as parsing DDL is possible. DDL assembled at runtime by `EXECUTE
 * format(...)` inside a `DO $$ ... $$` block is not parseable text at any point, by any lexer, no
 * matter how many bypass classes get closed one at a time. Measured on PostgreSQL 17.11, each of
 * these is ACCEPTED and removes the guarded function, while a grammar-based DROP/ALTER matcher
 * stays silent: a `DO` block containing a plain `DROP FUNCTION`, a `DO` block whose `EXECUTE
 * '...'` string contains one, a `DO` block containing `ALTER ... RESET ALL`, a
 * non-ASCII (`café`) or keyword (`if`) list entry a list parser abandons past, a comment fused
 * into a verb (`DROP/*x*\/FUNCTION`), and a three-part schema-qualified name. So detection here
 * gives up on parsing DDL altogether: it asks a narrower, answerable question — does this bare
 * name appear anywhere in text Postgres will execute — and answers it by tokenizing, never
 * parsing.
 *
 * `executableText` rewrites SQL keeping only what Postgres will execute; `mentionsIdentifier` then
 * tokenizes that text for identifiers and compares each, normalized, against a target name. Reuses
 * `opaqueSpanAt`/`readIdentAt`/`normalizeIdent` from `./sql-statement-guards.ts` rather than a
 * second span/identifier reader — a second one is exactly the kind of drift SMI-6690 exists to
 * remove.
 *
 * WHAT THIS DOES NOT DO. It never parses a verb, a statement, or a list, so it cannot name which
 * one fired — callers pair it with the `matches*` functions in `./sql-statement-guards.ts` to
 * report a verb once the tripwire has already decided to fire (never the reverse: a matcher's
 * silence must never suppress a firing tripwire). It is also, deliberately, over-inclusive: see
 * `executableText`'s own doc comment for the one accepted false-positive class this trades for
 * being fail-closed everywhere else.
 *
 * @module scripts/tests/lib/sql-name-tripwire
 */

import { BARE_IDENT_RE, normalizeIdent, opaqueSpanAt, readIdentAt } from './sql-statement-guards.ts'

/**
 * Advances past one `quoted-ident` span, INCLUDING a trailing `UESCAPE '<char>'` clause when
 * present. `opaqueSpanAt` alone cannot see the clause — it classifies spans one at a time with no
 * look-ahead, so calling it a second time right after a `U&"…"` span would independently reclassify
 * `UESCAPE`'s own `'<char>'` argument as an ordinary top-level string and blank it under
 * `executableText`'s string policy, destroying the escape character `normalizeIdent` needs before
 * `mentionsIdentifier` ever sees it (measured: this is exactly what happened before this helper
 * existed). `readIdentAt` already contains this exact look-ahead — reused here rather than
 * re-derived, so the compound token is read identically wherever it matters.
 */
function quotedIdentSpanEnd(sql: string, i: number): number {
  return readIdentAt(sql, i)!.end
}

/**
 * Rewrites `sql`, keeping only the spans Postgres will actually execute, so a caller asking "does
 * this name appear" cannot be evaded by comment-fusing, string-hiding, or dollar-quoting a verb.
 * Walks every span `opaqueSpanAt` recognizes and applies exactly this policy — the string-vs-
 * dollar-body split is deliberate, not an oversight, and must not be simplified:
 *
 *   - `line-comment`, `block-comment`  -> one space (not executed; whitespace to the engine).
 *   - `string`, `escape-string`        -> one space (a top-level quoted string is DATA — this is
 *                                         what stops `COMMENT ON ... IS '... DROP FUNCTION f ...'`
 *                                         from firing).
 *   - `dollar-body`                    -> VERBATIM, WHOLE, WITHOUT RECURSING INTO IT. A dollar
 *                                         body is CODE: `DO $$ ... $$` is executed, and
 *                                         `EXECUTE 'DROP FUNCTION f'` inside one puts the name in
 *                                         a single-quoted string that IS runtime SQL. Recursing in
 *                                         and blanking that inner string as "data" would strip the
 *                                         very name this exists to catch and reopen the bypass.
 *   - `quoted-ident`                   -> verbatim (it is part of an identifier — `"release_…"`
 *                                         must survive intact), INCLUDING a trailing
 *                                         `UESCAPE '<char>'` clause on a `U&"…"` form — see
 *                                         `quotedIdentSpanEnd` for why that clause's own quoted
 *                                         char must not be independently blanked as a plain string.
 *   - anything else                    -> the character, unchanged.
 *
 * ACCEPTED CONSEQUENCE, stated rather than hidden: a dollar-quoted string used purely as DATA
 * (`COMMENT ON FUNCTION f IS $$ ... f ... $$`) is treated as code under this policy and WILL make
 * `mentionsIdentifier` fire. That is the correct trade for a fail-closed tripwire — the escape
 * hatch is a reviewed allowlist at the call site (e.g. `REVIEWED_LATER_MIGRATIONS`), never a
 * weaker span policy here.
 */
export function executableText(sql: string): string {
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const span = opaqueSpanAt(sql, i)
    if (span) {
      const end = span.kind === 'quoted-ident' ? quotedIdentSpanEnd(sql, i) : span.end
      switch (span.kind) {
        case 'line-comment':
        case 'block-comment':
        case 'string':
        case 'escape-string':
          out += ' '
          break
        case 'dollar-body':
        case 'quoted-ident':
          out += sql.slice(i, end)
          break
      }
      i = end
      continue
    }
    out += sql[i]
    i += 1
  }
  return out
}

/**
 * Fail-closed: true when the bare identifier `name` appears anywhere in `executableText(sql)`.
 * Never parses a verb, a statement, or a list — it tokenizes the whole text for identifiers and
 * compares each, normalized via `normalizeIdent`, against `name` normalized the same way.
 *
 * NEVER ABORTS OR RETURNS EARLY ON UNRECOGNISED INPUT. At each position: try to read an identifier
 * token (`readIdentAt`, which itself recognizes a bareword, a `"quoted"` identifier, or a
 * `U&"…"` [`UESCAPE '<char>'`] form); if that fails, advance exactly one character and continue.
 * That unconditional one-character advance is what closes the `café` and `if` cases: neither is
 * itself the target, but skipping over what cannot be read — rather than stopping, or trying to
 * parse the surrounding list grammar — lets the scan keep going and still find the real target
 * later in the same list. It is also why a quote character left over from a dollar-body's verbatim
 * (unprocessed) interior — e.g. the string inside `EXECUTE 'DROP FUNCTION f'` — never blocks
 * tokenization: `readIdentAt` returns null for a bare quote (it is not an identifier start), so the
 * scan steps past it one character at a time and picks the identifiers up on the far side, INSIDE
 * what looks like a string. That is deliberate, not a gap: `executableText` already decided that
 * content is code, and re-treating its quotes as data here would reopen the exact bypass this
 * module exists to close.
 *
 * A three-part name like `postgres.public.f` needs no special case: it tokenizes as three separate
 * identifiers, and one of them equals the target.
 *
 * Throws when `name` itself is not already a bare identifier — matching `qualifiedIdent`'s own
 * contract in `./sql-statement-guards.ts` (SMI-6690 finding F4): before this, `qualifiedIdent`
 * threw on a qualified/quoted argument while the matchers built on it silently returned `false`
 * for the identical mistake, so a caller who passed `'public.f'` or `'"f"'` got a guard that could
 * never fire and no error to say why.
 */
export function mentionsIdentifier(sql: string, name: string): boolean {
  if (!BARE_IDENT_RE.test(name)) {
    throw new Error(
      `mentionsIdentifier: ${JSON.stringify(name)} is not a bare identifier — pass the ` +
        'unqualified name; qualification or quoting cannot be represented as a scan target'
    )
  }
  const target = normalizeIdent(name)
  const text = executableText(sql)
  const n = text.length
  let i = 0
  while (i < n) {
    const token = readIdentAt(text, i)
    if (token) {
      if (normalizeIdent(token.raw) === target) return true
      i = token.end
      continue
    }
    i += 1
  }
  return false
}
