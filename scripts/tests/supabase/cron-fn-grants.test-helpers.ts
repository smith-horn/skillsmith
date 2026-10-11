/**
 * SMI-7075 -- pure extraction + ACL-replay logic for the cron-function grants tripwire. No I/O and
 * no Postgres: it takes `{name, sql}` files in apply order, so tests can feed synthetic corpora.
 *
 * TRIPWIRE, NOT A SECURITY PROOF. This replays REVOKE / GRANT / CREATE / DROP text in order; it
 * does not see dynamic SQL, ALTER DEFAULT PRIVILEGES, overload-specific ACLs or apply order that
 * differs from filename order. The migration's own smoke block checks the real catalog.
 *
 * @module scripts/tests/supabase/cron-fn-grants.test-helpers
 */

import { opaqueSpanAt, splitStatements, stripComments } from '../lib/sql-statement-guards.ts'
import { matchesCreateFunction, matchesDropFunction } from '../lib/sql-verb-matchers.ts'

export type MigrationFile = { name: string; sql: string }
export type Violation = { fn: string; reason: string }

export const ROLES = ['public', 'anon', 'authenticated'] as const
type Role = (typeof ROLES)[number]

const CRON_CALL_RE = /\bcron\s*\.\s*schedule(?:_in_database)?\s*\(/gi
// The called name may be bare or double-quoted, optionally qualified with a bare or quoted `public`.
const FN_CALL_RE =
  /\b(?:SELECT|PERFORM)\s+(?:(?:public|"public")\s*\.\s*)?("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\s*\(/gi
/** Names the replay can verify: an unquoted, case-folded identifier, minus `$` (a regex metacharacter in its patterns). */
const FOLDED_NAME_RE = /^[a-z_][a-z0-9_]*$/
/** Postgres identifier rules: an unquoted name folds to lower case; a quoted one is exact. */
function identName(raw: string): string {
  return raw.startsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw.toLowerCase()
}
const PRIV = String.raw`(?:EXECUTE|ALL(?:\s+PRIVILEGES)?)`
const TAIL = String.raw`(?:\s+(?:CASCADE|RESTRICT))?\s*$`
const REVOKE_RE = new RegExp(
  String.raw`^\s*REVOKE\s+(GRANT\s+OPTION\s+FOR\s+)?${PRIV}\s+ON\s+(?:FUNCTION|ROUTINE)\s+([\s\S]+?)\s+FROM\s+([\s\S]+?)${TAIL}`,
  'i'
)
const GRANT_RE = new RegExp(
  String.raw`^\s*GRANT\s+${PRIV}\s+ON\s+(?:FUNCTION|ROUTINE)\s+([\s\S]+?)\s+TO\s+([\s\S]+?)(?:\s+WITH\s+GRANT\s+OPTION)?\s*$`,
  'i'
)
const REVOKE_ALL_RE = new RegExp(
  String.raw`^\s*REVOKE\s+(GRANT\s+OPTION\s+FOR\s+)?${PRIV}\s+ON\s+ALL\s+FUNCTIONS\s+IN\s+SCHEMA\s+public\s+FROM\s+([\s\S]+?)${TAIL}`,
  'i'
)
const GRANT_ALL_RE = new RegExp(
  String.raw`^\s*GRANT\s+${PRIV}\s+ON\s+ALL\s+FUNCTIONS\s+IN\s+SCHEMA\s+public\s+TO\s+([\s\S]+?)(?:\s+WITH\s+GRANT\s+OPTION)?\s*$`,
  'i'
)

/** Index just past the `)` balancing the `(` at `open`, skipping quotes and dollar bodies. */
function balancedEnd(sql: string, open: number): number {
  let depth = 0
  let j = open
  while (j < sql.length) {
    const span = opaqueSpanAt(sql, j)
    if (span) {
      j = span.end
      continue
    }
    if (sql[j] === '(') depth += 1
    else if (sql[j] === ')') {
      depth -= 1
      if (depth === 0) return j + 1
    }
    j += 1
  }
  return sql.length
}

/** Numeric version prefix; a plain string compare misorders mixed widths (`99_` vs `100_`). */
function version(name: string): number {
  const v = Number(name.match(/^(\d+)/)?.[1] ?? NaN)
  if (Number.isNaN(v)) throw new Error(`cron-fn-grants: ${name} has no numeric version prefix`)
  return v
}

/** Statements of every file, comments stripped, in apply (numeric version) order. */
export function orderedStatements(files: MigrationFile[]): string[] {
  const sorted = [...files].sort((a, b) => version(a.name) - version(b.name))
  return sorted.flatMap((f) => splitStatements(stripComments(f.sql)))
}

/** Lower-case names of every function called as SELECT/PERFORM inside a `cron.schedule(...)`. */
export function cronCalledFunctions(statements: string[]): Set<string> {
  const names = new Set<string>()
  for (const stmt of statements) {
    for (const m of stmt.matchAll(CRON_CALL_RE)) {
      const open = (m.index ?? 0) + m[0].length - 1
      const region = stmt.slice(open, balancedEnd(stmt, open))
      for (const c of region.matchAll(FN_CALL_RE)) names.add(identName(c[1]))
    }
  }
  return names
}

/**
 * Postgres identifier rules, measured on staging 2026-10-11: an unquoted grantee is case-folded, a
 * quoted one is exact. `"public"` IS the PUBLIC pseudo-role; `"PUBLIC"` and `"Anon"` name roles
 * that do not exist (`role "PUBLIC" does not exist`), so they must not count as a revoke.
 */
function grantees(list: string): Set<Role> {
  const out = new Set<Role>()
  for (const raw of list.split(',')) {
    const t = raw.trim()
    const quoted = /^"(.*)"$/.exec(t)
    const g = quoted ? quoted[1].replace(/""/g, '"') : t.toLowerCase()
    if ((ROLES as readonly string[]).includes(g)) out.add(g as Role)
  }
  return out
}

function listNames(list: string, fn: string): boolean {
  const cleaned = list.replace(/"/g, '')
  return new RegExp(`(?:^|[\\s,])(?:public\\s*\\.\\s*)?${fn}\\s*\\(`, 'i').test(cleaned)
}

type AclEffect = { roles: Set<Role>; kind: 'revoke' | 'grant' } | null

// `REVOKE GRANT OPTION FOR ...` removes only the right to re-grant; the grantee keeps EXECUTE, so
// it is no revoke at all for this check (SMI-7075 cross-family review, finding 1).
function aclEffect(stmt: string, fn: string): AclEffect {
  let m = REVOKE_ALL_RE.exec(stmt)
  if (m) return m[1] ? null : { roles: grantees(m[2]), kind: 'revoke' }
  m = GRANT_ALL_RE.exec(stmt)
  if (m) return { roles: grantees(m[1]), kind: 'grant' }
  m = REVOKE_RE.exec(stmt)
  if (m && listNames(m[2], fn)) return m[1] ? null : { roles: grantees(m[3]), kind: 'revoke' }
  m = GRANT_RE.exec(stmt)
  if (m && listNames(m[1], fn)) return { roles: grantees(m[2]), kind: 'grant' }
  return null
}

/** Replays one function's CREATE / DROP / REVOKE / GRANT history; returns a reason or null. */
function replay(statements: string[], fn: string): string | null {
  let exists = false
  let everCreated = false
  let revoked = new Set<Role>()
  let regranted = new Set<Role>()
  for (const stmt of statements) {
    if (matchesDropFunction(stmt, fn)) {
      exists = false
      revoked = new Set()
      regranted = new Set()
    } else if (matchesCreateFunction(stmt, fn)) {
      // CREATE OR REPLACE on an existing function keeps its ACL; only a fresh CREATE resets it.
      if (!exists) {
        exists = true
        everCreated = true
        revoked = new Set()
        regranted = new Set()
      }
    } else if (exists) {
      const hit = aclEffect(stmt, fn)
      if (!hit) continue
      for (const r of hit.roles) {
        if (hit.kind === 'revoke') revoked.add(r)
        else {
          revoked.delete(r)
          regranted.add(r)
        }
      }
    }
  }
  if (!everCreated) return 'cron-called but no CREATE FUNCTION exists in any migration'
  if (!exists) return null
  const missing = ROLES.filter((r) => !revoked.has(r))
  if (missing.length === 0) return null
  const again = missing.filter((r) => regranted.has(r))
  return (
    `EXECUTE not revoked from ${missing.join(', ')} after the last ACL reset` +
    (again.length ? ` (re-granted to ${again.join(', ')})` : '')
  )
}

/**
 * Distinct argument lists `fn` was ever CREATEd with (lower-cased, whitespace collapsed). The replay
 * tracks one ACL per NAME, so it cannot tell `foo()` from `foo(integer)`: a revoke on one overload
 * would read as covering the other (SMI-7075 cross-family review, finding 2). More than one list
 * fails closed instead. A respelled redeclaration of the same signature also counts as two, which
 * is the safe direction: a false alarm, never a false pass.
 */
function createSignatures(statements: string[], fn: string): Set<string> {
  const sigs = new Set<string>()
  for (const stmt of statements) {
    if (!matchesCreateFunction(stmt, fn)) continue
    const open = stmt.indexOf('(', stmt.search(new RegExp(`\\b${fn}"?\\s*\\(`, 'i')))
    const args = stmt.slice(open + 1, balancedEnd(stmt, open) - 1)
    sigs.add(args.replace(/\s+/g, ' ').trim().toLowerCase())
  }
  return sigs
}

/** Every cron-called function whose final ACL still lets PUBLIC, anon or authenticated execute. */
export function cronFnGrantViolations(files: MigrationFile[]): Violation[] {
  const statements = orderedStatements(files)
  const out: Violation[] = []
  for (const fn of cronCalledFunctions(statements)) {
    // Fail closed on what the replay cannot model (SMI-7075 cross-family review, finding 3).
    if (!FOLDED_NAME_RE.test(fn)) {
      out.push({ fn, reason: 'name is not a case-folded identifier; this guard cannot verify it' })
      continue
    }
    if (createSignatures(statements, fn).size > 1) {
      out.push({
        fn,
        reason: 'overloaded: CREATEd with more than one argument list; cannot verify',
      })
      continue
    }
    const reason = replay(statements, fn)
    if (reason) out.push({ fn, reason })
  }
  return out.sort((a, b) => (a.fn < b.fn ? -1 : a.fn > b.fn ? 1 : 0))
}
