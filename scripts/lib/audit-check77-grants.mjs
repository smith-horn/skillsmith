/**
 * GRANT parsing and the forbidden-statement rules for Check 77 (SMI-7151).
 * Pure; see audit-check77.mjs for the relation rules.
 */
import { readIdent, readQname, splitTopLevel } from './audit-check77-lex.mjs'

export const CLIENT_ROLES = ['anon', 'authenticated']
const API_ROLES = [...CLIENT_ROLES, 'service_role']
const FORBIDDEN_PRIVS = ['ALL', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']

// ---------------------------------------------------------------------------
// Statement parsing
// ---------------------------------------------------------------------------

export function parseGrant(masked) {
  const m = /^GRANT\s+([\s\S]+?)\s+ON\s+([\s\S]+?)\s+TO\s+([\s\S]+)$/i.exec(masked)
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
  const grantees = m[3]
    .replace(/\s+WITH\s+GRANT\s+OPTION\b[\s\S]*$/i, '')
    .replace(/\s+GRANTED\s+BY\b[\s\S]*$/i, '')
    .split(',')
    .map((g) => g.trim().replace(/^GROUP\s+/i, ''))
    .filter(Boolean)
    .map((g) => (readIdent(g, 0) || { name: g.toLowerCase() }).name)
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

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export function forbiddenViolations(file, stmts) {
  const out = []
  const fixText = 'list the privileges explicitly (SELECT, INSERT, UPDATE, DELETE)'
  for (const { masked } of stmts) {
    if (/^GRANT\b/i.test(masked)) {
      const g = parseGrant(masked)
      if (!g) continue
      const clientRoles = g.grantees.filter((r) => CLIENT_ROLES.includes(r) || r === 'public')
      if (clientRoles.length === 0) continue
      if (g.kind === 'table' || g.kind === 'allTables') {
        const bad = g.privs.filter((p) => FORBIDDEN_PRIVS.includes(p))
        if (bad.length > 0 && (g.kind === 'table' || g.schemas.includes('public'))) {
          const target =
            g.kind === 'table'
              ? g.names.map((q) => q.name).join(', ')
              : 'ALL TABLES IN SCHEMA public'
          out.push({
            file,
            relation: target,
            decision: 'forbidden',
            message: `${file}: forbidden privilege ${bad.join(', ')} granted to ${clientRoles.join(', ')} on ${target}.`,
            fix: fixText,
          })
        }
      }
      if ((g.kind === 'allTables' || g.kind === 'allSequences') && g.schemas.includes('public')) {
        const target = g.kind === 'allTables' ? 'ALL TABLES' : 'ALL SEQUENCES'
        out.push({
          file,
          relation: `${target} IN SCHEMA public`,
          decision: 'forbidden',
          message: `${file}: forbidden form GRANT ... ON ${target} IN SCHEMA public TO ${clientRoles.join(', ')}.`,
          fix: 'grant on each relation by name, with explicit privileges',
        })
      }
    } else if (/^ALTER\s+DEFAULT\s+PRIVILEGES\b/i.test(masked)) {
      const m = /\sGRANT\s+(?!OPTION\b)([\s\S]+?)\s+TO\s+([\s\S]+)$/i.exec(masked)
      if (!m) continue
      const roles = m[2].split(',').map((r) =>
        r
          .trim()
          .replace(/\s+WITH\s+GRANT\s+OPTION$/i, '')
          .toLowerCase()
      )
      const hit = roles.filter((r) => API_ROLES.includes(r))
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
