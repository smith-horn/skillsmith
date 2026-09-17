/**
 * One tokenizer for Postgres SQL text (`opaqueSpanAt`, and the `stripComments`/`splitStatements`/
 * identifier readers built on it), plus by-name CREATE/DROP/ALTER FUNCTION matchers that REPORT
 * which verb a tamper scan found (SMI-6690).
 *
 * THE MATCHERS DO NOT DETECT — SMI-6690's own case table is why. Each matcher parses one
 * statement's grammar (a verb, a list, an argument list), and grammar-parsing can only ever be as
 * complete as parsing DDL is possible: DDL assembled at runtime by `EXECUTE format(...)` inside a
 * `DO $$ ... $$` block is not parseable text at all, at any point, by any lexer. Four review rounds
 * closed a delimiter forgery, a Unicode-escape identifier and two whole-file false positives one at
 * a time, and PG 17.11 still accepts every one of: a DROP hidden inside a `DO` block (plain, or via
 * `EXECUTE '...'`), an `ALTER ... RESET ALL` hidden the same way, a `café`/`if`-named list entry a
 * list parser abandons past, a `/* *\/`-fused verb, and a three-part `db.public.<fn>` name (SMI-6696).
 * A caller that needs to KNOW whether a name is mentioned in executable SQL, fail-closed, uses
 * `mentionsIdentifier` in `./sql-name-tripwire.ts` instead: it never parses a verb, a statement, or
 * a list, so none of the above has anything to bypass. The matchers here keep a narrower job once
 * that tripwire has already fired — naming WHICH verb (CREATE/DROP/ALTER) was seen, for a
 * human-readable message.
 *
 * `opaqueSpanAt` is the single source of truth for which spans of SQL are not ordinary code.
 * `stripComments`, `splitStatements`, the identifier reader here, and `./sql-name-tripwire.ts`'s
 * `executableText` all consume it, so a span rule is fixed in one place rather than several.
 *
 * NOT HERE: git-crypt lock state and migration enumeration (`./migration-text-guards.ts`); the
 * fail-closed identifier tripwire, `executableText`/`mentionsIdentifier` (`./sql-name-tripwire.ts`
 * — kept in its own module so this file's matchers stay under the file-length gate); and anything
 * shaped by one function's own signature or body — the audit-trigger suite's `DEF_RE` pins a
 * header/body via backreference; that stays in that file.
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
 * tamper decision below (`matchesCreateFunction`/`matchesDropFunction`/`matchesAlterFunction`)
 * uses `normalizeIdent` instead of a regex fragment.
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
    const tagMatch = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i))
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

function skipWs(s: string, i: number): number {
  let j = i
  while (j < s.length && /\s/.test(s[j])) j += 1
  return j
}

/**
 * Matches a case-insensitive bareword keyword at `i` (after skipping leading whitespace),
 * requiring a non-identifier character (or end of input) right after it — so keyword `FUNCTION`
 * does not match inside `FUNCTIONX`. Returns the index just past the keyword, or null.
 */
function matchWord(s: string, i: number, word: string): number | null {
  const j = skipWs(s, i)
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
        const strAt = skipWs(s, uesc)
        const strSpan = opaqueSpanAt(s, strAt)
        if (strSpan && strSpan.kind === 'string') end = strSpan.end
      }
    }
    return { raw: s.slice(i, end), end }
  }
  const m = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(s.slice(i))
  return m ? { raw: m[0], end: i + m[0].length } : null
}

type QualifiedName = { schema: string | null; name: string; end: number }

/** Reads `[schema.]name`, tolerating whitespace and quoting on either side of the dot. */
function readQualifiedName(s: string, i: number): QualifiedName | null {
  const first = readIdentAt(s, i)
  if (!first) return null
  const dotAt = skipWs(s, first.end)
  if (s[dotAt] === '.') {
    const second = readIdentAt(s, skipWs(s, dotAt + 1))
    if (second) return { schema: first.raw, name: second.raw, end: second.end }
  }
  return { schema: null, name: first.raw, end: first.end }
}

/** Skips a balanced `(...)` at `i` (must be `(`), honoring opaque spans inside so a string or
 *  quoted identifier can't unbalance the count. Returns the index past `)`, or null if unclosed. */
function skipBalancedParens(s: string, i: number): number | null {
  if (s[i] !== '(') return null
  const n = s.length
  let depth = 0
  let j = i
  while (j < n) {
    const span = opaqueSpanAt(s, j)
    if (span) {
      j = span.end
      continue
    }
    if (s[j] === '(') {
      depth += 1
      j += 1
      continue
    }
    if (s[j] === ')') {
      depth -= 1
      j += 1
      if (depth === 0) return j
      continue
    }
    j += 1
  }
  return null
}

function escapeRegExpChar(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Resolves a raw SQL identifier token (as read by `readIdentAt`) to the name Postgres would
 * resolve it to (SMI-6690): a bareword folds to lower case; `"Foo"` keeps case, `""` inside is one
 * literal `"`; `U&"..."` [`UESCAPE '<char>'`] resolves `\XXXX` (4 hex) / `\+XXXXXX` (6 hex) to code
 * points, `\\` (or `<char><char>` under a custom `UESCAPE`) a literal escape character. DOES NOT
 * resolve a schema/`search_path` (`nameMatchesTarget` compares that separately), or validate a
 * `\+XXXXXX` code point is ≤ 10FFFF — an out-of-range one throws from `String.fromCodePoint`.
 */
export function normalizeIdent(raw: string): string {
  const trimmed = raw.trim()
  const uMatch = /^[Uu]&"/.exec(trimmed)
  if (uMatch) {
    const quoteAt = uMatch[0].length - 1
    const bodyEnd = scanDoubleQuoted(trimmed, quoteAt)
    const body = trimmed.slice(quoteAt + 1, bodyEnd - 1).replace(/""/g, '"')
    const uesc = /UESCAPE\s*'(.)'\s*$/i.exec(trimmed.slice(bodyEnd))
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

/** True when `qname` names `target`: unqualified, or qualified to exactly `public` (any
 *  spelling/quoting). `target` must already be the bare, lower-case function name. */
function nameMatchesTarget(qname: QualifiedName, target: string): boolean {
  if (normalizeIdent(qname.name) !== target) return false
  return qname.schema === null || normalizeIdent(qname.schema) === 'public'
}

/** `CREATE [OR REPLACE] FUNCTION <name>(` — any args, any case, any spelling `normalizeIdent`
 *  resolves to `name`. `CREATE OR REPLACE ROUTINE` is a Postgres syntax error, deliberately not
 *  accepted (SMI-6690) — do not widen this to `FUNCTION|ROUTINE`. */
export function matchesCreateFunction(stmt: string, name: string): boolean {
  let i = matchWord(stmt, 0, 'CREATE')
  if (i === null) return false
  const or = matchWord(stmt, i, 'OR')
  if (or !== null) {
    const replace = matchWord(stmt, or, 'REPLACE')
    if (replace === null) return false
    i = replace
  }
  const fn = matchWord(stmt, i, 'FUNCTION')
  if (fn === null) return false
  const qname = readQualifiedName(stmt, skipWs(stmt, fn))
  if (!qname || !nameMatchesTarget(qname, name)) return false
  return stmt[skipWs(stmt, qname.end)] === '('
}

/**
 * `DROP FUNCTION|ROUTINE [IF EXISTS] <name>[(args)][, <name>[(args)]...] [CASCADE|RESTRICT]` —
 * `name` may be anywhere in the list, args optional per name. Parses the list token by token
 * rather than matching a `[^;]*?` span across it (SMI-6690), so a quoted identifier's own `;`, or
 * an unrelated statement glued on after an unterminated one, cannot extend or truncate the list.
 */
export function matchesDropFunction(stmt: string, name: string): boolean {
  let i = matchWord(stmt, 0, 'DROP')
  if (i === null) return false
  let verb = matchWord(stmt, i, 'FUNCTION')
  if (verb === null) verb = matchWord(stmt, i, 'ROUTINE')
  if (verb === null) return false
  i = verb
  const ifTok = matchWord(stmt, i, 'IF')
  if (ifTok !== null) {
    const existsTok = matchWord(stmt, ifTok, 'EXISTS')
    if (existsTok === null) return false
    i = existsTok
  }
  for (;;) {
    const qname = readQualifiedName(stmt, skipWs(stmt, i))
    if (!qname) return false
    i = skipWs(stmt, qname.end)
    if (stmt[i] === '(') {
      const afterArgs = skipBalancedParens(stmt, i)
      if (afterArgs === null) return false
      i = skipWs(stmt, afterArgs)
    }
    if (nameMatchesTarget(qname, name)) return true
    if (stmt[i] !== ',') return false
    i += 1
  }
}

/** `ALTER FUNCTION|ROUTINE <name>[(args)]` — the verb needing no `CREATE`: e.g.
 *  `ALTER FUNCTION public.<fn> RESET ALL` strips a pinned `search_path` with no arg list and no
 *  redefinition, so a `CREATE`-anchored guard never sees it (SMI-6690). Matches on name alone. */
export function matchesAlterFunction(stmt: string, name: string): boolean {
  const i = matchWord(stmt, 0, 'ALTER')
  if (i === null) return false
  let verb = matchWord(stmt, i, 'FUNCTION')
  if (verb === null) verb = matchWord(stmt, i, 'ROUTINE')
  if (verb === null) return false
  const qname = readQualifiedName(stmt, skipWs(stmt, verb))
  return qname !== null && nameMatchesTarget(qname, name)
}
