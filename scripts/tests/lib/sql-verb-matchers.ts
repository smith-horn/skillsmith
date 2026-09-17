/**
 * By-name CREATE/DROP/ALTER FUNCTION matchers that REPORT which verb a tamper scan found
 * (SMI-6690). They do NOT decide whether to fire.
 *
 * Split out of `./sql-statement-guards.ts` because that module holds the tokenizer every other
 * consumer needs, and a tokenizer accretes cases: it reached 487 of the 500-line commit gate while
 * these matchers sat beside it (SMI-6696). Nothing here is needed to tokenize SQL, and nothing
 * there needs a verb.
 *
 * PAIR THESE WITH `mentionsIdentifier` (`./sql-name-tripwire.ts`) IN UNION -- a hit from either is
 * a hit -- and let neither gate the other. Each covers the other's blind spot: these read one
 * statement's grammar, so they see a plain `DROP FUNCTION public.<fn>;` in text the tripwire's own
 * re-tokenisation can lose; the tripwire reads no grammar, so it sees a DROP inside a `DO` block, a
 * non-ASCII or keyword list head, comment fusion and a three-part name, none of which these do.
 * Gating the matchers behind the tripwire regressed a plain top-level DROP (SMI-6690 round 9).
 *
 * Neither mechanism is fail-closed over EFFECTS, only over TEXT -- `./sql-name-tripwire.ts` records
 * the four measured shapes in which the guarded name never appears as a token at all.
 *
 * @module scripts/tests/lib/sql-verb-matchers
 */

import {
  matchWord,
  normalizeIdent,
  opaqueSpanAt,
  readQualifiedName,
  skipTokenGap,
  type QualifiedName,
} from './sql-statement-guards.ts'

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
  const qname = readQualifiedName(stmt, skipTokenGap(stmt, fn))
  if (!qname || !nameMatchesTarget(qname, name)) return false
  return stmt[skipTokenGap(stmt, qname.end)] === '('
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
    const qname = readQualifiedName(stmt, skipTokenGap(stmt, i))
    if (!qname) return false
    i = skipTokenGap(stmt, qname.end)
    if (stmt[i] === '(') {
      const afterArgs = skipBalancedParens(stmt, i)
      if (afterArgs === null) return false
      i = skipTokenGap(stmt, afterArgs)
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
  const qname = readQualifiedName(stmt, skipTokenGap(stmt, verb))
  return qname !== null && nameMatchesTarget(qname, name)
}
