/**
 * GRANT / REVOKE parsing, the effective-privilege model and the
 * forbidden-statement rules for Check 77 (SMI-7151).
 * Pure; see audit-check77.mjs for the relation rules.
 */
import { readIdent, readQname, splitTopLevel } from './audit-check77-lex.mjs'

export const CLIENT_ROLES = ['anon', 'authenticated']
const API_ROLES = [...CLIENT_ROLES, 'service_role']
const FORBIDDEN_PRIVS = ['ALL', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']

const TABLE_PRIVS = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
  'MAINTAIN',
]
const SEQUENCE_PRIVS = ['USAGE', 'SELECT', 'UPDATE']

/** Privileges that make a grant a real "decision" for a relation (REFERENCES etc. do not). */
export const DECISION_PRIVS = {
  table: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  sequence: ['USAGE', 'SELECT'],
}

// ---------------------------------------------------------------------------
// Statement parsing
// ---------------------------------------------------------------------------

/**
 * Normalize a grantee list the way Postgres reads it: strip WITH GRANT OPTION,
 * GRANTED BY and CASCADE/RESTRICT tails and a leading GROUP, then read each
 * entry as an identifier (unquoted folds to lower case, quoted keeps case, so
 * PUBLIC becomes 'public' and "anon" becomes 'anon').
 */
export function parseGrantees(text) {
  const clean = text
    .replace(/\s+WITH\s+GRANT\s+OPTION\b[\s\S]*$/i, '')
    .replace(/\s+GRANTED\s+BY\b[\s\S]*$/i, '')
    .replace(/\s+(?:CASCADE|RESTRICT)\s*$/i, '')
  return splitTopLevel(clean)
    .map(([a, b]) =>
      clean
        .slice(a, b)
        .trim()
        .replace(/^GROUP\s+/i, '')
    )
    .filter(Boolean)
    .map((g) => (readIdent(g, 0) || { name: g.toLowerCase() }).name)
}

function parseAcl(masked, re) {
  const m = re.exec(masked)
  if (!m) return null
  const privs = splitTopLevel(m[1]).map(([a, b]) =>
    m[1]
      .slice(a, b)
      .replace(/\([^)]*\)/g, '')
      .trim()
      .replace(/\s+/g, ' ')
      .toUpperCase()
      .replace(/^ALL PRIVILEGES$/, 'ALL')
  )
  const grantees = parseGrantees(m[3])
  const target = m[2].trim()
  const all = /^ALL\s+(TABLES|SEQUENCES)\s+IN\s+SCHEMA\s+([\s\S]+)$/i.exec(target)
  if (all) {
    const schemas = all[2].split(',').map((s) => (readIdent(s.trim(), 0) || { name: '' }).name)
    return {
      privs,
      grantees,
      kind: all[1].toLowerCase() === 'tables' ? 'allTables' : 'allSequences',
      schemas,
      names: [],
    }
  }
  if (
    /^(FUNCTION|PROCEDURE|ROUTINE|SCHEMA|DATABASE|DOMAIN|TYPE|LANGUAGE|FOREIGN|LARGE|PARAMETER|ALL\s)/i.test(
      target
    )
  ) {
    return { privs, grantees, kind: 'other', schemas: [], names: [] }
  }
  const kw = /^(TABLE|SEQUENCE)\s+/i.exec(target)
  const list = kw ? target.slice(kw[0].length) : target
  const names = []
  for (const [a, b] of splitTopLevel(list)) {
    const q = readQname(list.slice(a, b).trim(), 0)
    if (q) names.push(q)
  }
  return {
    privs,
    grantees,
    kind: kw && kw[1].toLowerCase() === 'sequence' ? 'sequence' : 'table',
    schemas: [],
    names,
  }
}

export const parseGrant = (masked) =>
  parseAcl(masked, /^GRANT\s+([\s\S]+?)\s+ON\s+([\s\S]+?)\s+TO\s+([\s\S]+)$/i)

/** REVOKE GRANT OPTION FOR ... only drops the right to re-grant, never the privilege: not parsed. */
export const parseRevoke = (masked) =>
  parseAcl(
    masked,
    /^REVOKE\s+(?!GRANT\s+OPTION\s+FOR\b)([\s\S]+?)\s+ON\s+([\s\S]+?)\s+FROM\s+([\s\S]+)$/i
  )

// ---------------------------------------------------------------------------
// Effective privileges: GRANT adds, a later REVOKE removes (statement order)
// ---------------------------------------------------------------------------

const expand = (privs, kind) =>
  privs.flatMap((p) => (p === 'ALL' ? (kind === 'sequence' ? SEQUENCE_PRIVS : TABLE_PRIVS) : [p]))

/**
 * Replay GRANT and REVOKE statements in file order. Returns atomic facts
 * { kind: 'table'|'sequence', name, role, priv } for public relations. ALL is
 * expanded, so a later REVOKE of one privilege leaves the others standing.
 * GRANT ... ON ALL TABLES creates no facts (it is itself a forbidden form);
 * REVOKE ... ON ALL TABLES/SEQUENCES IN SCHEMA public removes them wholesale.
 */
export function buildEffectiveGrants(stmts) {
  let eff = []
  for (const { masked } of stmts) {
    const grant = /^GRANT\b/i.test(masked)
    if (!grant && !/^REVOKE\b/i.test(masked)) continue
    const g = grant ? parseGrant(masked) : parseRevoke(masked)
    if (!g || g.kind === 'other') continue
    const sequence = g.kind === 'sequence' || g.kind === 'allSequences'
    const kind = sequence ? 'sequence' : 'table'
    const privs = expand(g.privs, kind)
    if (g.kind === 'allTables' || g.kind === 'allSequences') {
      if (grant || !g.schemas.includes('public')) continue
      eff = eff.filter(
        (e) => !(e.kind === kind && g.grantees.includes(e.role) && privs.includes(e.priv))
      )
      continue
    }
    for (const q of g.names) {
      if (!(q.schema === null || q.schema === 'public')) continue
      for (const role of g.grantees) {
        for (const priv of privs) {
          const same = (e) =>
            e.kind === kind && e.name === q.name && e.role === role && e.priv === priv
          if (grant) {
            if (!eff.some(same)) eff.push({ kind, name: q.name, role, priv })
          } else {
            eff = eff.filter((e) => !same(e))
          }
        }
      }
    }
  }
  return eff
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const isForbiddenGrantee = (r) => CLIENT_ROLES.includes(r) || r === 'public'

export function forbiddenViolations(file, stmts) {
  const out = []
  const fixText = 'list the privileges explicitly (SELECT, INSERT, UPDATE, DELETE)'
  for (const { masked } of stmts) {
    if (/^GRANT\b/i.test(masked)) {
      const g = parseGrant(masked)
      if (!g) continue
      const clientRoles = g.grantees.filter(isForbiddenGrantee)
      if (clientRoles.length === 0) continue
      const bad = g.privs.filter((p) => FORBIDDEN_PRIVS.includes(p))
      if (g.kind === 'table' && bad.length > 0) {
        const target = g.names.map((q) => q.name).join(', ')
        out.push({
          file,
          relation: target,
          decision: 'forbidden',
          message: `${file}: forbidden privilege ${bad.join(', ')} granted to ${clientRoles.join(', ')} on ${target}.`,
          fix: fixText,
        })
      } else if (
        (g.kind === 'allTables' || g.kind === 'allSequences') &&
        g.schemas.includes('public')
      ) {
        // One statement, one problem: the schema-wide form. Any forbidden privilege in it is named, not re-reported.
        const target = g.kind === 'allTables' ? 'ALL TABLES' : 'ALL SEQUENCES'
        const privNote = g.kind === 'allTables' && bad.length > 0 ? ` (with ${bad.join(', ')})` : ''
        out.push({
          file,
          relation: `${target} IN SCHEMA public`,
          decision: 'forbidden',
          message: `${file}: forbidden form GRANT ... ON ${target} IN SCHEMA public TO ${clientRoles.join(', ')}${privNote}.`,
          fix: 'grant on each relation by name, with explicit privileges',
        })
      }
    } else if (/^ALTER\s+DEFAULT\s+PRIVILEGES\b/i.test(masked)) {
      const m = /\sGRANT\s+(?!OPTION\b)([\s\S]+?)\s+TO\s+([\s\S]+)$/i.exec(masked)
      if (!m) continue
      const hit = parseGrantees(m[2]).filter((r) => API_ROLES.includes(r) || r === 'public')
      if (hit.length > 0) {
        out.push({
          file,
          relation: 'ALTER DEFAULT PRIVILEGES',
          decision: 'forbidden',
          message: `${file}: forbidden form ALTER DEFAULT PRIVILEGES ... GRANT ... TO ${hit.join(', ')}.`,
          fix: 'grant on each new relation by name in the migration that creates it',
        })
      }
    }
  }
  return out
}
