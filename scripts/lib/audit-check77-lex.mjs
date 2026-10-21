/**
 * SQL lexing helpers for Check 77 (SMI-7151): comment stripping, statement
 * splitting and identifier parsing. Pure; see audit-check77.mjs for the rules.
 */

const IDENT_RE = /"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*/y

// ---------------------------------------------------------------------------
// Lexing: strip comments, split statements, keep a same-length "masked" copy
// (string and dollar-body contents blanked) so structural regexes never match
// inside literals while indices still line up with the raw text.
// ---------------------------------------------------------------------------

export function lex(sql, split) {
  let raw = ''
  let masked = ''
  const stmts = []
  const n = sql.length
  let i = 0
  const push = (r, m) => {
    raw += r
    masked += m
  }
  const flush = () => {
    if (raw.trim()) {
      const lead = raw.length - raw.trimStart().length
      stmts.push({ raw: raw.trim(), masked: masked.slice(lead, lead + raw.trim().length) })
    }
    raw = ''
    masked = ''
  }
  while (i < n) {
    const c = sql[i]
    const d = sql[i + 1]
    if (c === '-' && d === '-') {
      while (i < n && sql[i] !== '\n') i++
      continue
    }
    if (c === '/' && d === '*') {
      let depth = 1
      i += 2
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') (depth++, (i += 2))
        else if (sql[i] === '*' && sql[i + 1] === '/') (depth--, (i += 2))
        else i++
      }
      push(' ', ' ')
      continue
    }
    if (c === "'") {
      const escapes = /[eE]$/.test(raw) && !/[A-Za-z0-9_$][eE]$/.test(raw)
      let j = i + 1
      while (j < n) {
        if (escapes && sql[j] === '\\') j += 2
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2
        else if (sql[j] === "'") break
        else j++
      }
      const end = Math.min(j, n - 1)
      const body = sql.slice(i + 1, end)
      push(
        sql.slice(i, end + 1),
        "'" + 'x'.repeat(body.length) + (end < n && sql[end] === "'" ? "'" : '')
      )
      i = end + 1
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < n) {
        if (sql[j] === '"' && sql[j + 1] === '"') j += 2
        else if (sql[j] === '"') break
        else j++
      }
      const chunk = sql.slice(i, Math.min(j + 1, n))
      push(chunk, chunk)
      i += chunk.length
      continue
    }
    if (c === '$' && !/[A-Za-z0-9_$]$/.test(raw)) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 80))
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length)
        const end = close === -1 ? n : close + tag[0].length
        const chunk = sql.slice(i, end)
        const inner = Math.max(0, chunk.length - 2 * tag[0].length)
        push(chunk, tag[0] + 'x'.repeat(inner) + (close === -1 ? '' : tag[0]))
        i = end
        continue
      }
    }
    if (c === ';' && split) {
      flush()
      i++
      continue
    }
    push(c, c)
    i++
  }
  if (split) flush()
  return { text: raw, stmts }
}

/** Remove `--` and nested block comments; leave string/dollar bodies intact. */
export function stripSqlComments(sql) {
  return lex(sql, false).text
}

/** Split on `;` outside quotes and dollar-quoted bodies. Comments are stripped. */
export function splitSqlStatements(sql) {
  return lex(sql, true).stmts.map((s) => s.raw)
}

// ---------------------------------------------------------------------------
// Identifier helpers
// ---------------------------------------------------------------------------

export const normIdent = (tok) =>
  tok.startsWith('"') ? tok.slice(1, -1).replace(/""/g, '"') : tok.toLowerCase()

export function readIdent(text, pos) {
  IDENT_RE.lastIndex = pos
  const m = IDENT_RE.exec(text)
  return m ? { name: normIdent(m[0]), end: IDENT_RE.lastIndex } : null
}

/** Read `[schema.]name` at pos. Returns { schema|null, name, end } or null. */
export function readQname(text, pos) {
  const a = readIdent(text, pos)
  if (!a) return null
  const dot = /^\s*\.\s*/.exec(text.slice(a.end))
  if (!dot) return { schema: null, name: a.name, end: a.end }
  const b = readIdent(text, a.end + dot[0].length)
  return b
    ? { schema: a.name, name: b.name, end: b.end }
    : { schema: null, name: a.name, end: a.end }
}

export const isPublic = (q) => q && (q.schema === null || q.schema === 'public')

export const display = (name) =>
  /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`

export function splitTopLevel(text) {
  const parts = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      i++
      while (i < text.length && !(text[i] === '"' && text[i + 1] !== '"'))
        i += text[i] === '"' ? 2 : 1
    } else if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === ',' && depth === 0) {
      parts.push([start, i])
      start = i + 1
    }
  }
  parts.push([start, text.length])
  return parts
}

export function matchingParen(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '"') {
      i++
      while (i < text.length && !(text[i] === '"' && text[i + 1] !== '"'))
        i += text[i] === '"' ? 2 : 1
    } else if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) return i
  }
  return -1
}
