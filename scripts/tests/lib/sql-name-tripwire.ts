/**
 * The fail-closed identifier tripwire: `executableText` and `mentionsIdentifier` (SMI-6690).
 *
 * WHY THIS EXISTS, SEPARATELY FROM `./sql-verb-matchers.ts`. That module's `matches*` functions
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
 * one fired — callers pair it with the `matches*` functions in `./sql-verb-matchers.ts` IN UNION,
 * a hit from either being a hit, and let NEITHER gate the other. Do not make this a gate on them:
 * a stray `"` in a dollar body makes this module swallow the name, and a plain top-level DROP the
 * matchers read correctly then went unreported (SMI-6690 round 9). It is also, deliberately,
 * over-inclusive: see
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
 * hatch is a reviewed assertion at the call site, never a weaker span policy here.
 *
 * THE CEILING: THIS IS FAIL-CLOSED OVER TEXT, NOT OVER EFFECTS. Every shape below was measured on
 * PG 17.11 as accepted and as actually dropping the guarded function.
 *
 * FIRST, the name can be absent from the text entirely, and then nothing here can see it:
 *
 *   - runtime assembly            `EXECUTE 'DROP FUNCTION public.rele' || 'ase_...'`
 *   - the name as a PARAMETER     `EXECUTE format('DROP FUNCTION public.%I(uuid,uuid)', n)`
 *   - catalog-driven              a loop over `pg_proc` that never spells the name
 *   - collateral, names nothing   `DROP SCHEMA public CASCADE;`
 *
 * `EXECUTE format(...)` is worth singling out: it is the construct that motivated abandoning
 * grammar-parsing in the first place, and it defeats this tripwire too when the name is an argument.
 *
 * SECOND — and this is the part an earlier version of this comment got wrong — A NAME THAT IS
 * PRESENT AND CONTIGUOUS CAN STILL BE MISSED. Three were, each by a single exotic character, and
 * each is fixed; they are recorded because they are evidence about the KIND of thing that defeats a
 * text scan, not a closed list (SMI-6690 round 10):
 *
 *   - `İ` (U+0130) anywhere earlier — the only codepoint whose `toLowerCase()` changes UTF-16
 *     length, which desynchronised the bareword pass's index space;
 *   - a non-ASCII dollar tag (`$٣$`, `$☃$`) — Postgres' tag rule is byte-based, so a letter-based
 *     class left the tag unrecognised and blanked the body's strings as data;
 *   - a comment on the far side of `UESCAPE` — the escape character never decoded.
 *
 * So do not read a clean scan as "the name is not in this file." Read it as "no spelling this
 * tokenizer models was found." Closing the gap needs a live-catalog assertion — Postgres in CI,
 * SMI-5946, with the per-function behavioural proof tracked in SMI-6685. Do not let a caller's
 * prose upgrade this to a security boundary.
 *
 * Pair `mentionsIdentifier` with a grammar matcher IN UNION rather than gating one behind the
 * other: a stray `"` in a dollar body makes this module's re-tokenisation swallow the rest of the
 * text, and a plain top-level DROP that `matchesDropFunction` reads correctly then goes unreported.
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
        default: {
          // A new SpanKind must state its own policy here rather than inherit one by omission.
          // Falling through would DROP the span from executable text, blinding the fail-closed
          // detector to its contents — and `stripComments` defaults the opposite way (copies
          // verbatim), so silence is not even consistent between the two consumers. The `never`
          // annotation makes a seventh kind a compile error instead of a silent hole (SMI-6690).
          const unmodelled: never = span.kind
          throw new Error(`executableText: unmodelled span kind ${String(unmodelled)}`)
        }
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
 * tokenization. TWO PASSES, because one is not enough (SMI-6690 round 9):
 *
 *   1. An IDENTIFIER-TOKEN pass, which is what resolves `U&"…\0074"` and `UESCAPE` spellings.
 *   2. A QUOTE-BLIND BAREWORD pass, which exists because pass 1 can lose the name entirely. A
 *      dollar body is emitted verbatim, so `executableText`'s output can carry an UNBALANCED `"` —
 *      Postgres never lexes a dollar body's interior as SQL, but this scan does. `readIdentAt` then
 *      reads that `"` as opening a quoted identifier and runs to end of input, swallowing the name
 *      inside one token whose normalised value is not the target. Measured: one `"` in a `RAISE
 *      NOTICE` silenced a `DROP FUNCTION` later in the same block. Pass 2 compares the bare name
 *      with identifier boundaries and no quote context at all, so quote parity cannot affect it.
 *
 * An earlier version of this comment claimed `readIdentAt` "returns null for a bare quote, so the
 * scan steps past it one character at a time." That is false, and was the bypass.
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

  // Pass 1 — identifier tokens, which is what resolves `U&"…"`/`UESCAPE` spellings.
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

  // Pass 2 — quote-blind bareword, immune to the quote parity that can make pass 1 swallow the
  // name. Identifier boundaries on both sides keep `<name>_v2` and `x<name>` from matching.
  return mentionsBareword(text, target)
}

const IDENT_CHAR = /[A-Za-z0-9_$]/

/**
 * True when `target` occurs in `text` as a standalone identifier, ignoring all quote context.
 *
 * Indices come from `hay` and the boundary characters are read from `hay` TOO — never from `text`.
 * `String.prototype.toLowerCase` is not length-preserving: `İ` (U+0130) lowercases to two UTF-16
 * code units, and it is the ONLY codepoint in U+0000..U+10FFFF that does (swept, count 1). One of
 * them anywhere earlier in the text shifts every later index by one, and a boundary read against
 * `text` then lands INSIDE the name — so `openBoundary` was false for every occurrence and the
 * scan went silent. Measured on PG 17.11: one `İ` in a `RAISE NOTICE` hid a `DROP FUNCTION` in the
 * same block, and the function was dropped (SMI-6690 round 10). Reading both from `hay` keeps the
 * index space single; `IDENT_CHAR` is closed under lower-casing, so the test is unaffected.
 */
function mentionsBareword(text: string, target: string): boolean {
  const hay = text.toLowerCase()
  const needle = target.toLowerCase()
  if (needle === '') return false
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) {
    const before = at === 0 ? undefined : hay[at - 1]
    const after = hay[at + needle.length]
    const openBoundary = before === undefined || !IDENT_CHAR.test(before)
    const closeBoundary = after === undefined || !IDENT_CHAR.test(after)
    if (openBoundary && closeBoundary) return true
  }
  return false
}
