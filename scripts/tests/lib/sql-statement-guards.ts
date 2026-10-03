/**
 * ONE TOKENIZER for Postgres SQL text: `opaqueSpanAt`, plus `stripComments`, `splitStatements`,
 * `normalizeIdent` and the identifier readers built on it (SMI-6690).
 *
 * `opaqueSpanAt` is the single source of truth for which spans of SQL are not ordinary code.
 * Everything here and in both sibling modules defers to it rather than each re-deciding by regex —
 * that re-deciding is what let a `;` inside a quoted identifier forge a statement delimiter
 * undetected, and what let a deleted comment span fuse `DROP/* x *\/FUNCTION` into one token.
 *
 * NOT HERE, and each for a reason:
 *
 *   - `./sql-verb-matchers.ts` — the by-name CREATE/DROP/ALTER FUNCTION matchers. They REPORT which
 *     verb a scan found; they do not decide whether to fire. Moved out because a tokenizer accretes
 *     cases and this module was approaching the 500-line commit gate, while the matchers need none
 *     of it beyond the readers below (SMI-6696 holds the measurements).
 *   - `./sql-name-tripwire.ts` — `executableText`/`mentionsIdentifier`, the fail-closed detector,
 *     which applies a deliberately DIFFERENT span policy to the same spans.
 *   - `./migration-text-guards.ts` — git-crypt lock state and migration enumeration.
 *   - Anything shaped by one function's own signature or body: the audit-trigger suite's `DEF_RE`
 *     pins a header/body via backreference, and stays in that file.
 *
 * A tamper scan uses the tripwire and the matchers IN UNION — a hit from either is a hit — and lets
 * neither gate the other. See `./sql-verb-matchers.ts` for why, and for what neither can do.
 *
 * @module scripts/tests/lib/sql-statement-guards
 */

/**
 * A legal, case-sensitive, unqualified Postgres bareword identifier — no schema qualification, no
 * quoting. Shared by `qualifiedIdent` below and by `mentionsIdentifier` (`./sql-name-tripwire.ts`)
 * so a qualified or quoted argument is rejected the same way in both places (SMI-6690 finding F4)
 * instead of one throwing and the other silently returning `false`.
 */
export const BARE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/

/**
 * Regex source matching a `public`-qualified identifier the way Postgres resolves it: optional
 * schema qualification, optional double quotes on either part, and arbitrary whitespace around the
 * dot. `public.fn`, `"public"."fn"`, `"fn"`, and `public . fn` all name the same object. Used by
 * the definition/trigger regexes in `private-registry-audit-trigger.static.test.ts`; the by-name
 * verb matchers in `./sql-verb-matchers.ts` use `normalizeIdent` instead of a regex fragment.
 */
export function qualifiedIdent(name: string): string {
  // `name` is interpolated unescaped, so a non-bare-identifier argument builds a pattern meaning
  // something else SILENTLY (e.g. `qualifiedIdent('public.fn')` -> the `.` becomes a wildcard
  // matching `publicXfn`). Throwing names the mistake instead (SMI-6690 round 4).
  if (!BARE_IDENT_RE.test(name)) {
    throw new Error(
      `qualifiedIdent: ${JSON.stringify(name)} is not a bare identifier — pass the unqualified ` +
        'name; the optional schema prefix is already part of this fragment'
    )
  }
  // `U&"name"` with no `\XXXX` escapes resolves to exactly `name` on PG 17.11 (SMI-6690 finding 7).
  return String.raw`(?:(?:[Uu]&)?"?public"?\s*\.\s*)?(?:[Uu]&)?"?${name}"?`
}

type SpanKind =
  | 'line-comment'
  | 'block-comment'
  | 'string'
  | 'escape-string'
  | 'dollar-body'
  | 'quoted-ident'

function precededByIdentChar(sql: string, i: number): boolean {
  return i > 0 && /[A-Za-z0-9_]/.test(sql[i - 1])
}

/**
 * Scans a double-quote-delimited span starting AT the opening `"` (index `start`), `""` an
 * embedded literal quote. Returns the index just past the closing quote (`sql.length` if
 * unterminated). Shared by `opaqueSpanAt` and `normalizeIdent` so they can't disagree on the end.
 */
function scanDoubleQuoted(sql: string, start: number): number {
  const n = sql.length
  let j = start + 1
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

/**
 * If an opaque span of SQL starts at `sql[i]`, returns its kind and the index just past it; else
 * null. SINGLE SOURCE OF TRUTH for which spans are not ordinary code — `stripComments`,
 * `splitStatements`, and the identifier/statement readers below all defer to this instead of each
 * re-deciding it by regex (SMI-6690: that re-deciding is what let a `;` inside a quoted identifier
 * forge a statement delimiter undetected).
 *
 * Five kinds predate this function, in `stripComments`: `--`/`/* *\/` comments (nested), `'...'`
 * strings (`''` embeds a quote), `E'...'`/`e'...'` escape strings (only when `E`/`e` isn't the tail
 * of a longer identifier; `\` escapes the next char, `''` also embeds a quote), and
 * `$$...$$`/`$tag$...$tag$` dollar bodies (literal tag re-occurrence, no nesting) — see the
 * `stripComments()` case tables in `../private-registry-audit-trigger.static.test.ts`.
 *
 * `quoted-ident` is the sixth, added here: a double-quoted identifier, optionally `U&`-prefixed
 * (the `U&` is part of the span). Nothing recognized this before, so `;` or a comment marker
 * inside one — `"a;b"`, `"a--b"` — read as ordinary code.
 *
 * Exported so `./sql-name-tripwire.ts`'s `executableText` can apply its own (deliberately
 * different) span policy without re-deriving span recognition — a second hand-rolled version is
 * exactly the kind of drift this function exists to prevent (SMI-6690).
 */
export function opaqueSpanAt(sql: string, i: number): { kind: SpanKind; end: number } | null {
  const n = sql.length
  const c = sql[i]
  const c2 = i + 1 < n ? sql[i + 1] : ''
  if ((c === 'E' || c === 'e') && c2 === "'" && !precededByIdentChar(sql, i)) {
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
    return { kind: 'escape-string', end: j }
  }
  if (c === "'") {
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
    return { kind: 'string', end: j }
  }
  if (
    (c === 'U' || c === 'u') &&
    c2 === '&' &&
    sql[i + 2] === '"' &&
    !precededByIdentChar(sql, i)
  ) {
    return { kind: 'quoted-ident', end: scanDoubleQuoted(sql, i + 2) }
  }
  if (c === '"') {
    return { kind: 'quoted-ident', end: scanDoubleQuoted(sql, i) }
  }
  if (c === '$') {
    // Postgres' tag rule is BYTE-BASED, not letter-based: an identifier character is an ASCII
    // letter, digit or underscore, or ANY byte >= 0x80. Verified on PG 17.11 — `$٣$` (Nd), `$☃$`
    // (So), a combining acute (Mn), `$·$` (Po) and `$😀$` (astral) are all legal tags, and none is
    // a "letter". An earlier fix used `\p{L}`, which is the right idea in the wrong encoding and
    // left every one of those unrecognised (SMI-6690 round 10).
    //
    // Why that direction is dangerous rather than merely incomplete: an unrecognised opener routes
    // the body's interior strings through the top-level-string branch, which BLANKS them, so
    // `EXECUTE 'DROP FUNCTION <fn>'` inside `DO $٣$ … $٣$` vanished before any scan ran. Matching
    // the engine by construction — rather than enumerating letters — is what closes the class.
    // `$` is deliberately absent from the continuation set: PG ends the tag at the first `$`.
    // `-￿` is "any non-ASCII code unit" written as a positive range: negating the ASCII
    // range instead trips `no-control-regex`. Surrogate pairs are covered code-unit-wise, so an
    // astral tag like `$😀$` matches (measured).
    const tagMatch = /^\$\$|^\$[A-Za-z_-￿][A-Za-z0-9_-￿]*\$/.exec(sql.slice(i))
    if (tagMatch) {
      const tag = tagMatch[0]
      const closeIdx = sql.indexOf(tag, i + tag.length)
      const end = closeIdx === -1 ? n : closeIdx + tag.length
      return { kind: 'dollar-body', end }
    }
  }
  if (c === '-' && c2 === '-') {
    let j = sql.indexOf('\n', i)
    if (j === -1) j = n
    return { kind: 'line-comment', end: j }
  }
  if (c === '/' && c2 === '*') {
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
    return { kind: 'block-comment', end: j }
  }
  return null
}

/**
 * Strips `--` and `/* *\/` comments (nested) while copying every other `opaqueSpanAt` span —
 * strings, escape strings, dollar bodies, quoted identifiers — through VERBATIM: normalizing
 * before comparing once let a body change hide inside what looked like a comment (SMI-6114 retro
 * round 2, finding 4). Never applied to the raw function/trigger pins in
 * `private-registry-audit-trigger.static.test.ts`, which hash exact text, comments included.
 * Delegates span recognition to `opaqueSpanAt` (SMI-6690); behaviour for every previously-covered
 * case is unchanged. `quoted-ident` is now also recognized, fixing a latent bug this rewrite
 * exposed: a comment marker or `;` inside a double-quoted identifier read as live code before.
 */
export function stripComments(sql: string): string {
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const span = opaqueSpanAt(sql, i)
    if (span) {
      if (span.kind === 'line-comment' || span.kind === 'block-comment') {
        // A single space, not deletion (SMI-6690 finding F3): deleting a `/* */` span fuses the
        // tokens on either side of it into one (`DROP/*x*/FUNCTION` -> `DROPFUNCTION`), which
        // breaks every consumer that tokenizes on whitespace, including the matchers below and
        // `splitStatements`. The `--` form was already safe (its span ends right before the `\n`,
        // which this loop preserves on the next iteration either way) but gets the same treatment
        // for symmetry — one space is harmless where a real separator already exists.
        out += ' '
      } else {
        out += sql.slice(i, span.end)
      }
      i = span.end
      continue
    }
    out += sql[i]
    i += 1
  }
  return out
}

/**
 * Splits SQL into statements on `;` at TOP LEVEL — outside every span `opaqueSpanAt` recognizes. A
 * `;` inside a quoted identifier, a string, or a dollar body is DATA, not a delimiter (SMI-6690:
 * `DROP FUNCTION IF EXISTS "a;b", <target>;` relied on exactly that confusion to hide `<target>`).
 * Drops empty/whitespace-only results; keeps a trailing unterminated statement rather than
 * silently discarding it.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const span = opaqueSpanAt(sql, i)
    if (span) {
      current += sql.slice(i, span.end)
      i = span.end
      continue
    }
    if (sql[i] === ';') {
      statements.push(current)
      current = ''
      i += 1
      continue
    }
    current += sql[i]
    i += 1
  }
  statements.push(current)
  return statements.filter((s) => s.trim().length > 0)
}

/**
 * Advances past a TOKEN GAP: whitespace and comments alike. Postgres treats a comment as
 * whitespace, so `DROP/* x *\/FUNCTION` and `U&"…" -- c` + newline + `UESCAPE '!'` are both single
 * token sequences to the engine. Skipping only whitespace here silently truncated the `UESCAPE`
 * look-ahead, which dropped the custom escape character and left the identifier undecoded
 * (SMI-6690 round 9). Callers that have already run `stripComments` are unaffected.
 */
export function skipTokenGap(s: string, i: number): number {
  let j = i
  for (;;) {
    while (j < s.length && /\s/.test(s[j])) j += 1
    const span = opaqueSpanAt(s, j)
    if (span && (span.kind === 'line-comment' || span.kind === 'block-comment')) {
      j = span.end
      continue
    }
    return j
  }
}

/**
 * Matches a case-insensitive bareword keyword at `i` (after skipping leading whitespace),
 * requiring a non-identifier character (or end of input) right after it — so keyword `FUNCTION`
 * does not match inside `FUNCTIONX`. Returns the index just past the keyword, or null.
 */
export function matchWord(s: string, i: number, word: string): number | null {
  const j = skipTokenGap(s, i)
  if (s.slice(j, j + word.length).toLowerCase() !== word.toLowerCase()) return null
  const after = s[j + word.length]
  if (after !== undefined && /[A-Za-z0-9_$]/.test(after)) return null
  return j + word.length
}

export type IdentToken = { raw: string; end: number }

/** Reads one identifier at `i`: bareword, `"quoted"`, or `U&"escaped"` with an optional trailing
 *  `UESCAPE '<char>'` folded into `raw` so `normalizeIdent` sees the whole expression. Exported so
 *  `mentionsIdentifier` (`./sql-name-tripwire.ts`) reuses this reader rather than a second one. */
export function readIdentAt(s: string, i: number): IdentToken | null {
  const span = opaqueSpanAt(s, i)
  if (span && span.kind === 'quoted-ident') {
    let end = span.end
    if (s[i] === 'U' || s[i] === 'u') {
      const uesc = matchWord(s, end, 'UESCAPE')
      if (uesc !== null) {
        const strAt = skipTokenGap(s, uesc)
        const strSpan = opaqueSpanAt(s, strAt)
        if (strSpan && strSpan.kind === 'string') end = strSpan.end
      }
    }
    return { raw: s.slice(i, end), end }
  }
  const m = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(s.slice(i))
  return m ? { raw: m[0], end: i + m[0].length } : null
}

export type QualifiedName = { schema: string | null; name: string; end: number }

/** Reads `[schema.]name`, tolerating whitespace and quoting on either side of the dot. */
export function readQualifiedName(s: string, i: number): QualifiedName | null {
  const first = readIdentAt(s, i)
  if (!first) return null
  const dotAt = skipTokenGap(s, first.end)
  if (s[dotAt] === '.') {
    const second = readIdentAt(s, skipTokenGap(s, dotAt + 1))
    if (second) return { schema: first.raw, name: second.raw, end: second.end }
  }
  return { schema: null, name: first.raw, end: first.end }
}

function escapeRegExpChar(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Resolves a raw SQL identifier token (as read by `readIdentAt`) to the name Postgres would
 * resolve it to (SMI-6690): a bareword folds to lower case; `"Foo"` keeps case, `""` inside is one
 * literal `"`; `U&"..."` [`UESCAPE '<char>'`] resolves `\XXXX` (4 hex) / `\+XXXXXX` (6 hex) to code
 * points, `\\` (or `<char><char>` under a custom `UESCAPE`) a literal escape character. DOES NOT
 * resolve a schema/`search_path` (`./sql-verb-matchers.ts` compares that separately), or validate a
 * `\+XXXXXX` code point is ≤ 10FFFF — an out-of-range one throws from `String.fromCodePoint`.
 */
export function normalizeIdent(raw: string): string {
  const trimmed = raw.trim()
  const uMatch = /^[Uu]&"/.exec(trimmed)
  if (uMatch) {
    const quoteAt = uMatch[0].length - 1
    const bodyEnd = scanDoubleQuoted(trimmed, quoteAt)
    const body = trimmed.slice(quoteAt + 1, bodyEnd - 1).replace(/""/g, '"')
    // Comments run through `stripComments` first, because Postgres accepts one on EITHER side of
    // the `UESCAPE` keyword and honours the custom escape character regardless — verified on
    // PG 17.11: `U&"!0072x" UESCAPE /*c*/ '!'` yields a column named `rx`. A bare `\s*` here
    // matched neither side, so `escChar` silently fell back to `\` and the escapes never decoded.
    // `readIdentAt` folds a comment BEFORE the keyword into `raw`, which bought nothing until this
    // line agreed with it (SMI-6690 round 10).
    const uesc = /UESCAPE\s*'(.)'\s*$/i.exec(stripComments(trimmed.slice(bodyEnd)))
    const escChar = uesc ? uesc[1] : '\\'
    const esc = escapeRegExpChar(escChar)
    const escRe = new RegExp(`${esc}${esc}|${esc}\\+([0-9A-Fa-f]{6})|${esc}([0-9A-Fa-f]{4})`, 'g')
    return body.replace(escRe, (_m: string, six?: string, four?: string) => {
      if (six) return String.fromCodePoint(parseInt(six, 16))
      if (four) return String.fromCodePoint(parseInt(four, 16))
      return escChar
    })
  }
  if (trimmed[0] === '"') {
    return trimmed.slice(1, -1).replace(/""/g, '"')
  }
  return trimmed.toLowerCase()
}
