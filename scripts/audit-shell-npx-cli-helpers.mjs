/**
 * Helpers for audit-standards.mjs Check 59, shell sub-check (SMI-7223, SMI-7226).
 *
 * Flags a bare `npx supabase` / `npx wrangler` invocation in a tracked shell
 * script, workflow or composite action. With no local package, npx downloads
 * registry-latest and ignores any pinned binary on PATH, which is how
 * SMI-7223's deploy outage happened. See
 * docs/internal/implementation/smi-7223-deploy-pinned-supabase-cli.md.
 *
 * This is a line lexer, not a shell parser. It joins backslash continuations,
 * skips comments and heredoc bodies, and walks each logical line once with a
 * context stack: quotes ('…', "…", $'…'), command substitution ($(…) and
 * backticks, including inside "…"), arithmetic ($((…)), ((…)), $[…]) and
 * case…esac, so a pattern's `)` does not close a substitution. An `npx … <tool>`
 * in command context counts as an invocation whatever precedes it; inside
 * quotes it counts only as the argument of `sh -c` and its siblings. In YAML,
 * a quoted `run:` value is decoded with js-yaml and scanned as the command it
 * holds. Known blind spots, by design: npx built from a variable, eval, a tool
 * name in a variable, a quoted string passed to another interpreter (ssh,
 * docker exec), and a substitution or quote left open across lines.
 */

import { execFileSync } from 'child_process'
import { readFileSync, readdirSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'

const yaml = createRequire(import.meta.url)('js-yaml')

const TOOLS = ['supabase', 'wrangler']

// `npx` as a bare word or a quoted command word ("npx" / 'npx'), then
// optional flags, then a watched tool with no @version.
const HIT = new RegExp(
  String.raw`(?:(?<![\w.-])npx|(["'])npx\1)\s+(?:--?[A-Za-z-]+(?:=\S+)?\s+)*(${TOOLS.join('|')})(?![A-Za-z0-9@_-])`,
  'g'
)
const SH_C = /(?:^|[\s;&|(])(?:ba|z|da|k)?sh\s+(?:-\S+\s+)*-c\s*$/
// A heredoc operator at the lexer's position. Sticky, so it is tried only at
// the first `<`: in a here-string `<<<word` the third `<` stops the tag
// matching there, and the scan moves past the operator.
const HEREDOC_AT = /<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/y
// A workflow `run:` whose value starts with a YAML quote.
const YAML_RUN_QUOTED = /^(\s*(?:-\s+)?run:\s*)(['"].*)$/
const WORD_BREAK = /[\s;&|()]/

function wordAt(line, i, word) {
  return (
    line.startsWith(word, i) &&
    (i === 0 || WORD_BREAK.test(line[i - 1])) &&
    (i + word.length === line.length || WORD_BREAK.test(line[i + word.length]))
  )
}

// Preceding text that leaves the lexer in command (keyword) position.
const KEYWORD_POSITION = /(?:^|[;&|({!]|\b(?:then|do|else|elif|if|while|until|in)\b)\s*$/

/**
 * Bash reads `$((` / `((` as arithmetic only when the outer paren closes as
 * `))`; otherwise it is a substitution or subshell holding a subshell.
 * `from` is the index just past the opening `((`. Returns true for
 * arithmetic. When no close is found on the line it returns false, so the
 * text is lexed as commands and an invocation there is still seen.
 */
function arithmeticCloses(line, from) {
  let depth = 0
  for (let j = from; j < line.length; j++) {
    const c = line[j]
    if (c === '\\') j++
    else if (c === "'" || c === '"') {
      const end = line.indexOf(c, j + 1)
      if (end === -1) return false
      j = end
    } else if (c === '(') depth++
    else if (c === ')') {
      if (depth > 0) depth--
      else return line[j + 1] === ')'
    }
  }
  return false
}

/**
 * Lex one logical line. Returns { at, heredocs }: at[i] is the context in
 * force just before index i, as { q, openAt } where q is null (command
 * context), "'", '"', "$'" or 'arith', and openAt is where that context
 * opened. heredocs lists every heredoc operator in command context, in order.
 */
export function lexLine(line) {
  const stack = [{ kind: 'cmd', close: null, openAt: -1, bodyAt: 0, depth: 0, cases: 0 }]
  const at = new Array(line.length + 1)
  const heredocs = []
  const top = () => stack[stack.length - 1]
  const push = (kind, close, openAt, bodyAt = openAt + 1) =>
    stack.push({ kind, close, openAt, bodyAt, depth: 0, cases: 0 })
  const mark = (from, to) => {
    const t = top()
    const st = { q: t.kind === 'cmd' ? null : t.kind, openAt: t.openAt }
    for (let k = from; k < to && k <= line.length; k++) at[k] = st
  }
  let i = 0
  while (i < line.length) {
    const t = top()
    const c = line[i]
    const next = line[i + 1]
    mark(i, i + 1)
    if (t.kind === "'") {
      if (c === "'") stack.pop()
      i++
    } else if (t.kind === "$'") {
      if (c === '\\') {
        mark(i + 1, i + 2)
        i += 2
      } else {
        if (c === "'") stack.pop()
        i++
      }
    } else if (t.kind === '"') {
      if (c === '\\') {
        mark(i + 1, i + 2)
        i += 2
      } else if (c === '"') {
        stack.pop()
        i++
      } else if (
        c === '$' &&
        next === '(' &&
        line[i + 2] === '(' &&
        arithmeticCloses(line, i + 3)
      ) {
        push('arith', '))', i)
        i += 3
      } else if (c === '$' && next === '(') {
        push('cmd', ')', i, i + 2)
        i += 2
      } else if (c === '$' && next === '[') {
        push('arith', ']', i)
        i += 2
      } else if (c === '`') {
        push('cmd', '`', i)
        i++
      } else {
        i++
      }
    } else if (t.kind === 'arith') {
      if (c === '$' && next === '(' && line[i + 2] !== '(') {
        push('cmd', ')', i, i + 2)
        i += 2
      } else if (c === '(') {
        t.depth++
        i++
      } else if (t.close === '))' && c === ')' && t.depth === 0 && next === ')') {
        mark(i + 1, i + 2)
        stack.pop()
        i += 2
      } else if (c === ')' && t.depth > 0) {
        t.depth--
        i++
      } else if (t.close === ']' && c === ']') {
        stack.pop()
        i++
      } else {
        i++
      }
    } else {
      // command context
      if (c === '\\') {
        mark(i + 1, i + 2)
        i += 2
      } else if (c === "'") {
        push("'", "'", i)
        i++
      } else if (c === '$' && next === "'") {
        push("$'", "'", i + 1)
        i += 2
      } else if (c === '"') {
        push('"', '"', i)
        i++
      } else if (
        c === '$' &&
        next === '(' &&
        line[i + 2] === '(' &&
        arithmeticCloses(line, i + 3)
      ) {
        push('arith', '))', i)
        i += 3
      } else if (c === '$' && next === '(') {
        push('cmd', ')', i, i + 2)
        i += 2
      } else if (c === '$' && next === '[') {
        push('arith', ']', i)
        i += 2
      } else if (
        c === '(' &&
        next === '(' &&
        (i === 0 || WORD_BREAK.test(line[i - 1])) &&
        arithmeticCloses(line, i + 2)
      ) {
        push('arith', '))', i)
        i += 2
      } else if (c === '`') {
        if (t.close === '`') stack.pop()
        else push('cmd', '`', i)
        i++
      } else if (c === '(') {
        t.depth++
        i++
      } else if (c === ')') {
        if (t.depth > 0) t.depth--
        else if (t.cases > 0) {
          // a case pattern's closing paren
        } else if (t.close === ')') stack.pop()
        i++
      } else if (c === '<' && next === '<') {
        HEREDOC_AT.lastIndex = i
        const m = HEREDOC_AT.exec(line)
        if (m) {
          heredocs.push({ dash: m[1] === '-', tag: m[3] })
          mark(i, i + m[0].length)
          i += m[0].length
        } else {
          i += 2
        }
      } else if (wordAt(line, i, 'case') && KEYWORD_POSITION.test(line.slice(t.bodyAt, i))) {
        t.cases++
        mark(i, i + 4)
        i += 4
      } else if (wordAt(line, i, 'esac') && KEYWORD_POSITION.test(line.slice(t.bodyAt, i))) {
        if (t.cases > 0) t.cases--
        mark(i, i + 4)
        i += 4
      } else {
        i++
      }
    }
  }
  mark(line.length, line.length + 1)
  return { at, heredocs }
}

/** Context just before `idx`: { q, openAt }. q is null in command context. */
export function quoteStateAt(line, idx) {
  return lexLine(line).at[idx] ?? { q: null, openAt: -1 }
}

function trailingCommentIndex(line, at) {
  const re = /(?:^|\s)#/g
  let m
  while ((m = re.exec(line)) !== null) {
    const pos = m.index + m[0].length - 1
    if (at[pos].q === null) return pos
  }
  return -1
}

/**
 * Decode a quoted YAML `run:` value starting at raw[i], joining following
 * lines until js-yaml accepts it (a quoted scalar may span lines). Returns
 * { command, consumed } or null when it never parses to a string.
 */
function decodeYamlRun(raw, i) {
  const m = raw[i].match(YAML_RUN_QUOTED)
  if (!m) return null
  let text = m[2]
  for (let n = 1; n <= 50 && i + n <= raw.length; n++) {
    try {
      const v = yaml.load(text)
      if (typeof v === 'string') return { command: v, consumed: n }
      return null
    } catch {
      if (i + n >= raw.length) return null
      text += '\n' + raw[i + n]
    }
  }
  return null
}

/**
 * Scan shell (or workflow YAML) text. Returns [{ line, tool, text }].
 * Pass { yaml: true } for a workflow or action file, so a quoted `run:`
 * value is read as the command it holds.
 */
export function scanShellText(text, { yaml: isYaml = false } = {}) {
  const raw = text.split('\n')
  const hits = []
  const heredocs = []
  let i = 0
  while (i < raw.length) {
    const startLine = i + 1
    let line = raw[i]
    if (heredocs.length > 0) {
      const h = heredocs[0]
      const body = h.dash ? line.replace(/^\t+/, '') : line
      if (body.trim() === h.tag) heredocs.shift()
      i++
      continue
    }
    if (isYaml) {
      const decoded = decodeYamlRun(raw, i)
      if (decoded) {
        for (const h of scanShellText(decoded.command)) {
          hits.push({ line: startLine, tool: h.tool, text: raw[i].trim() })
        }
        i += decoded.consumed
        continue
      }
    }
    while (/\\$/.test(line) && i + 1 < raw.length) {
      i++
      line = line.slice(0, -1) + ' ' + raw[i].trimStart()
    }
    i++
    if (/^\s*#/.test(line)) continue
    const { at, heredocs: found } = lexLine(line)
    const cut = trailingCommentIndex(line, at)
    const code = cut === -1 ? line : line.slice(0, cut)
    for (const m of code.matchAll(HIT)) {
      const { q, openAt } = at[m.index]
      if (q === null || (q !== 'arith' && SH_C.test(code.slice(0, openAt)))) {
        hits.push({ line: startLine, tool: m[2], text: line.trim() })
        break
      }
    }
    heredocs.push(...(cut === -1 ? found : lexLine(code).heredocs))
  }
  return hits
}

function walkFiles(repoRoot) {
  const files = []
  const visit = (rel, accept) => {
    let entries
    try {
      entries = readdirSync(join(repoRoot, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && e.name !== '.git') visit(child, accept)
      } else if (accept(child)) {
        files.push(child)
      }
    }
  }
  visit('scripts', (f) => f.endsWith('.sh'))
  visit('.github/workflows', (f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f))
  visit('.github/actions', (f) => /^\.github\/actions\/.+\/action\.ya?ml$/.test(f))
  return files.sort()
}

/**
 * Scan every tracked scripts/**\/*.sh, .github/workflows/*.y*ml and
 * .github/actions/**\/action.y*ml file under repoRoot. Uses `git ls-files`;
 * when git can't answer (a worktree container, where the gitdir points at a
 * host path) it walks the filesystem instead and says so in `via`.
 * Returns { findings: [{ file, line, tool, text }], scanned, via }.
 * Pass `env` to control the spawned git's environment (tests use makeFixtureEnv).
 */
export function findBareNpxCliInShellAndWorkflows(repoRoot, { env } = {}) {
  let files
  let via = 'git'
  try {
    const out = execFileSync(
      'git',
      [
        '-C',
        repoRoot,
        'ls-files',
        'scripts/*.sh',
        '.github/workflows/*.yml',
        '.github/workflows/*.yaml',
        '.github/actions/*/action.yml',
        '.github/actions/*/action.yaml',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...(env ? { env } : {}) }
    )
    files = [...new Set(out.split('\n').filter(Boolean))]
  } catch {
    files = walkFiles(repoRoot)
    via = 'filesystem'
  }
  const findings = []
  for (const file of files) {
    let text
    try {
      text = readFileSync(join(repoRoot, file), 'utf8')
    } catch {
      continue
    }
    const isYaml = /\.ya?ml$/.test(file)
    for (const h of scanShellText(text, { yaml: isYaml })) findings.push({ file, ...h })
  }
  return { findings, scanned: files.length, via }
}
