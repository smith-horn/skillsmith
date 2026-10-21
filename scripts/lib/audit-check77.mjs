/**
 * Check 77 helpers (SMI-7151): explicit API grants on new public relations.
 *
 * From the SMI-7151 migration on, Postgres default privileges give the API
 * roles (anon, authenticated, service_role) NO access to new tables, views or
 * sequences. A migration that creates a public relation without explicit GRANTs
 * ships green and then every API call returns 42501. This module is the static
 * guard. All functions are pure; scripts/audit-standards.mjs does the I/O.
 *
 * Spec: docs/internal/implementation/smi-7151-explicit-grants-and-rls-hardening.md
 * section 3 and Appendix B.
 *
 * Known gaps (documented, deliberate), exactly these two:
 *   - a CREATE TABLE inside a dollar-quoted function or DO body is not a
 *     top-level statement and is ignored;
 *   - partition children (CREATE TABLE ... PARTITION OF) are skipped because
 *     Postgres checks privileges only on the table a query names.
 *
 * Intended, not a gap: a column-level grant (GRANT SELECT (col) ON t TO role)
 * counts as that role's decision. It is a deliberate, narrower grant; profiles
 * and private_registry_skills rely on exactly this shape.
 */

export const CHECK77_CUTOFF_TS = '20261021000000'
export const CHECK77_EXEMPT_FILES = ['20261021000000_explicit_grants_backfill.sql']

// Identity columns are exempt from the sequence rule. Measured on staging in the
// SMI-7151 rehearsal (plan Verification A3), as service_role with no sequence
// grant: a GENERATED ALWAYS AS IDENTITY insert succeeded, a bigserial insert
// failed with "permission denied for sequence". Set true only if a later
// Postgres version changes that.
export const CHECK77_IDENTITY_NEEDS_SEQUENCE_GRANT = false

const MIN_REASON_LENGTH = 18

import {
  lex,
  readIdent,
  readQname,
  isPublic,
  display,
  splitTopLevel,
  matchingParen,
} from './audit-check77-lex.mjs'

import {
  CLIENT_ROLES,
  DECISION_PRIVS,
  buildEffectiveGrants,
  forbiddenViolations,
} from './audit-check77-grants.mjs'

export { stripSqlComments, splitSqlStatements } from './audit-check77-lex.mjs'

// ---------------------------------------------------------------------------
// Ack markers (real top-level `--` line comments only: the lexer never reports a
// comment marker found inside a string, quoted identifier, dollar body or /* */)
// ---------------------------------------------------------------------------

const PLACEHOLDER_RE = /^\W*(todo|tbd|fixme|n\/?a|none|xxx|placeholder)\b/i

function reasonProblem(reason) {
  const r = reason.trim()
  if (r.length < MIN_REASON_LENGTH) return `reason is shorter than ${MIN_REASON_LENGTH} characters`
  if (PLACEHOLDER_RE.test(r) || /^<.*>$/.test(r)) return 'reason is a placeholder'
  return null
}

/** Find `-- audit:check-77-ack <service_role|clients|sequence> none <target>: <reason>` lines. */
export function findCheck77Acks(sql) {
  const acks = []
  const re =
    /^--[ \t]*audit:check-77-ack[ \t]+(service_role|clients|sequence)[ \t]+none[ \t]+([^:\n]+?)[ \t]*:[ \t]*(.*)$/i
  for (const comment of lex(sql, false).comments) {
    const m = comment.ownLine ? re.exec(comment.text) : null
    if (!m) continue
    const target = m[2].trim()
    let key = null
    if (m[1] === 'sequence') {
      const dot = target.replace(/^public\s*\.\s*/i, '')
      const t = readIdent(dot, 0)
      const c = t && /^\s*\.\s*/.exec(dot.slice(t.end))
      const col = c && readIdent(dot, t.end + c[0].length)
      key = col ? `${t.name}.${col.name}` : null
    } else {
      const q = readQname(target, 0)
      key = q && isPublic(q) && q.end === target.length ? q.name : null
    }
    acks.push({ kind: m[1], target, key, reason: m[3].trim(), problem: reasonProblem(m[3]) })
  }
  return acks
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

const baseName = (f) => f.split('/').pop()

/**
 * In scope = timestamp strictly after the cutoff, never an exempt file. A
 * numeric prefix of at most 6 digits is the legacy sequence scheme (001_...),
 * which predates the cutoff. Any other name is checked (fail closed).
 */
export function isCheck77InScope(fileName, opts = {}) {
  const { cutoffTs = CHECK77_CUTOFF_TS, exemptFiles = CHECK77_EXEMPT_FILES } = opts
  const name = baseName(fileName)
  if (exemptFiles.includes(name)) return false
  const prefix = /^(\d+)_/.exec(name)
  if (!prefix) return true
  if (prefix[1].length <= 6) return false
  return prefix[1].padEnd(14, '0') > cutoffTs
}

/**
 * Decide what the audit may claim about the migration set.
 *   'inconclusive' - an encrypted in-scope file is in the PR diff (fail closed)
 *   'not-checked'  - nothing readable to scan and nothing in the diff is hidden (pass, said honestly)
 *   'pass'         - scan the readable in-scope files
 * diffFiles === null means the PR diff could not be determined.
 */
export function classifyScanScope({ inScopeFiles, encryptedFiles, diffFiles }) {
  const encrypted = encryptedFiles.map(baseName)
  const hiddenInDiff =
    diffFiles === null ? encrypted : encrypted.filter((f) => diffFiles.map(baseName).includes(f))
  if (hiddenInDiff.length > 0) {
    return {
      status: 'inconclusive',
      scanned: 0,
      reason:
        diffFiles === null
          ? `INCONCLUSIVE: tree locked (git-crypt) and the PR diff could not be determined: ${hiddenInDiff.join(', ')}`
          : `INCONCLUSIVE: tree locked (git-crypt), in-scope migration(s) in this diff are encrypted and unreadable: ${hiddenInDiff.join(', ')}`,
    }
  }
  const scanned = inScopeFiles.length - encrypted.length
  if (scanned <= 0) {
    return {
      status: 'not-checked',
      scanned: 0,
      reason:
        encrypted.length > 0
          ? 'not checked: tree locked, no in-scope migration in this diff'
          : 'not checked: no in-scope migrations (0 files scanned)',
    }
  }
  return { status: 'pass', scanned, reason: '' }
}

const seqNameFromNextval = (rawText) => {
  const m = /nextval\s*\(\s*'((?:[^']|'')*)'/i.exec(rawText)
  if (!m) return null
  const q = readQname(m[1].replace(/''/g, "'"), 0)
  return q && isPublic(q) ? q.name : null
}

const SELECT_INTO_RE =
  /^SELECT\b[\s\S]*?\bINTO\s+(TEMPORARY\s+|TEMP\s+)?(?:UNLOGGED\s+)?(?:TABLE\s+)?/i

/**
 * The SELECT statement text to test for `INTO <table>`: the statement itself, or for a
 * WITH-prefixed statement the main SELECT after its CTE list (null when the main
 * statement is INSERT/UPDATE/DELETE/..., whose `INTO` is not a table creation).
 */
function selectStatement(masked) {
  if (!/^WITH\b/i.test(masked)) return masked
  let depth = 0
  for (let i = 4; i < masked.length; i++) {
    const c = masked[i]
    if (c === '"') {
      i++
      while (i < masked.length && !(masked[i] === '"' && masked[i + 1] !== '"'))
        i += masked[i] === '"' ? 2 : 1
    } else if (c === '(') depth++
    else if (c === ')') depth--
    else if (depth === 0 && /[A-Za-z]/.test(c) && !/[A-Za-z0-9_$]/.test(masked[i - 1])) {
      const w = /^(SELECT|INSERT|UPDATE|DELETE|MERGE|VALUES|TABLE)\b/i.exec(masked.slice(i))
      if (w) return w[1].toUpperCase() === 'SELECT' ? masked.slice(i) : null
    }
  }
  return null
}

const COLUMN_KEYWORD = /^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE|LIKE)\b/i
const SERIAL_RE = /^\s*(?:(?:small|big)?serial|serial[248])\b/i
const IDENTITY_RE = /\bGENERATED\s+(?:ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY\b/i

/** Sequence trigger for one column definition (masked + raw slices), or null. */
/**
 * The name Postgres gives a serial column's sequence: makeObjectName(table, column, 'seq')
 * in src/backend/commands/indexcmds.c. It trims the longer of the two parts one byte at a time
 * until `<table>_<column>_seq` fits NAMEDATALEN - 1 = 63 bytes. Verified against PostgreSQL 17
 * (SMI-7151; the expected names in the tests came from a real server). Assumes ASCII names,
 * which every migration here uses; a multibyte name would need pg_mbcliplen.
 */
export function pgSerialSequenceName(table, column) {
  const label = 'seq'
  const avail = 63 - 1 - (label.length + 1) // separating underscore + "_seq"
  let a = table.length
  let b = column.length
  while (a + b > avail) {
    if (a > b) a--
    else b--
  }
  return `${table.slice(0, a)}_${column.slice(0, b)}_${label}`
}

function columnTrigger(table, col, maskedDef, rawDef) {
  if (
    SERIAL_RE.test(maskedDef) ||
    (CHECK77_IDENTITY_NEEDS_SEQUENCE_GRANT && IDENTITY_RE.test(maskedDef))
  ) {
    return { table, column: col, seq: pgSerialSequenceName(table, col) }
  }
  if (/\bnextval\s*\(/i.test(maskedDef)) {
    const seq = seqNameFromNextval(rawDef)
    if (seq) return { table, column: col, seq }
  }
  return null
}

function extractFromStatements(stmts) {
  const relations = []
  const drops = new Set()
  const triggers = []
  const add = (kind, name) => {
    if (!relations.some((r) => r.kind === kind && r.name === name)) relations.push({ kind, name })
  }
  for (const { raw, masked } of stmts) {
    let m
    let sel
    if (
      (m = /^CREATE\s+(?:UNLOGGED\s+|FOREIGN\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/i.exec(masked))
    ) {
      const q = readQname(masked, m[0].length)
      if (!isPublic(q)) continue
      const after = masked.slice(q.end)
      if (/^\s*PARTITION\s+OF\b/i.test(after)) continue
      add('table', q.name)
      const open = after.search(/\S/)
      if (open !== -1 && after[open] === '(') {
        const base = q.end + open
        const close = matchingParen(masked, base)
        const inner = masked.slice(base + 1, close === -1 ? masked.length : close)
        for (const [a, b] of splitTopLevel(inner)) {
          const def = inner.slice(a, b).trim()
          if (!def || COLUMN_KEYWORD.test(def)) continue
          const col = readIdent(def, 0)
          if (!col) continue
          const start =
            base + 1 + a + (inner.slice(a, b).length - inner.slice(a, b).trimStart().length)
          const t = columnTrigger(
            q.name,
            col.name,
            def.slice(col.end),
            raw.slice(start + col.end, start + def.length)
          )
          if (t) triggers.push(t)
        }
      }
    } else if ((sel = selectStatement(masked)) !== null && (m = SELECT_INTO_RE.exec(sel))) {
      const q = m[1] ? null : readQname(sel, m[0].length)
      if (isPublic(q)) add('table', q.name)
    } else if (
      (m =
        /^CREATE\s+(OR\s+REPLACE\s+)?(TEMPORARY\s+|TEMP\s+)?(MATERIALIZED\s+)?(?:RECURSIVE\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?/i.exec(
          masked
        ))
    ) {
      const q = m[2] ? null : readQname(masked, m[0].length)
      if (isPublic(q)) add(m[3] || !m[1] ? 'view' : 'viewReplace', q.name)
    } else if ((m = /^DROP\s+(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+EXISTS\s+)?/i.exec(masked))) {
      const list = masked.slice(m[0].length).replace(/\b(CASCADE|RESTRICT)\b[\s\S]*$/i, '')
      for (const [a, b] of splitTopLevel(list)) {
        const q = readQname(list.slice(a, b).trim(), 0)
        if (isPublic(q)) drops.add(q.name)
      }
    } else if (
      (m =
        /^CREATE\s+(TEMPORARY\s+|TEMP\s+)?(?:UNLOGGED\s+)?SEQUENCE\s+(?:IF\s+NOT\s+EXISTS\s+)?/i.exec(
          masked
        ))
    ) {
      const q = m[1] ? null : readQname(masked, m[0].length)
      if (isPublic(q)) {
        add('sequence', q.name)
      }
    } else if ((m = /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?/i.exec(masked))) {
      const q = readQname(masked, m[0].length)
      if (!isPublic(q)) continue
      const rest = masked.slice(q.end)
      const off = q.end
      for (const [a, b] of splitTopLevel(rest)) {
        const act = rest.slice(a, b)
        let am
        let col = null
        if ((am = /^\s*ADD\s+(COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?/i.exec(act))) {
          if (!am[1] && COLUMN_KEYWORD.test(act.slice(am[0].length))) continue
          col = readIdent(act, am[0].length)
        } else if ((am = /^\s*ALTER\s+(?:COLUMN\s+)?/i.exec(act))) {
          col = readIdent(act, am[0].length)
        }
        if (!col) continue
        const tail = act.slice(col.end)
        const t = columnTrigger(q.name, col.name, tail, raw.slice(off + a + col.end, off + b))
        const isAdd = /^\s*ADD\b/i.test(act)
        const setDefault = /^\s*SET\s+DEFAULT\s+nextval/i.test(tail)
        const addIdentity = /^\s*ADD\s+GENERATED/i.test(tail)
        if (t && (isAdd || setDefault || addIdentity)) triggers.push(t)
      }
    }
  }
  const viewReplaces = relations.filter((r) => r.kind === 'viewReplace' && drops.has(r.name))
  const kept = relations
    .filter((r) => r.kind !== 'viewReplace')
    .concat(viewReplaces.map((r) => ({ ...r, kind: 'view' })))
  const uniq = []
  for (const t of triggers)
    if (!uniq.some((u) => u.seq === t.seq && u.table === t.table && u.column === t.column))
      uniq.push(t)
  return { relations: kept, triggers: uniq }
}

const TABLE_PRIVS = 'SELECT, INSERT, UPDATE, DELETE'

/** Returns [{ file, relation, decision, message, fix }]. Empty array = clean. */
export function findRelationsWithoutGrantDecisions(fileName, sql, opts = {}) {
  if (!isCheck77InScope(fileName, opts)) return []
  const file = fileName
  const acks = findCheck77Acks(sql)
  const stmts = lex(sql, true).stmts
  const { relations, triggers } = extractFromStatements(stmts)
  const effective = buildEffectiveGrants(stmts)
  const violations = forbiddenViolations(file, stmts)

  const ackFor = (kind, key) => acks.filter((a) => a.kind === kind && a.key === key)
  const decide = (kind, key, satisfiedByGrant, onMissing) => {
    if (satisfiedByGrant) return
    const mine = ackFor(kind, key)
    if (mine.some((a) => !a.problem)) return
    const bad = mine.find((a) => a.problem)
    const wrong = acks.filter((a) => a.kind === kind && a.key !== key && a.key)
    const note = bad
      ? ` (ack present but invalid: ${bad.problem})`
      : wrong.length
        ? ` (ack names a different relation: ${wrong.map((a) => a.target).join(', ')})`
        : ''
    violations.push(onMissing(note))
  }

  for (const rel of relations) {
    const name = rel.name
    const sequence = rel.kind === 'sequence'
    const decisive = DECISION_PRIVS[sequence ? 'sequence' : 'table']
    const mine = effective.filter((e) => e.name === name && decisive.includes(e.priv))
    const obj = sequence ? 'SEQUENCE' : 'TABLE'
    const svcPrivs = sequence ? 'USAGE, SELECT, UPDATE' : TABLE_PRIVS
    decide(
      'service_role',
      name,
      mine.some((e) => e.role === 'service_role'),
      (note) => ({
        file,
        relation: name,
        decision: 'service_role',
        message: `${file}: public.${display(name)} has no service_role grant decision${note}.`,
        fix: `  Add:  GRANT ${svcPrivs} ON ${obj} public.${display(name)} TO service_role;\n  or:   -- audit:check-77-ack service_role none ${display(name)}: <why no API role needs this ${obj.toLowerCase()}>`,
      })
    )
    decide(
      'clients',
      name,
      mine.some((e) => CLIENT_ROLES.includes(e.role)),
      (note) => ({
        file,
        relation: name,
        decision: 'clients',
        message: `${file}: public.${display(name)} has no anon/authenticated grant decision${note}.`,
        fix: `  Add:  GRANT SELECT ON ${obj} public.${display(name)} TO authenticated;\n  or:   -- audit:check-77-ack clients none ${display(name)}: <why no client role needs this ${obj.toLowerCase()}>`,
      })
    )
  }

  const usage = effective.filter((e) => e.kind === 'sequence' && e.priv === 'USAGE')
  for (const t of triggers) {
    // Exact name only, with serial names truncated the way Postgres truncates them
    // (pgSerialSequenceName). Any fuzzy match lets one table borrow another's grant (SMI-7151
    // review). A collision suffix (..._seq1) is not predictable; the ack marker covers it.
    const covers = (e, role) => e.role === role && e.name === t.seq
    const roles = ['service_role']
    for (const e of effective) {
      if (
        e.kind === 'table' &&
        e.name === t.table &&
        e.priv === 'INSERT' &&
        CLIENT_ROLES.includes(e.role) &&
        !roles.includes(e.role)
      ) {
        roles.push(e.role)
      }
    }
    const missing = roles.filter((r) => !usage.some((e) => covers(e, r)))
    decide('sequence', `${t.table}.${t.column}`, missing.length === 0, (note) => ({
      file,
      relation: t.seq,
      decision: 'sequence',
      message: `${file}: sequence public.${display(t.seq)} (column ${t.table}.${t.column}) has no USAGE grant for ${missing.join(', ')}${note}.`,
      fix: `  Add:  GRANT USAGE ON SEQUENCE public.${display(t.seq)} TO ${missing.join(', ')};\n  or:   -- audit:check-77-ack sequence none ${t.table}.${t.column}: <why this column's sequence needs no API grant>`,
    }))
  }
  return violations
}

// ---------------------------------------------------------------------------
// Audit wiring (I/O injected so the pass/fail/inconclusive plumbing is testable)
// ---------------------------------------------------------------------------

/**
 * Names of migration files changed in this PR, or null when git cannot say.
 * `execFile(args)` runs `git <args>` and returns stdout; arguments are an argv
 * array, so a hostile base ref is one argument, never shell syntax.
 */
export function getCheck77DiffFiles({ execFile, baseRef, migDir = 'supabase/migrations' }) {
  try {
    const ref = baseRef ? `origin/${baseRef}` : 'origin/main'
    const mergeBase = execFile(['merge-base', ref, 'HEAD']).trim()
    return execFile(['diff', '--name-only', `${mergeBase}...HEAD`, '--', `${migDir}/`])
      .split('\n')
      .filter(Boolean)
  } catch {
    return null
  }
}

/**
 * Scope classification -> pass / fail / INCONCLUSIVE for Check 77. `migrationFiles` are
 * names inside `migDir`; `readFile(name)` is never called for an encrypted file.
 */
export function runCheck77({
  migrationFiles,
  readFile,
  isEncrypted,
  diffFiles,
  pass,
  fail,
  note = () => {},
  migDir = 'supabase/migrations',
}) {
  const inScope = migrationFiles.filter(
    (f) =>
      f.endsWith('.sql') &&
      isCheck77InScope(f, { cutoffTs: CHECK77_CUTOFF_TS, exemptFiles: CHECK77_EXEMPT_FILES })
  )
  const encrypted = inScope.filter((f) => isEncrypted(f))
  const scope = classifyScanScope({ inScopeFiles: inScope, encryptedFiles: encrypted, diffFiles })
  if (scope.status === 'inconclusive') {
    fail(
      `Check 77: ${scope.reason}`,
      'Unlock git-crypt (or run this check where the key is available) and re-run'
    )
    return
  }
  if (scope.status === 'not-checked') {
    pass(`Check 77: ${scope.reason}`)
    return
  }
  let violations = 0
  for (const f of inScope.filter((x) => !encrypted.includes(x))) {
    for (const v of findRelationsWithoutGrantDecisions(`${migDir}/${f}`, readFile(f))) {
      fail(`Check 77: ${v.message}`)
      for (const line of v.fix.split('\n')) note(line.trimStart())
      violations++
    }
  }
  if (violations === 0) {
    pass(
      `Check 77: scanned ${scope.scanned} in-scope migration(s); every new public relation has explicit API grant decisions`
    )
  }
}
